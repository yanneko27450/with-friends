// mod/hooks/chat-provision.ts
// CHAT-6：這台電腦第一次在這個群組用聊天時，產生聊天保管庫（身分金鑰、裝置金鑰、自己簽好的裝置清單、信任起點）。純函式，沒有 $。
//   群主（建立群組的人）：信任起點是自己的身分金鑰；另外產生邀請根秘密 R。
//   成員（用 wf1: 邀請加入）：信任起點是邀請裡的群主身分公鑰和版本下限；記下那份邀請的 n、s，之後送加入證明（chat-members.ts）。
// 用舊的連結（沒有 wf1:）加入的人沒有信任起點，不產生保管庫：聊天停在「要用新的邀請加入」（主人 11-05 定案第 2 題）。
import { toB64, validToken, wipe } from './chat-codec.ts'
import { MemberBook, publicKeyOf } from './chat-members.ts'
import type { Random } from './chat-members.ts'
import { deviceListBytes, Roster } from './chat-roster.ts'
import type { DeviceListV2 } from './chat-roster.ts'
import type { ChatVaultV1 } from './chat-vault.ts'
import { fromB64 } from './chat-codec.ts'
import { nobleEd25519Sign, nobleX25519PublicKey } from './noble-crypto.js'

/** 自己的裝置清單超過這麼久就重簽一份（版本 +1）：別人那邊 14 天沒看到新的就當過期（chat-roster.ts） */
export const DEVICE_LIST_REISSUE_MS = 7 * 24 * 3_600_000

const defaultRandom: Random = length => crypto.getRandomValues(new Uint8Array(length))
const randomB64 = (random: Random, length: number): string | null => {
  const bytes = random(length)
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) return null
  const out = toB64(bytes)
  wipe(bytes)
  return out
}

/** 用身分金鑰簽一份自己的裝置清單（只有這一台） */
export function signDeviceList(input: Readonly<{ userId: string; listVersion: number; issuedAt: number; identitySeed: string; device: Readonly<{ deviceId: string; signKey: string; encKey: string }> }>): DeviceListV2 | null {
  const seed = fromB64(input.identitySeed, 32)
  if (!seed) return null
  try {
    const unsigned = { version: 2 as const, userId: input.userId, listVersion: input.listVersion, issuedAt: input.issuedAt, devices: [{ deviceId: input.device.deviceId, signKey: input.device.signKey, encKey: input.device.encKey }] }
    return Object.freeze({ ...unsigned, signature: toB64(nobleEd25519Sign(deviceListBytes(unsigned), seed)) })
  } catch { return null } finally { wipe(seed) }
}

export type ProvisionInput = Readonly<{
  groupId: string
  memberId: string
  now: number
  random?: Random
  /** 群主：沒有 join；成員：wf1: 邀請裡的群主身分公鑰、n、s、版本下限 */
  join?: Readonly<{ ownerKey: string; n: string; s: string; floor: number }>
}>

/** 新的保管庫；任何一步失敗回 null（呼叫端就不存，聊天停在 setup-needed） */
export function provisionVault(input: ProvisionInput): ChatVaultV1 | null {
  const random = input.random ?? defaultRandom
  if (!validToken(input.groupId) || !validToken(input.memberId) || !Number.isSafeInteger(input.now) || input.now <= 0) return null
  const identitySeed = randomB64(random, 32)
  const signSeed = randomB64(random, 32)
  const encSeed = randomB64(random, 32)
  const deviceId = randomB64(random, 16)
  if (!identitySeed || !signSeed || !encSeed || !deviceId) return null
  const identityKey = publicKeyOf(identitySeed)
  const signKey = publicKeyOf(signSeed)
  const encBytes = fromB64(encSeed, 32)
  if (!identityKey || !signKey || !encBytes) return null
  let encKey = ''
  try { encKey = toB64(nobleX25519PublicKey(encBytes)) } catch { return null } finally { wipe(encBytes) }
  const ownList = signDeviceList({ userId: input.memberId, listVersion: 1, issuedAt: input.now, identitySeed, device: { deviceId, signKey, encKey } })
  const roster = Roster.create({ now: () => input.now })
  if (!ownList || !roster) return null
  const join = input.join
  const book = MemberBook.create({ groupId: input.groupId, self: { memberId: input.memberId, identityKey }, now: () => input.now },
    { version: 1, ownerKey: join ? join.ownerKey : identityKey, floor: join ? join.floor : 0, list: null, signedBy: '' })
  if (!book) return null
  if (join && (!fromB64(join.n, 16) || !fromB64(join.s, 32))) return null
  let owner: ChatVaultV1['owner'] = null
  if (!join) {
    const root = randomB64(random, 32)
    if (!root) return null
    owner = Object.freeze({ root, usedInvites: Object.freeze([]), removed: Object.freeze([]), listPublished: 0 })
  }
  return Object.freeze({
    version: 2 as const, groupId: input.groupId, memberId: input.memberId, identitySeed,
    book: book.snapshot(), owner, join: join ? Object.freeze({ n: join.n, s: join.s }) : null, inviteRoot: '',
    device: Object.freeze({ deviceId, signSeed, encSeed }),
    ownList, listPublished: 0, roster: roster.snapshot(),
    keyring: null, outbox: null, client: null, chains: null, tracker: null, replay: null, muted: Object.freeze([]), knownMembers: Object.freeze([]),
  })
}

/** 自己的裝置清單快過期了：同一台裝置、版本 +1、新的時間，用身分金鑰重簽；還新鮮就回 null */
export function reissueDeviceList(vault: ChatVaultV1, now: number): DeviceListV2 | null {
  const list = vault.ownList
  if (!list || now - list.issuedAt < DEVICE_LIST_REISSUE_MS) return null
  const device = list.devices.find(entry => entry.deviceId === vault.device.deviceId)
  if (!device) return null
  return signDeviceList({ userId: vault.memberId, listVersion: list.listVersion + 1, issuedAt: now, identitySeed: vault.identitySeed, device })
}
