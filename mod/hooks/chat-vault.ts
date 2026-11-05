// mod/hooks/chat-vault.ts
// CHAT-4W：這台裝置的聊天祕密與狀態（裝置私鑰、金鑰環、重放紀錄、待送信封、私訊換鑰會話…）的「形狀」和檢查。純函式，沒有 $、沒有保存。
// 保存本身是接線層的事（chat-register.tsx 的 vaultIO）；這裡只負責：形狀對不對、種子是不是 32 位元組、是不是這個群組這個成員的。
// ⚠ 內容含活的金鑰：0.6.0 放在外掛一般檔案（主人定；說明頁已寫同一台電腦的其他程式讀得到）。
// CHAT-6（v2）：多了身分金鑰、群主簽的成員身分清單（MemberBook）、群主的邀請根秘密、加入用的一次性邀請秘密；拿掉 ownerId（群主是誰只看已驗的清單）。
//   產生這份資料的是 chat-provision.ts（建立群組＝群主、用 wf1: 邀請加入＝成員）。v1 從來沒有產生過，一律當作沒有。
import type { ClientSnapshot } from './chat-client.ts'
import { fromB64, plain, validToken } from './chat-codec.ts'
import type { SendChainsSnapshot, SeqTrackerSnapshot } from './chat-frame.ts'
import type { KeyringSnapshot } from './chat-keys.ts'
import type { ReplaySnapshot } from './chat-replay.ts'
import type { BookSnapshot } from './chat-members.ts'
import type { DeviceListV2, RosterSnapshot } from './chat-roster.ts'
import type { OutboxSnapshot } from './chat-sync.ts'

export const VAULT_VERSION = 2 as const
/** 靜音名單的上限（每個私訊信箱一個代碼） */
export const MAX_MUTED = 64
/** 群主記住的用過的邀請編號、移出過的成員上限 */
const MAX_USED = 256

/** 群主才有：邀請根秘密 R（每份邀請的 s = HKDF(R, n)）、用過的邀請編號、移出過的成員、成員清單放上中繼到第幾版 */
export type OwnerState = Readonly<{ root: string; usedInvites: readonly string[]; removed: readonly string[]; listPublished: number }>
/** 用 wf1: 加入、群主還沒把我放進清單之前：那份邀請的 n 和 s（加入證明要用；放進清單後清掉） */
export type JoinState = Readonly<{ n: string; s: string }>

export type ChatVaultV1 = Readonly<{
  version: typeof VAULT_VERSION
  groupId: string
  /** 我在這個群組的成員代號（也是裝置清單的 userId） */
  memberId: string
  /** 身分簽章金鑰（Ed25519 種子）：簽自己的裝置清單；群主另外用它簽成員身分清單 */
  identitySeed: string
  /** 我信的群主金鑰、版本下限、最新一份已驗的成員身分清單 */
  book: BookSnapshot
  owner: OwnerState | null
  join: JoinState | null
  /** 成員：從清單解出來的邀請根秘密（複製邀請用；'' ＝還沒有） */
  inviteRoot: string
  device: Readonly<{ deviceId: string; /** Ed25519 簽章私鑰種子，32 位元組 base64url */ signSeed: string; /** X25519 私鑰，32 位元組 base64url */ encSeed: string }>
  /** 我自己簽好的裝置清單（尚未放上中繼就是 listPublished 小於它的版本） */
  ownList: DeviceListV2 | null
  listPublished: number
  roster: RosterSnapshot
  keyring: KeyringSnapshot | null
  outbox: OutboxSnapshot | null
  client: ClientSnapshot | null
  chains: SendChainsSnapshot | null
  tracker: SeqTrackerSnapshot | null
  replay: ReplaySnapshot | null
  muted: readonly string[]
  /** 群主用：上一次看到的成員代號（成員變動 → 換 epoch 要靠它比對，重啟後不能漏） */
  knownMembers: readonly string[]
}>

const KEYS = ['book', 'chains', 'client', 'device', 'groupId', 'identitySeed', 'inviteRoot', 'join', 'keyring', 'knownMembers', 'listPublished', 'memberId', 'muted', 'outbox', 'ownList', 'owner', 'replay', 'roster', 'tracker', 'version']

/**
 * 檢查取回來的東西是不是這個群組、這個成員的保管庫。只檢查最外層的形狀和祕密的長度；
 * 裡面的快照（金鑰環、名冊、鏈…）由各自的 create() 在組裝時再驗一次，壞掉的一律當作沒有保管庫。
 */
export function parseVault(value: unknown, expected: Readonly<{ groupId: string; memberId: string }>): ChatVaultV1 | null {
  const raw = plain(value, KEYS)
  if (!raw || raw.version !== VAULT_VERSION || raw.groupId !== expected.groupId || raw.memberId !== expected.memberId) return null
  if (!validToken(raw.groupId) || !validToken(raw.memberId) || !fromB64(raw.identitySeed, 32)) return null
  if (raw.inviteRoot !== '' && !fromB64(raw.inviteRoot, 32)) return null
  if (!raw.book || typeof raw.book !== 'object' || Array.isArray(raw.book)) return null
  if (raw.owner !== null) {
    const owner = plain(raw.owner, ['listPublished', 'removed', 'root', 'usedInvites'])
    if (!owner || !fromB64(owner.root, 32) || !Number.isSafeInteger(owner.listPublished) || (owner.listPublished as number) < 0) return null
    const used = owner.usedInvites
    const removed = owner.removed
    if (!Array.isArray(used) || used.length > MAX_USED || !used.every(n => fromB64(n, 16))) return null
    if (!Array.isArray(removed) || removed.length > MAX_USED || !removed.every(id => validToken(id))) return null
  }
  if (raw.join !== null) {
    const join = plain(raw.join, ['n', 's'])
    if (!join || !fromB64(join.n, 16) || !fromB64(join.s, 32)) return null
  }
  const device = plain(raw.device, ['deviceId', 'encSeed', 'signSeed'])
  if (!device || !validToken(device.deviceId) || !fromB64(device.signSeed, 32) || !fromB64(device.encSeed, 32)) return null
  if (!Number.isSafeInteger(raw.listPublished) || (raw.listPublished as number) < 0) return null
  const muted = raw.muted
  if (!Array.isArray(muted) || muted.length > MAX_MUTED || !muted.every(code => validToken(code))) return null
  const known = raw.knownMembers
  if (!Array.isArray(known) || known.length > 64 || !known.every(id => validToken(id))) return null
  if (!raw.roster || typeof raw.roster !== 'object') return null
  for (const name of ['ownList', 'keyring', 'outbox', 'client', 'chains', 'tracker', 'replay'] as const) {
    const part = raw[name]
    if (part !== null && (typeof part !== 'object' || Array.isArray(part))) return null
  }
  return raw as unknown as ChatVaultV1
}

/** 群組的成員或群主換了、或離開群組：舊保管庫不能拿給新的群組用 */
export const vaultMatches = (vault: ChatVaultV1 | null, groupId: string, memberId: string): boolean => !!vault && vault.groupId === groupId && vault.memberId === memberId
