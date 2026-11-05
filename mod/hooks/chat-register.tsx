// CHAT-4W：聊天接線。外掛只准一個 hooks 模組（hooks.json 只有 register.tsx），所以這個檔案不自己登記 session.start／session.end／ui.close：
// register.tsx 的同名 hook 呼叫這裡匯出的 chatSessionStart／chatSessionEnd／chatPaneClosed；只有聊天分頁的 ui.render（有 requestId，不會跟別的重複）在這裡登記。
// 這個檔案是整個外掛裡「唯一」碰到聊天明文和 $ 的地方：$ 不能傳給別的模組的函式（validate 會擋），所以所有要用 $ 的聊天程式都寫在這裡；
// 其他聊天檔案（chat-controller／chat-pane／chat-view…）都是純函式或注入式的，不 import 引擎。
// 聊天文字只有一條路：中繼 → 用戶端解密 → 控制器 → 記憶體 atom with-friends/chat → 聊天分頁的畫面。
// 這個檔案做的事：①問中繼能不能聊（GET /capability，簽章驗過才開）②把 $.http／$.store 包成控制器要的傳輸與保管庫 ③排計時器 ④畫聊天分頁。
// 通知（toast）只有一句固定的「有新的聊天訊息」，不帶人名、不帶內文；指令輸出、$.store、日誌、status 都不放聊天文字。

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Friend, Membership } from '../types'
import { evaluateChatCapability, GATE_SUSPECT_MIN_GAP_MS, gateMarkSuspect, gateOpen, gateShouldProbe, gateUpdate, probeChatGate } from './chat-capability'
import type { GateEntry, GateReason } from './chat-capability'
import { ChatController } from './chat-controller'
import type { ChatEnv, ChatGate, DmOp, MemberInfo } from './chat-controller'
import { isChatDisabled, isSuspect, reasonOf, toSyncFailure, toTransportResult } from './chat-http-map'
import type { HttpOutcome } from './chat-http-map'
import type { ChatTransport } from './chat-client'
import { renderChatPane } from './chat-pane'
import type { ChatPaneActions } from './chat-pane'
import { CHAT_STRINGS } from './chat-strings'
import type { SyncTransport } from './chat-sync'
import { formatWf1, publicKeyOf } from './chat-members'
import type { Wf1Invite } from './chat-members'
import { provisionVault } from './chat-provision'
import { cleared, INITIAL_CHAT_VIEW } from './chat-view'
import { wireText } from './chat-wire-strings'
import { DM_STRINGS } from './dm-strings'
import { DEFAULT_RELAY, isSecureRelay, membershipOf, relayOrigin } from './relay-url'
import { isResponsePublicKey, newResponseNonce, OFFICIAL_RESPONSE_KEYS, verifyRelaySignature } from './response-signing'
import type { Lang } from './taxonomy'

/** 聊天分頁的 requestId：跟朋友列表（'friends'）分開，兩棵畫面樹互不相干（chat4-iso-design §2.1） */
const CHAT_PANE = 'friends-chat' // chat-view.ts 的 CHAT_PANE_ID 同值（有測試比對）；字面字串才讀得到 requestId
const VAULT_KEY = 'chatVaultV1'
const LEASE_KEY = 'chatLeaseV1'
/** 計時器的基本節拍；聊天分頁開著每拍都做事，關著每 CLOSED_EVERY 拍才做一次（請求量，relay/COST.md） */
export const CHAT_TICK_MS = 5_000
export const CLOSED_EVERY = 12
/** 誰負責聊天（多個對話共用同一份保管庫）：租約每 LEASE_EVERY 拍續約一次，到期沒人續就換別人 */
export const LEASE_MS = 150_000
/** 一次請求最久等多久（模組沒有計時器：卡住的請求會卡住後面所有排隊的送出與輪詢） */
export const HTTP_TIMEOUT_MS = 10_000
const MAX_BODY_CHARS = 1_000_000
/** 新訊息提醒至少隔多久一次 */
const NOTICE_GAP_MS = 60_000

