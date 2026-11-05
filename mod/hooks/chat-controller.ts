// mod/hooks/chat-controller.ts
// CHAT-4W：聊天控制器。把 CHAT3-CLIENT（chat-client.ts）、名冊與換鑰同步（chat-sync.ts）、私訊連結接成「一個會自己輪詢的聊天」，
// 結果只有一個出口：env.publish(view)（接線層把它放進記憶體 atom with-friends/chat）。純邏輯，沒有 $：中繼、保管庫、時鐘都從 env 注入。
// 設計見 docs/drafts/chat4-iso-design.md §2、chat3-client-design §8。
//
// 解出來的訊息（text、senderName）只放 view 裡；這個檔案不 import 引擎、不碰保存以外的任何出口（chat-iso-static 以 'controller' 規則掃它）：
// 保管庫內容只有金鑰與密文快照（不是聊天文字）；其他東西一律不往外送。
import { CHAT_REPLAY_WINDOW_MS, ChatClient } from './chat-client.ts'
import type { ChatTransport, PollSummary, ReceivedMessage } from './chat-client.ts'
import { fromB64, plain, validToken, wipe } from './chat-codec.ts'
import { createMemoryChatUniquenessStore } from './chat-envelope.ts'
import { CHAT_CLIENT_MAX_TEXT_BYTES, SendChains, SeqTracker } from './chat-frame.ts'
import { GroupKeyring, sealEpochKeyForMembers } from './chat-keys.ts'
import { createPersistentReplayStore } from './chat-replay.ts'
import type { PersistentReplayStore } from './chat-replay.ts'
import { MAX_USED_INVITES, MEMBER_LIST_REISSUE_MS, MemberBook, makeJoinProof, mintInvite, openInviteRoot, parseJoinProof, publicKeyOf, sealInviteRoot, signMemberList, verifyJoinProof } from './chat-members.ts'
import type { MemberEntry } from './chat-members.ts'
import { reissueDeviceList } from './chat-provision.ts'
import { Roster } from './chat-roster.ts'
import { encodePacket, EpochOutbox, fetchEpochKeys, publishRoster, refreshRosters, rotateAndSeal } from './chat-sync.ts'
import type { EpochPacketOut } from './chat-sync.ts'
import type { SyncResult, SyncTransport } from './chat-sync.ts'
import { parseVault } from './chat-vault.ts'
import type { ChatVaultV1 } from './chat-vault.ts'
import { cleared, GROUP_KEY, mergeMessages, openKey, recount, withState } from './chat-view.ts'
import type { ChatAvailability, ChatMode, ChatNotice, ChatViewState, DmLinkState, DmRow } from './chat-view.ts'
import type { ChatViewMessage } from './chat-types.ts'
import { nobleEd25519Sign } from './noble-crypto.js'

/** 名冊與換鑰封包多久同步一次 */
export const SYNC_MS = 60_000
/** 私訊連結清單多久問一次 */
export const DM_LIST_MS = 30_000
/** 中繼的時間和本機差超過這麼多就提醒校正時鐘 */
export const CLOCK_WARN_MS = 10 * 60_000

/** 接線層告訴控制器的「聊天現在能不能碰中繼」：open 以外都不碰中繼，畫面顯示對應的固定文字 */
export type ChatGate = 'open' | 'checking' | 'relay-unsupported' | 'relay-bad' | 'other-session'

const isFail = (value: unknown): boolean => typeof value === 'object' && value !== null && Object.hasOwn(value, 'ok') && (value as { ok: unknown }).ok === false

export type MemberInfo =Readonly<{ id: string; name: string; isOwner: boolean }>
export type DmLinkWire = Readonly<{ peer: string; state: string; code?: string }>
export type DmOp = 'request' | 'accept' | 'decline' | 'block' | 'unblock'
export type DmTransport = Readonly<{
  list(): Promise<SyncResult<{ links: readonly DmLinkWire[] }>>
  op(kind: DmOp, peerId: string): Promise<SyncResult<{ code?: string }>>
}>

export type ChatEnv = Readonly<{
  groupId: string
  memberId: string
  now(): number
  random?: (length: number) => Uint8Array
  transport: ChatTransport
  sync: SyncTransport
  dm: DmTransport
  /** 把這台裝置的簽章公鑰登記到中繼的聊天裝置名單（沒有登記，中繼不收這台的信封）；已登記過再登一次也回成功 */
  registerDevice(deviceId: string, publicKey: string): Promise<SyncResult<{}>>
  /**
   * 現在能不能寫保管庫（接線層：這個對話持有租約、而且沒過期）。多個對話共用同一份保管庫，沒有租約的對話手上是舊副本，寫回去會蓋掉負責聊天那個對話的狀態：
   * 所以不論閘門是什麼狀態，只要 canWrite() 是 false，這裡一個字都不寫（包括結束對話時最後那一次）
   */
  canWrite(): boolean
  /** 取回保管庫（沒有就回 null/undefined）；存回去。保存位置是接線層的事 */
  loadVault(): Promise<unknown>
  saveVault(vault: ChatVaultV1): Promise<void>
  /** 目前的群組成員（含自己；名字已清理） */
  members(): readonly MemberInfo[]
  /** 唯一出口：整份畫面狀態 */
  publish(view: ChatViewState): void
}>

export type TickOptions = Readonly<{ /** 馬上同步名冊與金鑰（不等 SYNC_MS） */ full?: boolean }>
export type TickResult = Readonly<{ /** 這一輪新收到的別人的訊息（不含靜音）幾則；接線層拿來決定要不要跳固定句子的提醒 */ incoming: number }>
export type SendOutcome = 'sent' | 'queued' | 'failed' | 'ignored'

