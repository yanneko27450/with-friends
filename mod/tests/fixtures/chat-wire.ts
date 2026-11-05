// CHAT-4W 測試共用：假中繼（簽章驗得過的回應）、預先佈建好的保管庫、對方 (alice) 的真聊天用戶端。
// 被測的這一邊是 bob：register.tsx 引用的 chat-register.tsx＋控制器＋畫面，全部是真程式；對方用真的 ChatClient 加密簽章。
// 保管庫（金鑰與快照）預先放在 $.store 的 chatVaultV1，等於「佈建」好的樣子；產品裡產生保管庫的流程不在 CHAT-4W 這張卡。
import { CHAT_REPLAY_WINDOW_MS, ChatClient } from '../../hooks/chat-client.ts'
import type { ChatTransport } from '../../hooks/chat-client.ts'
import { CHAT_REQUIRED } from '../../hooks/chat-capability'
import { createMemoryChatUniquenessStore } from '../../hooks/chat-envelope.ts'
import { SendChains, SeqTracker } from '../../hooks/chat-frame.ts'
import { GroupKeyring } from '../../hooks/chat-keys.ts'
import { createPersistentReplayStore } from '../../hooks/chat-replay.ts'
import { MemberBook, signMemberList } from '../../hooks/chat-members.ts'
import { deviceListBytes, Roster } from '../../hooks/chat-roster.ts'
import { nobleEd25519Sign, nobleX25519PublicKey } from '../../hooks/noble-crypto.js'
import { responseEnvelope } from '../../hooks/response-signing'
import { SEC16B_TEST_KEY } from './sec-16b-test-key'

export const ORIGIN = 'https://relay.test'
/** 私訊信箱代碼（中繼產生的 22 個字） */
export const DM_CODE = 'abcdefghijklmnopqrstuv'
export const GROUP = 'g1'
const hex = (value: string): Uint8Array => {
  const out = new Uint8Array(value.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return out
}
export const b64 = (value: Uint8Array): string => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64 = (value: string): Uint8Array => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0))

// 固定金鑰（種子與公鑰在外面算好，chat-client.test.ts 同一組）
export const alice = {
  identity: { seed: hex('eb1be37e716a03011b3c0905d2f5c9158b75b037d5c82de4856090f434122f36'), pub: hex('0b51092a88cffe42c7e77bab2c4848876497e3240cdac41820533c434d4c7329') },
  laptop: { seed: hex('07a7d6760b8e956da1e3bddc4166d7d4f1e454ff70c6b72cd9e4869b56e66a9c'), pub: hex('7eb49bc90e36416db27ce44d273dc985f2cc402b229c483dfbacfcd364cdc6ae') },
  enc: hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4'),
}
export const bob = {
  identity: { seed: hex('2b78fbf20bd0d96def4e2527cf0e711f57d39edc243171ec019d0a31c682a653'), pub: hex('5d130fa04ca18d7005b75ed5a4c2dcf48ee80e494c25b67108b7fecc500c27b7') },
  laptop: { seed: hex('170927a99ee33a58caed5b97b202a81344367b3c81b04217e4ee6ce09c8ce0a7'), pub: hex('5a1dd6e9dbf7dd05800240fa18ccf078d235baeab3a8f66dee735af77d83120e') },
  enc: hex('4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d'),
}
export const EPOCH_KEY = hex('11'.repeat(32))
const NOW = Date.now()

const listOf = (userId: string, deviceId: string, person: typeof alice | typeof bob) => {
  const unsigned = { version: 2 as const, userId, listVersion: 1, issuedAt: NOW, devices: [{ deviceId, signKey: b64(person.laptop.pub), encKey: b64(nobleX25519PublicKey(person.enc)) }] }
  return { ...unsigned, signature: b64(nobleEd25519Sign(deviceListBytes(unsigned), person.identity.seed)) }
}
export const aliceList = listOf('alice', 'alice-laptop', alice)
export const bobList = listOf('bob', 'bob-laptop', bob)
/** CHAT-6：alice（群主）簽的成員身分清單：alice 和 bob；bob 的保管庫從這份開始信任 */
export const memberList = signMemberList({ groupId: GROUP, listVersion: 1, issuedAt: NOW, ownerId: 'alice', members: [{ memberId: 'alice', identityKey: b64(alice.identity.pub) }, { memberId: 'bob', identityKey: b64(bob.identity.pub) }], inviteRoot: null }, b64(alice.identity.seed))!