// plugin／key 要寫字面字串；跟 register.tsx 宣告的是同一個 atom
const friendsAtom = atom({ plugin: 'with-friends', key: 'friends' } as const, [] as Friend[])
const chatAtom = atom({ plugin: 'with-friends', key: 'chat' } as const, INITIAL_CHAT_VIEW)
const langAtom = atom({ plugin: 'with-friends', key: 'lang' } as const, 'en' as Lang)

let controller: ChatController | null = null
let controllerKey = ''
let starting: Promise<void> | null = null
let gateEntry: GateEntry | undefined
let gateOrigin = ''
let probing = false
let members: readonly MemberInfo[] = []
let conn = ''
let isChatPaneOpen = false
let beat = 0
let ticking = false
let lastNoticeAt = -Infinity
let holdsLease = false
/** 本機記的租約到期時間（引擎時鐘）：快到期就當沒有，重新確認 */
let leaseUntil = 0
let sendBusy = false
/** 這個外掛自己的版本（register.tsx 讀 plugin.json 後交過來；讀不到＝''，請求就不帶 x-friends-version） */
let chatVersion = ''
export function setChatVersion(version: string): void { chatVersion = version }

/**
 * 聊天用的時間：引擎的 $.clock.now()（跟 Date.now() 同一個意思：epoch 毫秒，但測試可以撥動它）。控制器與閘門要同步的函式，
 * 所以每一拍開頭、每次使用者按鈕之前先問一次、記在這裡；最多落後一拍（5 秒），信封的 sentAt 容得下。
 */
let engineNow = Date.now()
const clockNow = (): number => engineNow
async function refreshClock($: EngineInterface): Promise<void> {
  try { const t = await $.clock.now(); if (Number.isFinite(t) && t > 0) engineNow = t } catch { /* 問不到就沿用上次的 */ }
}
/** 不等結果的呼叫：失敗（例如對話已經結束）不能變成沒人處理的 rejection */
const fire = (promise: Promise<unknown> | undefined): void => { void promise?.catch(() => {}) }

type RelayTrust = { mode: 'pinned'; origins?: Record<string, { keyId: string; publicKey: string } | string>; origin?: string; publicKey?: string } | { mode: 'official' }
async function trustFor($: EngineInterface, origin: string): Promise<{ keyId: string; publicKey: string } | null> {
  if (origin === DEFAULT_RELAY) {
    const [keyId, publicKey] = Object.entries(OFFICIAL_RESPONSE_KEYS)[0]!
    return { keyId, publicKey }
  }
  const v = (await $.store.get('relayTrustV1')) as RelayTrust | undefined
  if (v?.mode !== 'pinned') return null
  const pin = v.origins?.[origin]
  // 舊版只存 public key、沒有可核對的 key id：不信（跟朋友列表那邊一樣）
  if (typeof pin === 'string' || (pin === undefined && v.origin === origin && v.publicKey)) return null
  return pin && /^[A-Za-z0-9._-]{1,64}$/.test(pin.keyId) && isResponsePublicKey(pin.publicKey) ? pin : null
}

const NO_REPLY: HttpOutcome = Object.freeze({ status: 0, reason: '', signed: false })
type Reply = Readonly<{ outcome: HttpOutcome; data: Record<string, unknown> | null }>