type Session = {
  vault: ChatVaultV1
  client: ChatClient
  roster: Roster
  /** CHAT-6: who is in the group, as the owner signed it. The relay's member list and its isOwner flag never decide trust. */
  book: MemberBook
  identityKey: string
  identitySeed: string
  /** my own signed device list (re-signed with a higher version when it is about to expire) */
  ownList: ChatVaultV1['ownList']
  /** owner only: invitation root secret R, used invitation numbers, removed members, the member-list version the relay has */
  owner: ChatVaultV1['owner']
  /** joiner only: the invitation's n and s until the owner's list contains me */
  join: ChatVaultV1['join']
  /** member: R opened from the owner's list ('' = not yet); owner: unused */
  inviteRoot: string
  /** the owner changed R or the epoch: the next list must seal R again */
  rootDirty: boolean
  keyring: GroupKeyring
  outbox: EpochOutbox
  chains: SendChains
  tracker: SeqTracker
  replay: PersistentReplayStore
  encPrivate: Uint8Array
  signSeed: Uint8Array
  muted: Set<string>
  known: Set<string>
  /** 群主：每位成員已經封過哪一個 epoch 的金鑰（記憶體；重啟後補封一次，put 是冪等的） */
  sealedEpoch: Map<string, string>
  listPublished: number
  registered: boolean
  /** 換了 epoch 但保管庫還沒寫進去：寫進去之前，換鑰封包不准送出（先存再送） */
  unsaved: boolean
  lastSyncAt: number
  lastDmListAt: number
  refreshed: boolean
  lastStored: string
  /** 連結清單（來自中繼）；code → 對方 */
  links: readonly DmLinkWire[]
}

const OFFLINE: ChatTransport = Object.freeze({
  publish: async () => ({ ok: false as const, kind: 'retry' as const }),
  dmSend: async () => ({ ok: false as const, kind: 'retry' as const }),
  poll: async () => ({ ok: false as const }),
  dmPoll: async () => ({ ok: false as const }),
})

const DM_CODE_RE = /^[A-Za-z0-9_-]{22}$/
const PEER_RE = /^[A-Za-z0-9_-]{1,64}$/
/** 中繼回的私訊連結只收長得像它會產生的：信箱代碼 22 個字、成員代號 1～64 個字（__proto__ 這類字當不了信箱代碼） */
const validLinks = (links: readonly DmLinkWire[]): readonly DmLinkWire[] =>
  links.filter(link => PEER_RE.test(link.peer) && link.peer !== '__proto__' && (link.code === undefined || DM_CODE_RE.test(link.code)) && LINK_STATES.has(link.state))
    .map(link => (link.state === 'active' && link.code === undefined ? { peer: link.peer, state: 'requested' } : link))
const byteLength = (text: string): number => new TextEncoder().encode(text).length
const LINK_STATES: ReadonlySet<string> = new Set(['active', 'requested', 'incoming', 'blocked'])
// 儲存摘要時不算 clock：它每次呼叫都會動，說不出新東西（chat-client.ts 同樣處理）
const stable = (value: unknown): string => JSON.stringify(value, (key, item) => (key === 'clock' ? undefined : item))

export class ChatController {
  readonly #env: ChatEnv
  #view: ChatViewState = cleared('checking')
  #gate: ChatGate = 'checking'
  #session: Session | null = null
  #queue: Promise<unknown> = Promise.resolve()
  #tabOpen = false
  #secretPending = ''
  #persistFailing = false
  #disposed = false
  #lastPublished = ''
  #echoSeq = 0
  /** 排隊中、本機先畫出來的自己的訊息（id）：中繼之後明確拒絕就撤回 */
  readonly #queuedEchoes = new Set<string>()
  #guarded: ChatTransport

  private constructor(env: ChatEnv) {
    this.#env = env
    const flushed = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => ((await this.#flush()) ? run() : fallback)
    // 先存再送（chat-client.ts 的契約）：任何信封離開之前，目前的金鑰、鏈、待送信封一定已經寫進保管庫；寫不進去就當重送，信封留在記憶體
    this.#guarded = Object.freeze({
      publish: (envelope, options) => flushed(() => env.transport.publish(envelope, options), { ok: false as const, kind: 'retry' as const }),
      dmSend: (code, envelope, options) => flushed(() => env.transport.dmSend(code, envelope, options), { ok: false as const, kind: 'retry' as const }),
      poll: after => env.transport.poll(after),
      dmPoll: boxes => env.transport.dmPoll(boxes),
    })
  }

  static create(env: ChatEnv): ChatController | null {
    if (!env || typeof env.now !== 'function' || typeof env.publish !== 'function' || typeof env.loadVault !== 'function' || typeof env.saveVault !== 'function' || typeof env.canWrite !== 'function') return null
    return new ChatController(env)
  }

  get view(): ChatViewState { return this.#view }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task)
    this.#queue = run.then(() => undefined, () => undefined)
    return run
  }

  // ---- 狀態輸出 -----------------------------------------------------------------------------------------------------------------

  #availability(): ChatAvailability {
    if (this.#gate !== 'open') return this.#gate
    const s = this.#session
    if (!s) return 'setup-needed'
    const others = this.#env.members().filter(member => member.id !== this.#env.memberId)
    if (s.refreshed && others.length > 0 && !others.some(member => s.roster.status(member.id) === 'fresh')) return 'peers-old'
    return 'ready'
  }