/** bob（被測的這台電腦）預先佈建好的保管庫：認得 alice 的身分金鑰與清單、拿著 epoch 1 的群組金鑰 */
export function bobVault(options: { aliceList?: boolean } = {}) {
  const roster = Roster.create({ now: () => Date.now() })!
  roster.pin('alice', b64(alice.identity.pub))
  if (options.aliceList !== false) roster.acceptList(aliceList)
  const book = MemberBook.create({ groupId: GROUP, self: { memberId: 'bob', identityKey: b64(bob.identity.pub) }, now: () => Date.now() },
    { version: 1, ownerKey: b64(alice.identity.pub), floor: 1, list: memberList, signedBy: b64(alice.identity.pub) })!
  return {
    version: 2, groupId: GROUP, memberId: 'bob', identitySeed: b64(bob.identity.seed), book: book.snapshot(), owner: null, join: null, inviteRoot: '',
    device: { deviceId: 'bob-laptop', signSeed: b64(bob.laptop.seed), encSeed: b64(bob.enc) },
    ownList: bobList, listPublished: 1, roster: roster.snapshot(),
    keyring: { version: 1, groupId: GROUP, epoch: 1, key: b64(EPOCH_KEY), highEpoch: 1 },
    outbox: null, client: null, chains: null, tracker: null, replay: null, muted: [], knownMembers: ['alice', 'bob'],
  }
}

// ---- 假中繼 ----
const signingSeed = fromB64(SEC16B_TEST_KEY.privateKeyPkcs8).slice(-32)
type Mail = { sequence: number; expiresAt: number; envelope: unknown }

export type Capability = 'ok' | 'old' | 'disabled' | 'bad-signature' | 'bad-body' | 'wire' | 'no-features' | 'server-error'
export type RelayState = {
  aliceName: string
  group: Mail[]
  sequence: number
  publishStatus: number
  hostileError: string
  capability: Capability
  /** true＝聊天路由（/chat/*、/dm/*）全部回 403 chat-disabled（聊天總開關關著，但 /capability 還沒反映） */
  chatDisabled: boolean
  /** true＝聊天路由的回應簽章是壞的（中間人或壞掉的中繼） */
  badChatSignature: boolean
  /** alice 跟 bob 有沒有已經成為私訊好友（有＝/dm/list 回一個 active 的連結） */
  dmOn: boolean
  dm: Mail[]
  /** alice 有沒有把裝置清單放上中繼（沒有＝對方外掛太舊或還沒準備好） */
  aliceHasList: boolean
  /** 收到的請求（路徑），測試用來斷言「沒碰過聊天路由」 */
  paths: string[]
}
export const newRelayState = (): RelayState => ({ aliceName: 'alice-initial', group: [], sequence: 0, publishStatus: 200, hostileError: '', capability: 'ok', chatDisabled: false, badChatSignature: false, dmOn: false, dm: [], aliceHasList: true, paths: [] })

export function replyOf(state: RelayState, url: string, init: unknown): { status: number; text: string; headers: Record<string, string> } {
  const u = new URL(url)
  const i = init as { method?: string; headers?: Record<string, string>; body?: string } | undefined
  const method = i?.method ?? 'GET'
  const body = i?.body ? JSON.parse(i.body) as Record<string, unknown> : {}
  const path = u.pathname
  state.paths.push(path)
  const members = [
    { id: 'alice', name: state.aliceName, isMe: false, isOwner: true, presence: 'idle', action: '', subject: '', activityAgoSec: null, seenAgoSec: 1 },
    { id: 'bob', name: 'Me', isMe: true, isOwner: false, presence: 'idle', action: '', subject: '', activityAgoSec: null, seenAgoSec: 1 },
  ]
  let status = 200
  let data: unknown = { ok: true }
  let text: string | undefined
  if (path === '/capability') {
    const chat = { enabled: true, wire: [2], maxCiphertextBytes: 2048, features: [...CHAT_REQUIRED.features] }
    if (state.capability === 'old') { status = 404; data = { error: 'not found' } }
    else if (state.capability === 'server-error') { status = 503; data = { error: 'busy' } }
    else if (state.capability === 'disabled') data = { v: 1, chat: { ...chat, enabled: false }, ttlSec: 600 }
    else if (state.capability === 'wire') data = { v: 1, chat: { ...chat, wire: [3] }, ttlSec: 600 }
    else if (state.capability === 'no-features') data = { v: 1, chat: { ...chat, features: ['mailbox'] }, ttlSec: 600 }
    else if (state.capability === 'bad-body') text = '{"v":1,"chat":"yes"}'
    else data = { v: 1, relayVersion: '0.6.0', chat, ttlSec: 600 }
  } else if (path === '/status') data = { ok: true, groupName: 'Study', members }
  else if (path === '/friends') data = { groupName: 'Study', members }
  else if (path.startsWith('/chat/') || path.startsWith('/dm/')) {
    if (state.chatDisabled) { status = 403; data = { error: '聊天功能目前關閉', reason: 'chat-disabled' } }
    else if (path === '/chat/roster/put') data = { ok: true, listVersion: 1, serverTime: Date.now() }
    else if (path === '/chat/roster/get') data = { rosters: [...(state.aliceHasList ? [{ memberId: 'alice', list: aliceList, storedAt: Date.now() }] : []), { memberId: 'bob', list: bobList, storedAt: Date.now() }], serverTime: Date.now() }
    else if (path === '/chat/epoch/get') data = { packets: [], serverTime: Date.now() }
    else if (path === '/chat/members/get') data = { list: memberList, serverTime: Date.now() }
    else if (path === '/chat/join/put') data = { ok: true }
    else if (path === '/chat/poll') data = { messages: state.group.filter(m => m.sequence > Number(body.after ?? 0)) }
    else if (path === '/chat/publish') {
      if (state.publishStatus !== 200) { status = state.publishStatus; data = { error: state.hostileError, reason: 'unreachable' } } else {
        const sequence = ++state.sequence
        state.group.push({ sequence, expiresAt: Date.now() + 3_600_000, envelope: body.envelope })
        data = { ok: true, sequence, expiresAt: Date.now() + 3_600_000 }
      }
    } else if (path === '/dm/list') data = { links: state.dmOn ? [{ peer: 'alice', state: 'active', code: DM_CODE }] : [] }
    else if (path === '/dm/poll') {
      const boxes: Record<string, { messages: Mail[] }> = {}
      for (const item of (body.boxes as { code: string; after: number }[] | undefined) ?? []) if (item.code === DM_CODE) boxes[DM_CODE] = { messages: state.dm.filter(m => m.sequence > Number(item.after ?? 0)) }
      data = { boxes }
    } else if (path === '/dm/send') {
      const sequence = ++state.sequence
      state.dm.push({ sequence, expiresAt: Date.now() + 3_600_000, envelope: body.envelope })
      data = { ok: true, sequence, expiresAt: Date.now() + 3_600_000 }
    }
  }
  text ??= JSON.stringify(data)
  const nonce = i?.headers?.['x-friends-nonce'] ?? ''
  const signature = b64(nobleEd25519Sign(responseEnvelope({ nonce, origin: ORIGIN, method, path, status, body: text }), signingSeed))
  const headers: Record<string, string> = { 'x-friends-nonce': nonce, 'x-friends-key-id': SEC16B_TEST_KEY.keyId, 'x-friends-signature': (state.capability === 'bad-signature' && path === '/capability') || (state.badChatSignature && (path.startsWith('/chat/') || path.startsWith('/dm/'))) ? 'A'.repeat(86) : signature }
  return { status, text, headers }
}