/** 對聊天路由的一次請求：只對 https（或本機）中繼；簽章驗過才信回應；中繼的錯誤原文一個字都不留（只留狀態碼和固定清單內的 reason） */
async function chatFetch($: EngineInterface, m: Membership, path: string, body: unknown): Promise<Reply> {
  const origin = relayOrigin(m.relay)
  if (!origin || !isSecureRelay(origin)) return { outcome: NO_REPLY, data: null }
  let trust: { keyId: string; publicKey: string } | null
  try { trust = await trustFor($, origin) } catch { return { outcome: NO_REPLY, data: null } }
  if (!trust) return { outcome: NO_REPLY, data: null }
  const nonce = newResponseNonce()
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'x-friends-nonce': nonce, 'x-friends-origin': origin, ...(chatVersion ? { 'x-friends-version': chatVersion } : {}), authorization: `Bearer ${m.groupId}.${m.memberId}.${m.memberKey}`,
  }
  let res: { status: number; headers?: Record<string, unknown>; text: string }
  try {
    res = await Promise.race([
      $.http.fetch(origin + path, { method: 'POST', headers, body: JSON.stringify(body) }),
      $.clock.sleep(HTTP_TIMEOUT_MS).then((): never => { throw new Error('timeout') }),
    ])
  } catch { return { outcome: NO_REPLY, data: null } }
  const header = (name: string): unknown => res.headers?.[name]
  const status = Number(res.status)
  const text = typeof res.text === 'string' && res.text.length <= MAX_BODY_CHARS ? res.text : ''
  const signed = text !== '' && verifyRelaySignature({
    nonce, origin, method: 'POST', path, status, body: text, returnedNonce: header('x-friends-nonce'), keyId: header('x-friends-key-id'),
    expectedKeyId: trust.keyId, signature: header('x-friends-signature'), publicKey: trust.publicKey,
  })
  let data: Record<string, unknown> | null = null
  if (signed) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
    } catch { data = null }
  }
  return { outcome: { status: Number.isSafeInteger(status) ? status : 0, reason: data ? reasonOf(data.reason) : '', signed: signed && data !== null }, data }
}

/** 聊天路由出了怪事：關著（chat-disabled）要馬上重問並關閘門；其餘不明失敗盡快重問（兩次至少隔 10 秒） */
function noteOutcome(origin: string, outcome: HttpOutcome): void {
  const now = clockNow()
  if (isChatDisabled(outcome)) {
    // 外掛不能把它當成被拒絕或裝置被撤銷：總開關關了，閘門立刻關起來，下一輪重問 /capability
    gateEntry = gateUpdate(gateEntry, { show: false, reason: 'disabled', ttlMs: 0, transient: false, startedAt: now }, origin, now)
    // 馬上重問一次 /capability（看中繼是不是真的關了）；問完會照一般規則排下一次
    gateEntry = { ...gateEntry, nextCheckAt: now + GATE_SUSPECT_MIN_GAP_MS }
  } else if (isSuspect(outcome)) gateEntry = gateMarkSuspect(gateEntry, now)
}

const ok = <T,>(extra: T) => ({ ok: true as const, ...extra })