  #emit(next?: ChatViewState): void {
    if (this.#disposed) return
    let view = recount(next ?? this.#view, this.#tabOpen && this.#availability() === 'ready')
    // fromEntries：成員代號是中繼給的，連「__proto__」這種字也只會變成普通的鍵
    const names = Object.fromEntries(this.#env.members().slice(0, 64).map(member => [member.id, member.name]))
    view = Object.freeze({ ...view, availability: this.#availability(), names: Object.freeze(names) })
    this.#view = view
    // 沒變就不再發：atom 每更新一次，所有讀它的畫面（朋友列表的聊天按鈕）都會重畫
    const digest = JSON.stringify(view)
    if (digest === this.#lastPublished) return
    this.#lastPublished = digest
    this.#env.publish(view)
  }

  #name(id: string): string {
    return this.#env.members().find(member => member.id === id)?.name ?? ''
  }

  #toView(message: ReceivedMessage): ChatViewMessage {
    return Object.freeze({
      id: message.messageId, senderId: message.senderId, senderName: this.#name(message.senderId),
      isMe: message.senderId === this.#env.memberId, sentAt: message.sentAt, receivedAt: this.#env.now(), text: message.text,
    })
  }

  // ---- 開始與結束 ---------------------------------------------------------------------------------------------------------------

  /** 取回保管庫、組出用戶端。沒有（或壞掉、不是這個群組這個成員的）＝停在 setup-needed，不碰中繼 */
  start(): Promise<void> {
    return this.#serial(async () => {
      if (this.#disposed) return
      let raw: unknown = null
      try { raw = await this.#env.loadVault() } catch { raw = null }
      const vault = parseVault(raw, { groupId: this.#env.groupId, memberId: this.#env.memberId })
      this.#session = vault ? this.#assemble(vault) : null
      this.#emit()
    })
  }

  #assemble(vault: ChatVaultV1): Session | null {
    const env = this.#env
    const signSeed = fromB64(vault.device.signSeed, 32)
    const encPrivate = fromB64(vault.device.encSeed, 32)
    if (!signSeed || !encPrivate) return null
    const roster = Roster.create({ now: env.now }, vault.roster)
    const identityKey = publicKeyOf(vault.identitySeed)
    const book = identityKey ? MemberBook.create({ groupId: env.groupId, self: { memberId: env.memberId, identityKey }, now: env.now }, vault.book) : null
    const keyring = GroupKeyring.create({ groupId: env.groupId, random: env.random }, vault.keyring ?? undefined)
    const chains = SendChains.create(vault.chains ?? undefined)
    const tracker = SeqTracker.create(vault.tracker ?? undefined)
    const replay = createPersistentReplayStore({ windowMs: CHAT_REPLAY_WINDOW_MS, now: env.now, save: () => { /* 寫入由 #flush 在送出前與輪詢後統一做 */ }, ...(vault.replay ? { snapshot: vault.replay } : {}) })
    if (!roster || !book || !keyring || !chains || !tracker || !replay) { wipe(signSeed, encPrivate); return null }
    const sign = (message: Uint8Array): Uint8Array => nobleEd25519Sign(message, signSeed)
    const client = ChatClient.create({
      groupId: env.groupId, me: { userId: env.memberId, deviceId: vault.device.deviceId, encPrivate, sign }, roster, keyring, sendChains: chains, tracker, replay,
      sent: createMemoryChatUniquenessStore(), now: env.now, persistPending: () => { /* 同上：#guarded 會在送出前寫入 */ }, random: env.random,
    }, vault.client ?? undefined)
    const outbox = EpochOutbox.create({ persist: () => { /* 同上 */ }, keyring }, vault.outbox ?? undefined)
    if (!client || !outbox) { wipe(signSeed, encPrivate); return null }
    return {
      vault, client, roster, book, identityKey, identitySeed: vault.identitySeed, ownList: vault.ownList, owner: vault.owner, join: vault.join, inviteRoot: vault.inviteRoot, rootDirty: false, keyring, outbox, chains, tracker, replay, encPrivate, signSeed, muted: new Set(vault.muted), known: new Set(vault.knownMembers), sealedEpoch: new Map(),
      listPublished: vault.listPublished, registered: false, unsaved: false, lastSyncAt: -Infinity, lastDmListAt: -Infinity, refreshed: false, lastStored: stable(vault), links: [],
    }
  }

  /** 重新讀保管庫、組出新的用戶端（拿到租約的時候：之前別的對話可能已經改過保管庫，這個對話記憶體裡的是舊的） */
  reload(): Promise<void> {
    return this.#serial(async () => {
      if (this.#disposed) return
      const old = this.#session
      let raw: unknown = null
      try { raw = await this.#env.loadVault() } catch { raw = null }
      const vault = parseVault(raw, { groupId: this.#env.groupId, memberId: this.#env.memberId })
      this.#session = vault ? this.#assemble(vault) : null
      if (old) { old.keyring.wipe(); wipe(old.encPrivate, old.signSeed) }
      this.#emit()
    })
  }

  /** 離開群組、被踢、對話結束：金鑰清零、畫面清空 */
  dispose(availability: ChatAvailability = 'not-in-group'): Promise<void> {
    return this.#serial(async () => {
      const s = this.#session
      this.#session = null
      if (s) {
        // 到期清除（舊鑰最多再留 1 小時）是在呼叫裡做的：收掉之前最後做一次；保管庫保留給下一次（金鑰環與鏈只在記憶體清掉，檔案不刪）
        try { await s.client.maintain(OFFLINE) } catch { /* 清不掉也要收掉 */ }
        try { await this.#flush(s) } catch { /* 存不進去也要收掉 */ }
        s.keyring.wipe()
        wipe(s.encPrivate, s.signSeed)
      }
      this.#secretPending = ''
      this.#view = cleared(availability)
      this.#env.publish(this.#view)
      this.#disposed = true
    })
  }

  /** 閘門（中繼的 capability、群組、另一個對話正在負責…）：不是 'open' 時不碰中繼，只做到期清除 */
  setGate(gate: ChatGate): void {
    if (this.#gate === gate) return
    this.#gate = gate
    this.#emit()
  }

  setTabOpen(isOpen: boolean): void {
    if (this.#tabOpen === isOpen) return
    this.#tabOpen = isOpen
    this.#emit()
  }

  togglePreviewMore(): void {
    this.#emit({ ...this.#view, previewMore: !this.#view.previewMore })
  }

  select(mode: ChatMode, code = ''): void {
    const dms = this.#session ? this.#rows(this.#session) : this.#view.dms
    const row = code ? dms.find(item => item.code === code && item.state === 'active') : undefined
    const next: ChatMode = mode === 'dm-thread' && !row ? 'dm-list' : mode
    this.#secretPending = ''
    this.#emit({ ...this.#view, dms, mode: next, threadCode: next === 'dm-thread' ? code : '', state: null, over: 0 })
  }

  // ---- 保管庫 -------------------------------------------------------------------------------------------------------------------

  #build(s: Session): ChatVaultV1 {
    return Object.freeze({
      ...s.vault,
      listPublished: s.listPublished,
      ownList: s.ownList,
      roster: s.roster.snapshot(),
      book: s.book.snapshot(),
      owner: s.owner,
      join: s.join,
      inviteRoot: s.inviteRoot,
      keyring: s.keyring.snapshot(),
      outbox: s.outbox.snapshot(),
      client: s.client.snapshot(),
      chains: s.chains.snapshot(),
      tracker: s.tracker.snapshot(),
      replay: s.replay.snapshot(),
      muted: Object.freeze([...s.muted]),
      knownMembers: Object.freeze([...s.known]),
    })
  }

  /** 狀態有變就整份寫進保管庫。回 true＝已寫入（或沒變）；false＝寫不進去（呼叫端不能把信封送出去） */
  async #flush(session?: Session): Promise<boolean> {
    const s = session ?? this.#session
    if (!s) return false
    // 沒有租約：這個對話的保管庫副本可能是舊的，寫回去會蓋掉對方的狀態（金鑰環、送出序號、待送信封…）
    if (!this.#env.canWrite()) return false
    try {
      const vault = this.#build(s)
      const digest = stable(vault)
      if (digest !== s.lastStored) {
        await this.#env.saveVault(vault)
        s.lastStored = digest
      }
      this.#persistFailing = false
      return true
    } catch {
      this.#persistFailing = true
      return false
    }
  }

  // ---- 輪詢 ---------------------------------------------------------------------------------------------------------------------

  tick(options: TickOptions = {}): Promise<TickResult> {
    return this.#serial(async () => {
      const s = this.#session
      if (!s || this.#disposed) { this.#emit(); return { incoming: 0 } }
      if (this.#gate !== 'open') {
        // 聊天關著：不問中繼，但舊鑰的到期清除照做（P2：換掉超過 1 小時的讀不到，靠有人呼叫 status(now)）
        try { await s.client.maintain(OFFLINE) } catch { /* 下一輪再清 */ }
        await this.#flush(s)
        this.#emit()
        return { incoming: 0 }
      }
      const now = this.#env.now()
      let incoming = 0
      let view = this.#view
      if (options.full || now - s.lastSyncAt >= SYNC_MS) {
        view = await this.#sync(s, view)
        s.lastSyncAt = now
      }
      // 群組
      if (s.keyring.hasKey) {
        const polled = await s.client.pollGroup(this.#guarded)
        if (!('delivered' in polled)) { view = withState(view, 'unreachable') } else {
          if (polled.flushed.rejected > 0 && this.#queuedEchoes.size > 0) {
            // 排隊的那則被中繼明確拒絕了（不是還在重送）：撤回本機先畫出來的，畫面說沒送出去
            const gone = new Set(this.#queuedEchoes)
            this.#queuedEchoes.clear()
            view = withState({ ...view, messages: view.messages.filter(message => !gone.has(message.id)), dmMessages: Object.fromEntries(Object.entries(view.dmMessages).map(([code, list]) => [code, list.filter(message => !gone.has(message.id))])) }, 'sendFailed')
          } else if (polled.flushed.sent > 0) this.#queuedEchoes.clear()
          if (view.state === 'unreachable') view = withState(view, null)
          const fresh = this.#fromSummary(polled)
          incoming += fresh.filter(message => !message.isMe).length
          view = { ...view, messages: mergeMessages(view.messages, fresh) }
        }
      }
      // 私訊
      view = await this.#pollDms(s, view, now, options.full === true, (count) => { incoming += count })
      // 到期清除、該換的鑰（寫在 maintain 裡）；沒有任何私訊信箱時 pollDm 不會呼叫它，所以這裡一律再呼叫一次
      try { await s.client.maintain(this.#guarded) } catch { /* 下一輪再試 */ }
      await this.#flush(s)
      this.#emit(this.#reconcileUi(view))
      return { incoming }
    })
  }

  /** 輪詢期間使用者可能按了分頁、展開說明（那些不排隊）：以現在的畫面狀態為準；開著的私訊對話如果不見了（被封鎖…）退回清單 */
  #reconcileUi(view: ChatViewState): ChatViewState {
    const live = this.#view
    let mode = live.mode
    if (mode === 'dm-thread' && !view.dms.some(row => row.code === live.threadCode && row.state === 'active')) mode = 'dm-list'
    return { ...view, mode, threadCode: mode === 'dm-thread' ? live.threadCode : '', previewMore: live.previewMore }
  }

  #fromSummary(summary: PollSummary): ChatViewMessage[] {
    return summary.delivered.map(message => this.#toView(message))
  }

  async #sync(s: Session, view: ChatViewState): Promise<ChatViewState> {
    const env = this.#env
    const now = env.now()
    let clockWarning = false
    let next = view
    // 自己的裝置清單快過期了就用身分金鑰重簽（版本 +1），再放上中繼
    const renewed = reissueDeviceList({ ...s.vault, ownList: s.ownList }, now)
    if (renewed) s.ownList = renewed
    // 自己的裝置清單（簽好的）放上中繼
    if (s.ownList && s.ownList.listVersion > s.listPublished) {
      const put = await publishRoster(env.sync, s.ownList, env.memberId, now)
      if (put.ok) { s.listPublished = s.ownList.listVersion; if (put.driftMs !== null && Math.abs(put.driftMs) > CLOCK_WARN_MS) clockWarning = true }
    }
    // 這台裝置的簽章公鑰登記到聊天裝置名單（公鑰取自自己的清單；中繼在有清單的成員身上會再對照一次）
    if (!s.registered && s.ownList && s.listPublished >= s.ownList.listVersion) {
      const own = s.ownList.devices.find(device => device.deviceId === s.vault.device.deviceId)
      if (own && (await env.registerDevice(own.deviceId, own.signKey)).ok) s.registered = true
    }
    const members = env.members()
    const ids = members.map(member => member.id)
    // 成員名單還沒載入（對話剛開始、朋友列表還沒拿到）：不能當成「大家都離開了」去換鑰
    const loaded = ids.includes(env.memberId)
    // CHAT-6：群主是誰、誰是成員，只看群主簽的成員清單（中繼回的名單與 isOwner 都不算數）；群主就是保管庫裡有 owner 狀態的那台
    const isOwner = s.owner !== null
    const plan = isOwner && loaded ? await this.#ownerPlan(s, ids) : null
    if (!isOwner) await this.#memberBook(s)
    // 其他人的裝置清單（簽章、版本、年齡都在 Roster 裡驗，中繼說了不算）；上面已經把名單上的人釘好
    const refreshed = await refreshRosters(env.sync, s.roster, now)
    if (refreshed.ok) { s.refreshed = true; if (refreshed.clockWarning) clockWarning = true }
    if (isOwner && plan) {
      const listedIds = plan.members.map(member => member.memberId)
      // 群主：成員變動（或第一把金鑰）→ 換 epoch、封給每位留下成員的每台裝置，放進發信匣再送
      const added = listedIds.filter(id => !s.known.has(id))
      const removed = [...s.known].filter(id => !listedIds.includes(id))
      if (!s.keyring.hasKey || added.length > 0 || removed.length > 0) {
        const others = listedIds.filter(id => id !== env.memberId)
        const change = removed.length > 0 && added.length === 0 ? { type: 'leave' as const, userId: removed[0]! } : { type: 'join' as const, userId: added[0] ?? env.memberId }
        const sealed = rotateAndSeal({ keyring: s.keyring, outbox: s.outbox, roster: s.roster, groupId: env.groupId, memberIds: others, exclude: removed, change,
          from: { userId: env.memberId, deviceId: s.vault.device.deviceId, encPrivate: s.encPrivate, sign: message => nobleEd25519Sign(message, s.signSeed) }, now, random: env.random })
        if (sealed.ok) {
          s.known = new Set(listedIds)
          s.rootDirty = true // 邀請根秘密是用這把 epoch 金鑰封的：換了就要重簽清單
          // 發信匣沒排進去（sealed.stored 是 false）的封包不算封過，補封會再來一次
          if (sealed.stored) for (const id of others) if (!sealed.missing.some(entry => entry === id || entry.startsWith(id + '/'))) s.sealedEpoch.set(id, `${sealed.epoch}:${s.roster.listVersion(id)}`)
          s.unsaved = true
        }
      }
      if (this.#ownerSign(s, plan, now)) s.unsaved = true
      // 先存再送：新的 epoch 與新的成員清單寫進保管庫之前，換鑰封包與清單一個都不送（不然重啟後會換出另一把同號的金鑰，群組從此分裂）
      if (s.unsaved && (await this.#flush(s))) s.unsaved = false
      // 下面的補封（#topUp）封的是「已經存進保管庫的目前這把 epoch 金鑰」：封包本身不存（發信匣的快照下一次存檔才進保管庫），重啟後補封會再封一次，put 是冪等的，所以沒有存好也不會造成同號不同鑰
      this.#topUp(s, listedIds.filter(id => id !== env.memberId), removed, now)
      if (!s.unsaved) {
        await s.outbox.flush(env.sync)
        await this.#publishMembers(s)
      }
    } else if (!isOwner) {
      const ownerId = s.book.ownerId
      if (ownerId !== '' && s.book.status() !== 'removed') {
        const fetched = await fetchEpochKeys(env.sync, { keyring: s.keyring, roster: s.roster, groupId: env.groupId, ownerMemberId: ownerId,
          me: { userId: env.memberId, deviceId: s.vault.device.deviceId, encPrivate: s.encPrivate }, now })
        if (fetched.ok && fetched.clockWarning) clockWarning = true
        this.#openRoot(s)
      }
      if (members.length > 0) s.known = new Set(ids)
    }
    if (clockWarning !== next.clockWarning) next = { ...next, clockWarning }
    return next
  }

  // ---- CHAT-6：成員身分 ----------------------------------------------------------------------------------------------------------

  /** 名單上的人（除了自己）的身分金鑰釘進 Roster；不在名單上的人忘掉（他們的裝置清單也一起不再被相信） */
  #pinFromBook(s: Session, skip: readonly string[] = []): void {
    const list = s.book.list
    if (!list) return
    for (const member of list.members) {
      if (member.memberId === this.#env.memberId || skip.includes(member.memberId)) continue
      const pinned = s.roster.identityOf(member.memberId)
      if (pinned === '') s.roster.pin(member.memberId, member.identityKey)
      else if (pinned !== member.identityKey) s.roster.repin(member.memberId, member.identityKey) // 群主簽了新的金鑰：舊的裝置清單作廢
    }
    for (const id of s.roster.pinnedUsers()) if (!list.members.some(member => member.memberId === id)) s.roster.forget(id)
  }

  /** 成員：還沒進清單就把加入證明放上中繼；讀群主簽的清單，驗過才採用；進了清單就不再送證明 */
  async #memberBook(s: Session): Promise<void> {
    const env = this.#env
    const proofNeeded = s.join !== null && !(s.book.list && s.book.status() !== 'removed' && s.book.list.members.some(member => member.memberId === env.memberId))
    if (proofNeeded && s.join) {
      const proof = makeJoinProof({ groupId: env.groupId, ownerKey: s.book.ownerKey, memberId: env.memberId }, s.join, s.identityKey)
      if (proof) { try { await env.sync.joinProofPut(proof) } catch { /* 下一輪再放 */ } }
    }
    let got: Awaited<ReturnType<SyncTransport['membersGet']>>
    try { got = await env.sync.membersGet() } catch { return }
    if (!got || got.ok !== true || got.list === null || got.list === undefined) return
    const accepted = s.book.accept(got.list)
    if (accepted.ok) {
      this.#pinFromBook(s)
      if (!accepted.removed && s.join !== null) s.join = null
    }
  }

  /** member：群主的清單裡封著邀請根秘密，用目前這把 epoch 金鑰打開（epoch 對不上就等下一輪） */
  #openRoot(s: Session): void {
    const sealed = s.book.list?.inviteRoot
    const current = s.keyring.current()
    if (!sealed || !current) return
    try {
      const root = openInviteRoot(sealed, current.key, this.#env.groupId, current.epoch)
      if (root !== '') s.inviteRoot = root
    } finally { wipe(current.key) }
  }

  /** 群主：讀成員的加入證明，驗過的加進名單；中繼名單上不見的人從名單拿掉。這裡只算出「應該有誰」，簽章在 #ownerSign */
  async #ownerPlan(s: Session, relayIds: readonly string[]): Promise<{ members: MemberEntry[]; changed: boolean; owner: NonNullable<ChatVaultV1['owner']> | null }> {
    const env = this.#env
    const owner = s.owner!
    const current = s.book.list
    const self: MemberEntry = { memberId: env.memberId, identityKey: s.identityKey }
    // 群主自己踢過的人（owner.removed）不管中繼怎麼說都不留；中繼說他還在，也不算數
    const kept = current ? current.members.filter(member => member.memberId !== env.memberId && relayIds.includes(member.memberId) && !owner.removed.includes(member.memberId)) : []
    const gone = current ? current.members.filter(member => member.memberId !== env.memberId && (!relayIds.includes(member.memberId) || owner.removed.includes(member.memberId))).map(member => member.memberId) : []
    const added: MemberEntry[] = []
    const used: string[] = []
    let got: Awaited<ReturnType<SyncTransport['joinProofsGet']>> | null = null
    try { got = await env.sync.joinProofsGet() } catch { got = null }
    if (got && got.ok === true && Array.isArray(got.proofs)) {
      for (const item of got.proofs.slice(0, 16)) {
        const entry = plain(item, ['memberId', 'proof'])
        if (!entry || !validToken(entry.memberId)) continue
        const id = entry.memberId
        if (id === env.memberId || !relayIds.includes(id) || owner.removed.includes(id) || kept.some(member => member.memberId === id) || added.some(member => member.memberId === id)) continue
        const proof = parseJoinProof(entry.proof)
        if (!proof || owner.usedInvites.includes(proof.n) || used.includes(proof.n)) continue
        if (proof.identityKey === s.identityKey || kept.some(member => member.identityKey === proof.identityKey) || added.some(member => member.identityKey === proof.identityKey)) continue
        if (!verifyJoinProof({ groupId: env.groupId, ownerKey: s.identityKey, memberId: id }, owner.root, proof)) continue
        added.push({ memberId: id, identityKey: proof.identityKey })
        used.push(proof.n)
      }
    }
    const members = [self, ...kept, ...added]
    const changed = current === null || added.length > 0 || gone.length > 0
    // 邀請用掉的記錄與換根秘密只先算出來放在 plan.owner：簽章成功（#ownerSign）才寫進 s.owner，簽不成就下一輪重來，不會把邀請白白用掉
    let nextOwner: NonNullable<ChatVaultV1['owner']> | null = null
    const newlyGone = gone.filter(id => !owner.removed.includes(id))
    if (gone.length > 0) {
      // 有人離開（自己離開或被踢）：他手上還有邀請根秘密，換一個新的，舊的邀請全部作廢；他的代號不再收證明
      const root = this.#randomRoot()
      if (root) nextOwner = Object.freeze({ root, usedInvites: Object.freeze([]), removed: Object.freeze([...owner.removed, ...newlyGone].slice(-MAX_USED_INVITES)), listPublished: owner.listPublished })
    } else if (used.length > 0) {
      nextOwner = Object.freeze({ ...owner, usedInvites: Object.freeze([...owner.usedInvites, ...used].slice(-MAX_USED_INVITES)) })
    }
    // 新加入的人先釘上，下面才收得到他們的裝置清單、封得出金鑰
    for (const member of added) {
      const pinned = s.roster.identityOf(member.memberId)
      if (pinned === '') s.roster.pin(member.memberId, member.identityKey)
      else if (pinned !== member.identityKey) s.roster.repin(member.memberId, member.identityKey)
    }
    for (const id of gone) s.roster.forget(id)
    // 自己名單上已有的人也要釘（重啟後 Roster 快照裡已經有；第一次的話由 #ownerSign 之後的 #pinFromBook 補上）；剛被拿掉的人不再釘回去
    this.#pinFromBook(s, gone)
    return { members, changed, owner: nextOwner }
  }

  #randomRoot(): string {
    const bytes = (this.#env.random ?? ((length: number) => crypto.getRandomValues(new Uint8Array(length))))(32)
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return ''
    let text = ''
    for (const byte of bytes) text += String.fromCharCode(byte)
    wipe(bytes)
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  /** 群主簽新的成員清單（有變、快過期、或邀請根秘密／epoch 換了）。簽好馬上收進自己的 book；放上中繼在存檔之後（#publishMembers） */
  #ownerSign(s: Session, plan: { members: MemberEntry[]; changed: boolean; owner: NonNullable<ChatVaultV1['owner']> | null }, now: number): boolean {
    const env = this.#env
    const current = s.book.list
    const due = plan.changed || plan.owner !== null || s.rootDirty || !current || now - current.issuedAt >= MEMBER_LIST_REISSUE_MS
    if (!due) return false
    const key = s.keyring.current()
    if (!key) return false // 還沒有 epoch 金鑰：先換第一把，下一輪再簽
    try {
      const sealed = sealInviteRoot({ epochKey: key.key, groupId: env.groupId, epoch: key.epoch, root: (plan.owner ?? s.owner!).root, random: env.random })
      if (!sealed) return false
      const list = signMemberList({ groupId: env.groupId, listVersion: (current?.listVersion ?? 0) + 1, issuedAt: now, ownerId: env.memberId, members: plan.members, inviteRoot: sealed }, s.identitySeed)
      if (!list || !s.book.accept(list).ok) return false
      if (plan.owner) s.owner = plan.owner
      s.rootDirty = false
      this.#pinFromBook(s)
      return true
    } finally { wipe(key.key) }
  }

  async #publishMembers(s: Session): Promise<void> {
    const owner = s.owner
    const list = s.book.list
    if (!owner || !list || owner.listPublished >= list.listVersion) return
    let result: Awaited<ReturnType<SyncTransport['membersPut']>>
    try { result = await this.#env.sync.membersPut(list) } catch { return }
    if (result && result.ok === true) s.owner = Object.freeze({ ...owner, listPublished: list.listVersion })
  }

  /** 群主踢人成功之後：把他記進 owner.removed（之後不管中繼怎麼說都不留他、不收他的證明）並存檔；下一輪同步會換 epoch、換 R、重簽清單 */
  noteRemoved(memberId: string): Promise<boolean> {
    return this.#serial(async () => {
      const s = this.#session
      if (!s || !s.owner || !validToken(memberId) || memberId === this.#env.memberId) return false
      if (!s.owner.removed.includes(memberId)) {
        s.owner = Object.freeze({ ...s.owner, removed: Object.freeze([...s.owner.removed, memberId].slice(-MAX_USED_INVITES)) })
        s.unsaved = true
      }
      return (await this.#flush(s)) ? (s.unsaved = false, true) : false
    })
  }

  /** 複製邀請時用：這份邀請的 n、s 和我信的群主身分金鑰與版本下限。沒有邀請根秘密（成員還沒收到）就是 null */
  makeInvite(): Promise<Readonly<{ ownerKey: string; n: string; s: string; floor: number }> | null> {
    return this.#serial(async () => {
      const s = this.#session
      if (!s || this.#gate !== 'open') return null
      const root = s.owner ? s.owner.root : s.inviteRoot
      if (root === '' || s.book.status() !== 'fresh' && !s.owner) return null
      const minted = mintInvite(root, this.#env.random)
      return minted ? Object.freeze({ ownerKey: s.book.ownerKey, n: minted.n, s: minted.s, floor: s.book.listVersion }) : null
    })
  }

  /** 清單晚一步才放上中繼（或群主剛重啟）的成員：補封目前這一把 epoch 金鑰（不換 epoch：加入當下已經換過了） */
  #topUp(s: Session, others: readonly string[], removed: readonly string[], now: number): void {
    const current = s.keyring.current()
    if (!current) return
    try {
      const targets = others.filter(id => !removed.includes(id) && s.roster.status(id) === 'fresh' && s.sealedEpoch.get(id) !== `${current.epoch}:${s.roster.listVersion(id)}`)
      if (targets.length === 0) return
      const sealed = sealEpochKeyForMembers({ groupId: this.#env.groupId, epoch: current.epoch, key: current.key, userIds: targets, roster: s.roster, createdAt: now,
        from: { userId: this.#env.memberId, deviceId: s.vault.device.deviceId, encPrivate: s.encPrivate, sign: message => nobleEd25519Sign(message, s.signSeed) }, random: this.#env.random })
      const out: EpochPacketOut[] = []
      for (const pkg of sealed.packages) {
        const packet = encodePacket(pkg)
        if (packet) out.push({ toMember: pkg.to.userId, toDevice: pkg.to.deviceId, epoch: pkg.epoch, packet })
      }
      if (out.length > 0 && !s.outbox.enqueue(out)) return
      for (const id of targets) if (!sealed.missing.some(entry => entry === id || entry.startsWith(id + '/'))) s.sealedEpoch.set(id, `${current.epoch}:${s.roster.listVersion(id)}`)
    } finally { wipe(current.key) }
  }

  async #pollDms(s: Session, view: ChatViewState, now: number, full: boolean, addIncoming: (count: number) => void): Promise<ChatViewState> {
    let next = view
    if (full || now - s.lastDmListAt >= DM_LIST_MS) {
      const listed = await this.#env.dm.list()
      if (listed.ok) { s.links = validLinks(listed.links); s.lastDmListAt = now }
    }
    const active = s.links.filter(link => link.state === 'active' && typeof link.code === 'string')
    const dmMessages: Record<string, readonly ChatViewMessage[]> = { ...next.dmMessages }
    const stalled: string[] = []
    for (let from = 0; from < active.length; from += 10) {
      const chunk = active.slice(from, from + 10)
      const polled = await s.client.pollDm(this.#guarded, chunk.map(link => ({ code: link.code!, peerUserId: link.peer })))
      if (isFail(polled)) { next = withState(next, 'unreachable'); break }
      const boxes = polled as Readonly<Record<string, PollSummary>>
      for (const link of chunk) {
        const summary = Object.hasOwn(boxes, link.code!) ? boxes[link.code!] : undefined
        if (!summary) continue
        const fresh = this.#fromSummary(summary)
        if (!s.muted.has(link.code!)) addIncoming(fresh.filter(message => !message.isMe).length)
        dmMessages[link.code!] = mergeMessages(dmMessages[link.code!] ?? [], fresh)
      }
    }
    for (const link of active) {
      if (s.roster.devices(link.peer).some(device => s.client.dmSecurity(link.code!, link.peer, device.deviceId)?.stalled === true)) stalled.push(link.code!)
    }
    return Object.freeze({ ...next, dmMessages: Object.freeze(dmMessages), dms: this.#rows(s), stalledCodes: Object.freeze(stalled) })
  }

  #rows(s: Session): readonly DmRow[] {
    const rows: DmRow[] = []
    for (const link of s.links) {
      if (!LINK_STATES.has(link.state) || link.peer === this.#env.memberId) continue
      const code = link.state === 'active' && typeof link.code === 'string' ? link.code : ''
      rows.push(Object.freeze({ peerId: link.peer, peerName: this.#name(link.peer), state: link.state as DmLinkState, code, unread: 0, muted: code !== '' && s.muted.has(code) }))
    }
    // 群組裡還沒有任何私訊連結的朋友：列出來，畫面給「傳訊息」鈕
    for (const member of this.#env.members()) {
      if (member.id === this.#env.memberId || rows.some(row => row.peerId === member.id)) continue
      rows.push(Object.freeze({ peerId: member.id, peerName: member.name, state: 'none' as const, code: '', unread: 0, muted: false }))
    }
    return Object.freeze(rows)
  }

  // ---- 送出 ---------------------------------------------------------------------------------------------------------------------

  #failure(view: ChatViewState, reason: string, text: string): ChatViewState {
    if (reason === 'too-long') return withState(view, 'tooLong', byteLength(text.trim()) - CHAT_CLIENT_MAX_TEXT_BYTES)
    return withState(view, 'sendFailed')
  }

  #echo(text: string, id: string): ChatViewMessage {
    const now = this.#env.now()
    return Object.freeze({ id, senderId: this.#env.memberId, senderName: this.#name(this.#env.memberId), isMe: true, sentAt: now, receivedAt: now, text })
  }

  /** 群組聊天送一則。秘密提示：第一次送出被擋，同一段文字再送一次就算確認 */
  send(text: string): Promise<SendOutcome> {
    return this.#serial(async () => {
      const s = this.#session
      if (!s || this.#gate !== 'open') return 'failed'
      const trimmed = typeof text === 'string' ? text.trim() : ''
      if (trimmed === '') return 'ignored'
      const result = await s.client.sendGroup(this.#guarded, text, { confirmedSecret: this.#secretPending === trimmed })
      return this.#finishSend(s, result, trimmed, GROUP_KEY)
    })
  }

  /** 私訊送一則（對方每台裝置各一份） */
  sendDm(code: string, text: string): Promise<SendOutcome> {
    return this.#serial(async () => {
      const s = this.#session
      const row = this.#view.dms.find(item => item.code === code && item.state === 'active')
      if (!s || !row || this.#gate !== 'open') return 'failed'
      const trimmed = typeof text === 'string' ? text.trim() : ''
      if (trimmed === '') return 'ignored'
      const result = await s.client.sendDm(this.#guarded, { code, peerUserId: row.peerId, text, confirmedSecret: this.#secretPending === trimmed })
      if ('results' in result) {
        const done = result.results.find(item => item.status === 'sent' || item.status === 'queued')
        if (done?.messageId) return this.#finishSend(s, { ok: true as const, messageId: done.messageId }, trimmed, code, result.results.some(item => item.status === 'queued') ? 'queued' : 'sent')
        const reason = result.results.find(item => item.reason)?.reason ?? 'seal'
        return this.#finishSend(s, { ok: false as const, reason: reason === 'pending' ? 'pending' : reason === 'persist' ? 'persist' : 'seal' }, trimmed, code)
      }
      return this.#finishSend(s, { ok: false as const, reason: result.reason }, trimmed, code)
    })
  }

  async #finishSend(s: Session, result: { ok: true; messageId: string } | { ok: false; reason: string }, trimmed: string, key: string, status: 'sent' | 'queued' = 'sent'): Promise<SendOutcome> {
    let view = this.#view
    if (result.ok) {
      this.#secretPending = ''
      const echo = this.#echo(trimmed, result.messageId)
      view = key === GROUP_KEY ? { ...view, messages: mergeMessages(view.messages, [echo]) } : { ...view, dmMessages: { ...view.dmMessages, [key]: mergeMessages(view.dmMessages[key] ?? [], [echo]) } }
      view = withState({ ...view, inputGen: view.inputGen + 1 }, status === 'queued' ? 'unreachable' : null)
      await this.#flush(s)
      this.#emit(view)
      return status
    }
    if (result.reason === 'blank') return 'ignored'
    if (result.reason === 'secret-hint') {
      this.#secretPending = trimmed
      this.#emit(withState(view, 'secretHint'))
      return 'failed'
    }
    if (result.reason === 'transport') {
      // 中繼這一刻沒收下，但信封已存好、會自己重送：當作送出（畫面提示連不上，輸入框清空，不然再按一次會多送一則）
      this.#secretPending = ''
      const echoId = `q${(this.#echoSeq++).toString(36)}${this.#env.now().toString(36)}`.padEnd(22, 'A').slice(0, 22)
      this.#queuedEchoes.add(echoId)
      const echo = this.#echo(trimmed, echoId)
      view = key === GROUP_KEY ? { ...view, messages: mergeMessages(view.messages, [echo]) } : { ...view, dmMessages: { ...view.dmMessages, [key]: mergeMessages(view.dmMessages[key] ?? [], [echo]) } }
      this.#emit(withState({ ...view, inputGen: view.inputGen + 1 }, 'unreachable'))
      return 'queued'
    }
    this.#secretPending = ''
    this.#emit(this.#failure(view, result.reason, trimmed))
    return 'failed'
  }

  // ---- 私訊的連結與靜音 ---------------------------------------------------------------------------------------------------------

  /** 請求、同意、拒絕、封鎖、解除封鎖；做完馬上重問連結清單 */
  dmAction(kind: DmOp, peerId: string): Promise<boolean> {
    return this.#serial(async () => {
      const s = this.#session
      if (!s || this.#gate !== 'open' || peerId === this.#env.memberId) return false
      const result = await this.#env.dm.op(kind, peerId)
      const listed = await this.#env.dm.list()
      if (listed.ok) { s.links = validLinks(listed.links); s.lastDmListAt = this.#env.now() }
      let view: ChatViewState = Object.freeze({ ...this.#view, dms: this.#rows(s) })
      if (!result.ok) view = withState(view, 'unreachable')
      else if (view.state === 'unreachable') view = withState(view, null)
      this.#emit(view)
      return result.ok
    })
  }

  /** 靜音只在這台電腦：藏起這段對話的訊息、不算未讀；不通知對方 */
  setMuted(code: string, isMuted: boolean): Promise<void> {
    return this.#serial(async () => {
      const s = this.#session
      if (!s || !this.#view.dms.some(row => row.code === code)) return
      if (isMuted) s.muted.add(code); else s.muted.delete(code)
      await this.#flush(s)
      this.#emit({ ...this.#view, dms: this.#rows(s) })
    })
  }

  /** 卡住的私訊會話（stalled）重置：這位朋友的每台裝置各丟掉一次；對方也要重置 */
  resetDm(code: string): Promise<void> {
    return this.#serial(async () => {
      const s = this.#session
      const row = this.#view.dms.find(item => item.code === code && item.state === 'active')
      if (!s || !row) return
      for (const device of s.roster.devices(row.peerId)) await s.client.resetDmSession(code, row.peerId, device.deviceId)
      await this.#flush(s)
      this.#emit({ ...this.#view, stalledCodes: this.#view.stalledCodes.filter(item => item !== code) })
    })
  }

  /** 看目前打開的是哪一個對話（接線層用來決定按鈕行為） */
  get openKey(): string { return openKey(this.#view) }
  /** 這台電腦有沒有準備好的聊天保管庫（沒有就不碰中繼，也不需要搶『誰負責聊天』） */
  get hasSession(): boolean { return this.#session !== null }
  get isPersistFailing(): boolean { return this.#persistFailing }
}
export type { ChatNotice }