/** alice 的聊天用戶端：用同一把 epoch 金鑰、真的加密簽章，信封放進假中繼的信箱 */
export function aliceSender(state: RelayState) {
  const now = () => Date.now()
  const roster = Roster.create({ now })!
  roster.pin('alice', b64(alice.identity.pub)); roster.pin('bob', b64(bob.identity.pub))
  roster.acceptList(aliceList); roster.acceptList(bobList)
  const keyring = GroupKeyring.create({ groupId: GROUP })!
  keyring.install(1, EPOCH_KEY)
  const replay = createPersistentReplayStore({ windowMs: CHAT_REPLAY_WINDOW_MS, now, save: () => {} })!
  const client = ChatClient.create({
    groupId: GROUP, me: { userId: 'alice', deviceId: 'alice-laptop', encPrivate: alice.enc, sign: m => nobleEd25519Sign(m, alice.laptop.seed) },
    roster, keyring, sendChains: SendChains.create()!, tracker: SeqTracker.create()!, replay, sent: createMemoryChatUniquenessStore(), now, persistPending: () => {},
  })!
  const transport: ChatTransport = {
    publish: async envelope => { state.group.push({ sequence: ++state.sequence, expiresAt: Date.now() + 3_600_000, envelope }); return { ok: true } },
    dmSend: async (_code, envelope) => { state.dm.push({ sequence: ++state.sequence, expiresAt: Date.now() + 3_600_000, envelope }); return { ok: true } },
    poll: async () => ({ ok: true, messages: [] }), dmPoll: async () => ({ ok: true, boxes: {} }),
  }
  const group = async (text: string) => {
    const result = await client.sendGroup(transport, text, { confirmedSecret: true })
    if (!result.ok) throw new Error('alice could not send: ' + result.reason)
  }
  const dm = async (text: string) => {
    state.dmOn = true
    const result = await client.sendDm(transport, { code: DM_CODE, peerUserId: 'bob', text, confirmedSecret: true })
    if ('ok' in result && result.ok === false && !('results' in result)) throw new Error('alice could not send a dm: ' + result.reason)
  }
  return Object.assign(group, { group, dm })
}

export const PANE_PROPS = { title: 'Chat', isFocused: false, bodyColumns: 40, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
export const MEMBERSHIP = { relay: ORIGIN, groupId: GROUP, groupName: 'Study', memberId: 'bob', memberKey: 'k-bob', invite: 'g1-invite', inviteGeneration: 0, isOwner: false, name: 'Me' }
export const TRUST = { mode: 'pinned', origins: { [ORIGIN]: { keyId: SEC16B_TEST_KEY.keyId, publicKey: SEC16B_TEST_KEY.publicKey } } }