function transportsFor($: EngineInterface, m: Membership): Pick<ChatEnv, 'transport' | 'sync' | 'dm' | 'registerDevice'> {
  const origin = relayOrigin(m.relay) ?? ''
  const call = async (path: string, body: unknown): Promise<Reply> => {
    const reply = await chatFetch($, m, path, body)
    noteOutcome(origin, reply.outcome)
    return reply
  }
  const transport: ChatTransport = {
    publish: async (envelope, options) => toTransportResult('publish', (await call('/chat/publish', { envelope })).outcome, options.resend),
    dmSend: async (code, envelope, options) => toTransportResult('dmSend', (await call('/dm/send', { code, envelope })).outcome, options.resend),
    poll: async after => {
      const { outcome, data } = await call('/chat/poll', { after })
      const messages = data?.messages
      if (outcome.status !== 200 || !outcome.signed || !Array.isArray(messages)) return { ok: false as const }
      return { ok: true as const, messages: messages.map(item => ({ sequence: (item as { sequence?: number })?.sequence as number, envelope: (item as { envelope?: unknown })?.envelope })) }
    },
    dmPoll: async boxes => {
      const { outcome, data } = await call('/dm/poll', { boxes })
      const out = data?.boxes
      if (outcome.status !== 200 || !outcome.signed || typeof out !== 'object' || out === null || Array.isArray(out)) return { ok: false as const }
      return { ok: true as const, boxes: out as Record<string, { messages: { sequence: number; envelope: unknown }[] }> }
    },
  }
  const sync: SyncTransport = {
    rosterPut: async list => {
      const { outcome, data } = await call('/chat/roster/put', { list })
      return outcome.status === 200 && outcome.signed && data ? ok({ listVersion: Number(data.listVersion), serverTime: Number(data.serverTime) }) : toSyncFailure(outcome)
    },
    rosterGet: async () => {
      const { outcome, data } = await call('/chat/roster/get', {})
      return outcome.status === 200 && outcome.signed && data && Array.isArray(data.rosters) ? ok({ rosters: data.rosters as never[], serverTime: Number(data.serverTime) }) : toSyncFailure(outcome)
    },
    epochPut: async packets => {
      const { outcome, data } = await call('/chat/epoch/put', { packets })
      return outcome.status === 200 && outcome.signed && data ? ok({ stored: Number(data.stored) }) : toSyncFailure(outcome)
    },
    epochGet: async after => {
      const { outcome, data } = await call('/chat/epoch/get', after === undefined ? {} : { after })
      return outcome.status === 200 && outcome.signed && data && Array.isArray(data.packets) ? ok({ packets: data.packets as never[], serverTime: Number(data.serverTime) }) : toSyncFailure(outcome)
    },
    // CHAT-6：加入證明與群主簽的成員清單（中繼只存、只轉送）
    joinProofPut: async proof => {
      const { outcome } = await call('/chat/join/put', { proof })
      return outcome.status === 200 && outcome.signed ? ok({}) : toSyncFailure(outcome)
    },
    joinProofsGet: async () => {
      const { outcome, data } = await call('/chat/join/get', {})
      return outcome.status === 200 && outcome.signed && data && Array.isArray(data.proofs) ? ok({ proofs: data.proofs as never[] }) : toSyncFailure(outcome)
    },
    membersPut: async list => {
      const { outcome } = await call('/chat/members/put', { list })
      return outcome.status === 200 && outcome.signed ? ok({}) : toSyncFailure(outcome)
    },
    membersGet: async () => {
      const { outcome, data } = await call('/chat/members/get', {})
      return outcome.status === 200 && outcome.signed && data ? ok({ list: data.list ?? null, serverTime: Number(data.serverTime) }) : toSyncFailure(outcome)
    },
  }
  const dm = {
    list: async () => {
      const { outcome, data } = await call('/dm/list', {})
      return outcome.status === 200 && outcome.signed && data && Array.isArray(data.links)
        ? ok({ links: (data.links as { peer?: unknown; state?: unknown; code?: unknown }[]).filter(link => typeof link?.peer === 'string' && typeof link?.state === 'string').map(link => ({ peer: link.peer as string, state: link.state as string, ...(typeof link.code === 'string' ? { code: link.code } : {}) })) })
        : toSyncFailure(outcome)
    },
    op: async (kind: DmOp, peerId: string) => {
      const { outcome, data } = await call('/dm/' + kind, { memberId: peerId })
      return outcome.status === 200 && outcome.signed && data ? ok(typeof data.code === 'string' ? { code: data.code } : {}) : toSyncFailure(outcome)
    },
  }
  const registerDevice = async (deviceId: string, publicKey: string) => {
    const { outcome } = await call('/chat/device', { deviceId, publicKey })
    return outcome.status === 200 && outcome.signed ? ok({}) : toSyncFailure(outcome)
  }
  return { transport, sync, dm, registerDevice }
}

async function getMembership($: EngineInterface): Promise<Membership | undefined> {
  return membershipOf(await $.store.get('membership'))
}

async function refreshMembers($: EngineInterface): Promise<void> {
  const list = await read($, friendsAtom)
  members = list.filter(f => typeof f.id === 'string' && f.id !== '').map(f => ({ id: f.id, name: f.name, isOwner: f.isOwner === true }))
}

async function disposeController(): Promise<void> {
  const c = controller
  controller = null
  controllerKey = ''
  starting = null
  gateEntry = undefined
  gateOrigin = ''
  // 最後一次寫保管庫（dispose 裡）還需要租約：先收掉控制器，再放掉租約
  if (c) await c.dispose('not-in-group')
  holdsLease = false
  leaseUntil = 0
}

async function ensureController($: EngineInterface, m: Membership): Promise<ChatController | null> {
  const key = `${m.relay}|${m.groupId}|${m.memberId}`
  if (controller && controllerKey === key) { if (starting) await starting; return controller }
  await disposeController()
  const env: ChatEnv = {
    groupId: m.groupId, memberId: m.memberId, now: clockNow,
    ...transportsFor($, m),
    loadVault: async () => $.store.get(VAULT_KEY),
    // 寫保管庫之前再讀一次租約，確認留在 store 裡的還是自己的（本機記的 holdsLease 只是快取：租約可能已經過期、被別的對話拿走）
    canWrite: () => holdsLease && clockNow() < leaseUntil,
    saveVault: async vault => {
      const cur = (await $.store.get(LEASE_KEY)) as { conn?: unknown } | undefined
      if (cur?.conn !== conn) { holdsLease = false; throw new Error('lease-lost') }
      await $.store.set(VAULT_KEY, vault)
    },
    members: () => members,
    publish: view => { fire(update($, chatAtom, () => view)) },
  }
  const made = ChatController.create(env)
  if (!made) return null
  controller = made
  controllerKey = key
  starting = made.start()
  await starting
  starting = null
  made.setTabOpen(isChatPaneOpen)
  return made
}

// ---- 閘門（GET /capability）----

const GATE_OF: Record<GateReason, ChatGate> = {
  ok: 'open', 'no-trust': 'relay-unsupported', network: 'checking', 'http-error': 'relay-bad', untrusted: 'relay-bad', 'relay-old': 'relay-unsupported',
  'bad-body': 'relay-bad', disabled: 'relay-unsupported', wire: 'relay-unsupported', size: 'relay-unsupported', features: 'relay-unsupported',
}

async function gateFor($: EngineInterface, m: Membership): Promise<ChatGate> {
  const origin = relayOrigin(m.relay)
  if (!origin || !isSecureRelay(origin)) return 'relay-unsupported'
  if (gateOrigin !== origin) { gateEntry = undefined; gateOrigin = origin }
  const now = clockNow()
  if (!probing && gateShouldProbe(gateEntry, origin, now)) {
    probing = true
    try {
      let trust: { keyId: string; publicKey: string } | null = null
      try { trust = await trustFor($, origin) } catch { trust = null }
      const result = await probeChatGate({
        origin, trust, ...(chatVersion ? { version: chatVersion } : {}), now: clockNow, sleep: ms => $.clock.sleep(ms),
        fetch: async (path, headers) => {
          const res = await $.http.fetch(origin + path, { method: 'GET', headers })
          return { status: Number(res.status), headers: res.headers ?? {}, text: typeof res.text === 'string' ? res.text : '' }
        },
      })
      gateEntry = gateUpdate(gateEntry, result, origin, clockNow())
    } finally { probing = false }
  }
  if (!gateEntry) return 'checking'
  if (gateOpen(gateEntry, origin, clockNow())) return 'open'
  return GATE_OF[gateEntry.reason] === 'open' ? 'relay-bad' : GATE_OF[gateEntry.reason]
}

// ---- 誰負責聊天 ----

async function claimLease($: EngineInterface): Promise<boolean> {
  const now = clockNow()
  const cur = (await $.store.get(LEASE_KEY)) as { conn?: unknown; until?: unknown } | undefined
  if (cur && typeof cur.until === 'number' && cur.until > now && cur.conn !== conn) return false
  await $.store.set(LEASE_KEY, { conn, until: now + LEASE_MS })
  // 兩個對話同時搶時各自寫一次、最後寫的贏：寫完再讀回來，確認留下來的是自己的
  const back = (await $.store.get(LEASE_KEY)) as { conn?: unknown } | undefined
  if (back?.conn !== conn) return false
  leaseUntil = now + LEASE_MS
  return true
}

// ---- 計時器 ----

/** 聊天分頁現在開著嗎：問引擎自己的紀錄（$.ui.panes），比事件可靠；問不到就沿用 ui.render／ui.close 記下的 */
async function syncPaneOpen($: EngineInterface, c: ChatController): Promise<void> {
  try {
    const open = (await $.ui.panes()).some(pane => pane.id === CHAT_PANE && pane.isShown && pane.isPlaced)
    if (open !== isChatPaneOpen) { isChatPaneOpen = open; c.setTabOpen(open) }
  } catch { /* 沒有這個呼叫就用事件記下的狀態 */ }
}

async function chatTick($: EngineInterface, force = false): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    await refreshClock($)
    beat += 1
    const m = await getMembership($)
    if (!m) {
      if (controller) await disposeController()
      const cur = await read($, chatAtom)
      if (cur.availability !== 'not-in-group') await update($, chatAtom, () => cleared('not-in-group'))
      return
    }
    const c = await ensureController($, m)
    if (!c) return
    await refreshMembers($)
    await syncPaneOpen($, c)
    if (!force && !isChatPaneOpen && beat % CLOSED_EVERY !== 0) return
    let gate = await gateFor($, m)
    if (c.hasSession) {
      // 不論閘門是什麼狀態都要確認租約：沒有租約的對話不能寫保管庫（閘門關著時一樣會做到期清除、一樣會想存檔）
      if (!holdsLease || leaseUntil - clockNow() < LEASE_MS / 2) {
        const had = holdsLease
        holdsLease = await claimLease($)
        // 剛拿到租約：別的對話可能已經改過保管庫，記憶體裡的是舊的，重讀
        if (holdsLease && !had) await c.reload()
      }
      if (!holdsLease) gate = 'other-session'
    }
    c.setGate(gate)
    const result = await c.tick({ full: force })
    if (result.incoming > 0 && !isChatPaneOpen && clockNow() - lastNoticeAt >= NOTICE_GAP_MS) {
      lastNoticeAt = clockNow()
      $.ui.toast(wireText('newMessageNotice', await read($, langAtom)))
    }
  } catch { /* 下一拍再試；錯誤原文不往任何地方送 */ } finally { ticking = false }
}

// ---- 畫面 ----

function actionsFor($: EngineInterface, lang: Lang): ChatPaneActions {
  const ask = async (question: string): Promise<boolean> => {
    const dm = DM_STRINGS[lang]
    try { return (await $.ui.ask(question, { header: CHAT_STRINGS[lang].tabChat, options: [dm.dmConfirmYes, dm.dmConfirmNo] })) === dm.dmConfirmYes } catch { return false }
  }
  return {
    // 送出鎖：上一則還在送的時候再按（連按兩次 Enter）不再送第二則
    send: text => { if (sendBusy) return; sendBusy = true; fire(refreshClock($).then(() => controller?.send(text)).finally(() => { sendBusy = false })) },
    sendDm: (code, text) => { if (sendBusy) return; sendBusy = true; fire(refreshClock($).then(() => controller?.sendDm(code, text)).finally(() => { sendBusy = false })) },
    setMode: mode => { controller?.select(mode) },
    openThread: code => { controller?.select('dm-thread', code) },
    dmRequest: peerId => { fire(controller?.dmAction('request', peerId)) },
    dmAccept: peerId => { fire(controller?.dmAction('accept', peerId)) },
    dmDecline: peerId => { fire(controller?.dmAction('decline', peerId)) },
    dmBlock: peerId => { fire((async () => { if (await ask(DM_STRINGS[lang].dmBlockConfirm)) await controller?.dmAction('block', peerId) })()) },
    dmUnblock: peerId => { fire(controller?.dmAction('unblock', peerId)) },
    toggleMute: (code, isMuted) => { fire((async () => { if (!isMuted || (await ask(DM_STRINGS[lang].dmMuteConfirm))) await controller?.setMuted(code, isMuted) })()) },
    resetDm: code => { fire(controller?.resetDm(code)) },
    toggleMore: () => { controller?.togglePreviewMore() },
  }
}

// ---- CHAT-6：保管庫的建立、清除，和 wf1: 邀請 ----

/**
 * 建立群組（群主）或用 wf1: 邀請加入（成員）之後：在這台電腦產生聊天保管庫（身分金鑰、裝置金鑰、自己簽好的裝置清單、信任起點）。
 * 沒有 wf1（用舊連結加入）就不產生：聊天停在「還沒設定好」，要用新的邀請加入才能聊（主人 11-05 定案）。寫不進去也不影響加入群組本身。
 */
export async function chatProvision($: EngineInterface, m: Membership, wf1?: Wf1Invite): Promise<void> {
  try {
    await refreshClock($)
    const vault = provisionVault({ groupId: m.groupId, memberId: m.memberId, now: clockNow(), ...(wf1 ? { join: { ownerKey: wf1.ownerKey, n: wf1.n, s: wf1.s, floor: wf1.floor } } : {}) })
    if (!vault) return
    await $.store.set(VAULT_KEY, vault)
  } catch { /* 聊天沒設定好不影響群組本身 */ }
}

/** 離開或被移出群組、或換了群組：金鑰和誰負責聊天的紀錄一起刪掉（目前這個對話的控制器也收掉） */
export async function chatWipe($: EngineInterface): Promise<void> {
  try {
    await disposeController()
    await $.store.delete(VAULT_KEY)
    await $.store.delete(LEASE_KEY)
  } catch { /* 刪不掉也要繼續 */ }
}

/** 複製邀請用：聊天準備好了就回這份邀請的 wf1: 文字（含這份邀請專屬的秘密），沒有就回 null（呼叫端用舊的連結） */
export async function chatInviteText($: EngineInterface, relay: string, invite: string): Promise<string | null> {
  try {
    const made = await controller?.makeInvite()
    if (!made) return null
    return formatWf1({ relay, invite, ownerKey: made.ownerKey, n: made.n, s: made.s, floor: made.floor })
  } catch { return null }
}

/** 群主踢人成功之後呼叫：記下被踢的人，不再因為中繼說他還在就留著他（沒有保管庫或不是群主就什麼都不做） */
export async function chatNoteRemoved(memberId: string): Promise<void> {
  try { await controller?.noteRemoved(memberId) } catch { /* 記不下來，下一次同步還是會因為他不在中繼名單而拿掉 */ }
}

/** 我的身分公鑰（給畫面或測試核對）；沒有保管庫就是 '' */
export async function chatIdentityKey($: EngineInterface): Promise<string> {
  try { const v = (await $.store.get(VAULT_KEY)) as { identitySeed?: unknown } | undefined; return typeof v?.identitySeed === 'string' ? publicKeyOf(v.identitySeed) : '' } catch { return '' }
}

/** 對話開始：排聊天的計時器、馬上問一次（register.tsx 的 session.start 呼叫；hook 同一個事件不能登記兩次，所以聊天不另外登記） */
export function chatSessionStart($: EngineInterface): void {
  conn = crypto.randomUUID()
  beat = 0
  holdsLease = false
  $.clock.every(CHAT_TICK_MS, () => { fire(chatTick($)) })
  fire(chatTick($, true))
}

/** 對話結束：還給租約、金鑰清零、畫面清空 */
export async function chatSessionEnd($: EngineInterface): Promise<void> {
  try {
    const had = holdsLease
    await disposeController()
    if (had) {
      // 只刪自己的：這時租約可能已經換到別的對話手上
      const cur = (await $.store.get(LEASE_KEY)) as { conn?: unknown } | undefined
      if (cur?.conn === conn) await $.store.delete(LEASE_KEY)
    }
  } catch { /* 收不乾淨也要結束 */ }
}

/** 聊天分頁被關掉 */
export function chatPaneClosed(id: string): void {
  if (id !== CHAT_PANE) return
  isChatPaneOpen = false
  controller?.setTabOpen(false)
}

/** 聊天分頁的畫面（requestId 'friends-chat'）：只讀記憶體 atom，畫的東西都來自 renderChatPane */
export const registerChat = (on: Parameters<Register>[0]): void => {
  on('ui.render', { component: 'Pane', requestId: 'friends-chat' }, async ($, e) => {
    const els = $.ui.resolve(e)
    const Input = (e.surface === 'desktop' || e.surface === 'terminal') && 'Input' in els ? els.Input : undefined
    if (!isChatPaneOpen) {
      isChatPaneOpen = true
      controller?.setTabOpen(true)
      fire(chatTick($, true))
    }
    const view = await read($, chatAtom)
    const lang = await read($, langAtom)
    const surface = e.surface === 'terminal' ? 'terminal' : e.surface === 'mobile' ? 'mobile' : 'desktop'
    return renderChatPane({ Box: els.Box, Text: els.Text, Button: els.Button, Input }, {
      view, lang, surface, rows: e.props.scroll ? e.props.scroll.bodyRows : 30, columns: e.props.bodyColumns ?? 40, now: await $.clock.now(), tzOffsetMin: -new Date().getTimezoneOffset(),
      actions: actionsFor($, lang),
    })
  })
}
