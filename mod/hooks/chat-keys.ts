import {
  nobleEd25519Verify,
  nobleHkdfSha256,
  nobleX25519SharedSecret,
  nobleXChaCha20Poly1305Decrypt,
  nobleXChaCha20Poly1305Encrypt,
} from './noble-crypto.js'
import type { Roster } from './chat-roster.ts'
import { allZero, copyBytes, encoder, fail, fromB64, plain, safeCount, safePositive, toB64, validToken, wipe, type Fail } from './chat-codec.ts'

// CHAT3-CLIENT keys.
//  B1  Every message key is derived with the conversation type and context in the HKDF `info`, so a group ciphertext cannot be replayed as a DM
//      (or into another group / epoch), and a DM ciphertext cannot be moved to another mailbox or another recipient device.
//  B2  DM keys are per device pair: HKDF(X25519(sender device, recipient device)), directional (A->B differs from B->A).
//  A3  GroupKeyring: the group key has an epoch that only grows; a member joining or leaving gives a fresh random key (the old one is wiped), and the
//      new key is sealed separately for each target device (signed by the owner's device) so it can travel over any channel.

const SALT = encoder.encode('friends-chat/key-salt/v1')
const json = (value: readonly unknown[]): Uint8Array => encoder.encode(JSON.stringify(value))

export type DevicePair = Readonly<{ userId: string; deviceId: string }>

/** Key for one group message. `groupKey` is the epoch key held by the keyring. */
export function groupMessageKey(groupKey: Uint8Array, groupId: string, epoch: number): Uint8Array | null {
  if (!copyBytes(groupKey, 32) || !validToken(groupId) || !safeCount(epoch)) return null
  try { return nobleHkdfSha256(groupKey, SALT, json(['friends-chat/group-key/v1', groupId, epoch]), 32) } catch { return null }
}

export type DmKeyContext = Readonly<{ groupId: string; code: string; sender: DevicePair; recipient: DevicePair }>

/** DM key for the direction sender -> recipient. The sender passes its own X25519 private key and the recipient's public key; the recipient the reverse. */
export function dmMessageKey(ownEncPrivate: Uint8Array, otherEncPublicKey: string, context: DmKeyContext): Uint8Array | null {
  const other = fromB64(otherEncPublicKey, 32)
  if (!copyBytes(ownEncPrivate, 32) || !other || !validToken(context.groupId) || !validToken(context.code)
    || !validToken(context.sender.userId) || !validToken(context.sender.deviceId) || !validToken(context.recipient.userId) || !validToken(context.recipient.deviceId)) return null
  let shared: Uint8Array | null = null
  try {
    shared = nobleX25519SharedSecret(ownEncPrivate, other)
    if (allZero(shared)) return null
    return nobleHkdfSha256(shared, SALT, json(['friends-chat/dm-key/v1', context.groupId, context.code,
      context.sender.userId, context.sender.deviceId, context.recipient.userId, context.recipient.deviceId]), 32)
  } catch { return null } finally { wipe(shared) }
}

/**
 * Direct-message key for a REKEYED generation (B3): HKDF over the session key that chat-rekey.ts hands out, with the same context as the static key plus the
 * generation, so a key of one generation, mailbox or device pair never opens anything else. Generation 0 is the static key (dmMessageKey).
 */
export function dmRekeyedMessageKey(sessionKey: Uint8Array, context: DmKeyContext, generation: number): Uint8Array | null {
  const check = copyBytes(sessionKey, 32)
  wipe(check)
  if (!check || !safePositive(generation) || !validToken(context.groupId) || !validToken(context.code)
    || !validToken(context.sender.userId) || !validToken(context.sender.deviceId) || !validToken(context.recipient.userId) || !validToken(context.recipient.deviceId)) return null
  try {
    return nobleHkdfSha256(sessionKey, SALT, json(['friends-chat/dm-rekeyed-key/v1', context.groupId, context.code,
      context.sender.userId, context.sender.deviceId, context.recipient.userId, context.recipient.deviceId, generation]), 32)
  } catch { return null }
}

export type MembershipChange = Readonly<{ type: 'join' | 'leave' | 'kick'; userId: string }>
/** Largest epoch number: only rules out absurd values. Whoever can sign a package with a huge epoch is the group owner, and an owner who does that has already lost control of the group. */
export const MAX_EPOCH = 2_000_000_000
export type KeyringSnapshot = Readonly<{ version: 1; groupId: string; epoch: number; key: string | null; /** Highest epoch ever installed or made here; kept after wipe() so the epoch can never go back or be reused. */ highEpoch: number }>
type Random = (length: number) => Uint8Array
const defaultRandom: Random = length => crypto.getRandomValues(new Uint8Array(length))

export class GroupKeyring {
  readonly #groupId: string
  readonly #random: Random
  #epoch = 0
  #high = 0
  #key: Uint8Array | null = null
  private constructor(groupId: string, random: Random) { this.#groupId = groupId; this.#random = random }

  static create(options: Readonly<{ groupId: string; random?: Random }>, snapshot?: KeyringSnapshot): GroupKeyring | null {
    if (!options || !validToken(options.groupId) || (options.random !== undefined && typeof options.random !== 'function')) return null
    const keyring = new GroupKeyring(options.groupId, options.random ?? defaultRandom)
    if (snapshot === undefined) return keyring
    const raw = plain(snapshot, ['epoch', 'groupId', 'highEpoch', 'key', 'version'])
    if (!raw || raw.version !== 1 || raw.groupId !== options.groupId || !safeCount(raw.epoch) || !safeCount(raw.highEpoch)
      || raw.highEpoch > MAX_EPOCH || raw.highEpoch < raw.epoch) return null
    keyring.#high = raw.highEpoch
    if (raw.key === null) { if (raw.epoch !== 0) return null; return keyring }
    const key = fromB64(raw.key, 32)
    if (!key || allZero(key) || raw.epoch < 1) return null
    keyring.#epoch = raw.epoch
    keyring.#key = key
    return keyring
  }

  get groupId(): string { return this.#groupId }
  get epoch(): number { return this.#key ? this.#epoch : 0 }
  get hasKey(): boolean { return this.#key !== null }
  /** The highest epoch this keyring ever held. A key package below this (or equal) is a replay or a downgrade; pass `highEpoch + 1` as `minEpoch` to openEpochKey. */
  get highEpoch(): number { return this.#high }

  /** A copy of the current epoch key; the caller wipes it after use. */
  current(): Readonly<{ epoch: number; key: Uint8Array }> | null {
    return this.#key ? Object.freeze({ epoch: this.#epoch, key: new Uint8Array(this.#key) }) : null
  }

  /** Installs a key received from the owner. Only a higher epoch is accepted; the previous key is zeroed first. */
  install(epoch: number, key: Uint8Array): 'ok' | 'stale-epoch' | 'format' {
    const copy = copyBytes(key, 32)
    if (!copy || allZero(copy) || !safePositive(epoch) || epoch > MAX_EPOCH) { wipe(copy); return 'format' }
    if (epoch <= this.#high) { wipe(copy); return 'stale-epoch' } // also after wipe(): the floor does not go away with the key
    wipe(this.#key)
    this.#key = copy
    this.#epoch = epoch
    this.#high = epoch
    return 'ok'
  }

  /** Owner only: a fresh random key under the next epoch (first key: epoch 1). The old key is zeroed. Returns a copy for distribution, or null if the RNG failed. */
  rotate(): Readonly<{ epoch: number; key: Uint8Array }> | null {
    let fresh: Uint8Array
    try {
      const drawn = this.#random(32)
      const copy = copyBytes(drawn, 32)
      wipe(drawn)
      if (!copy || allZero(copy)) return null
      fresh = copy
    } catch { return null }
    const epoch = this.#high + 1
    if (epoch > MAX_EPOCH) { wipe(fresh); return null }
    wipe(this.#key)
    this.#key = fresh
    this.#epoch = epoch
    this.#high = epoch
    return Object.freeze({ epoch, key: new Uint8Array(fresh) })
  }

  /** Joining, leaving and being removed ALL start a new epoch (A3): a joiner never receives an old key, a leaver never receives the next one. */
  onMembership(change: MembershipChange): Readonly<{ epoch: number; key: Uint8Array }> | null {
    if (!change || (change.type !== 'join' && change.type !== 'leave' && change.type !== 'kick') || !validToken(change.userId)) return null
    return this.rotate()
  }

  wipe(): void { wipe(this.#key); this.#key = null }

  /** Contains the live epoch key: keep it where Claude cannot read it. */
  snapshot(): KeyringSnapshot {
    return Object.freeze({ version: 1 as const, groupId: this.#groupId, epoch: this.#key ? this.#epoch : 0, key: this.#key ? toB64(this.#key) : null, highEpoch: this.#high })
  }
}

// ---- epoch key packages ----------------------------------------------------------------------------------------------------------------

export type EpochKeyPackage = Readonly<{
  version: 1
  groupId: string
  epoch: number
  from: DevicePair
  to: DevicePair
  createdAt: number
  nonce: string
  ciphertext: string
  signature: string
}>
type PackageHeader = Omit<EpochKeyPackage, 'signature' | 'ciphertext' | 'nonce'>

const packageAad = (h: PackageHeader): Uint8Array => json(['friends-chat/epoch-aad/v1', h.version, h.groupId, h.epoch, h.from.userId, h.from.deviceId, h.to.userId, h.to.deviceId, h.createdAt])
export const epochPackageBytes = (p: Omit<EpochKeyPackage, 'signature'>): Uint8Array => json([
  'friends-chat/epoch-package/v1', p.version, p.groupId, p.epoch, p.from.userId, p.from.deviceId, p.to.userId, p.to.deviceId, p.createdAt, p.nonce, p.ciphertext,
])
const packageKey = (shared: Uint8Array, h: PackageHeader): Uint8Array =>
  nobleHkdfSha256(shared, SALT, json(['friends-chat/epoch-key/v1', h.groupId, h.epoch, h.from.userId, h.from.deviceId, h.to.userId, h.to.deviceId]), 32)

export type SealEpochKeyInput = Readonly<{
  groupId: string
  epoch: number
  key: Uint8Array
  from: DevicePair & Readonly<{ encPrivate: Uint8Array; sign(message: Uint8Array): Uint8Array }>
  to: DevicePair & Readonly<{ encKey: string }>
  createdAt: number
  random?: Random
}>

/** Seals the epoch key for ONE target device. Returns null on any bad input or primitive failure. */
export function sealEpochKey(input: SealEpochKeyInput): EpochKeyPackage | null {
  if (!input || !input.to || !input.from) return null
  const key = copyBytes(input.key, 32)
  const recipient = fromB64(input.to.encKey, 32)
  if (!key || !recipient || allZero(key) || !validToken(input.groupId) || !safePositive(input.epoch) || input.epoch > MAX_EPOCH || !safePositive(input.createdAt)
    || !validToken(input.from.userId) || !validToken(input.from.deviceId) || !validToken(input.to.userId) || !validToken(input.to.deviceId)
    || !copyBytes(input.from.encPrivate, 32) || typeof input.from.sign !== 'function') { wipe(key); return null }
  const random = input.random ?? defaultRandom
  let shared: Uint8Array | null = null
  let messageKey: Uint8Array | null = null
  try {
    const header: PackageHeader = { version: 1, groupId: input.groupId, epoch: input.epoch, from: { userId: input.from.userId, deviceId: input.from.deviceId },
      to: { userId: input.to.userId, deviceId: input.to.deviceId }, createdAt: input.createdAt }
    shared = nobleX25519SharedSecret(input.from.encPrivate, recipient)
    if (allZero(shared)) return null
    messageKey = packageKey(shared, header)
    const nonceBytes = copyBytes(random(24), 24)
    if (!nonceBytes || allZero(nonceBytes)) return null
    const ciphertext = toB64(nobleXChaCha20Poly1305Encrypt(messageKey, nonceBytes, key, packageAad(header)))
    const unsigned = { ...header, nonce: toB64(nonceBytes), ciphertext }
    const signature = copyBytes(Reflect.apply(input.from.sign, undefined, [epochPackageBytes(unsigned)]), 64)
    if (!signature) return null
    return Object.freeze({ ...unsigned, signature: toB64(signature) })
  } catch { return null } finally { wipe(key, shared, messageKey) }
}

/** Longest a key package may sit before it is opened. Packages are small and the epoch floor stops replays; the cap keeps a leaked old package from being usable for long. */
export const EPOCH_PACKAGE_MAX_AGE_MS = 7 * 24 * 3_600_000
export type OpenEpochKeyFailure = 'format' | 'trust' | 'unknown-device' | 'signature' | 'time' | 'ciphertext' | 'adapter' | 'stale-epoch'
export type OpenEpochKeyInput = Readonly<{
  value: unknown
  groupId: string
  /** Only a package from this user (the group owner) is accepted. */
  ownerUserId: string
  roster: Roster
  me: DevicePair & Readonly<{ encPrivate: Uint8Array }>
  now: number
  /** Packages older than this (at most EPOCH_PACKAGE_MAX_AGE_MS) or from the future by more than maxFutureSkewMs are refused. */
  maxAgeMs: number
  /** The lowest epoch worth installing: `keyring.highEpoch + 1`. Without it a replayed old package (still validly signed) could downgrade a device whose key was wiped. A device with no history at all has no floor here; give it one from the invitation. */
  minEpoch: number
  maxFutureSkewMs: number
  verify?: (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean
}>

export function openEpochKey(input: OpenEpochKeyInput): Readonly<{ ok: true; epoch: number; key: Uint8Array }> | Fail<OpenEpochKeyFailure> {
  if (!input || typeof input !== 'object' || !input.me || !input.roster || !safePositive(input.minEpoch)) return fail('format')
  const raw = plain(input.value, ['ciphertext', 'createdAt', 'epoch', 'from', 'groupId', 'nonce', 'signature', 'to', 'version'])
  const from = raw && plain(raw.from, ['deviceId', 'userId'])
  const to = raw && plain(raw.to, ['deviceId', 'userId'])
  if (!raw || !from || !to || raw.version !== 1 || !validToken(raw.groupId) || !safePositive(raw.epoch) || !safePositive(raw.createdAt)
    || !validToken(from.userId) || !validToken(from.deviceId) || !validToken(to.userId) || !validToken(to.deviceId)
    || !fromB64(raw.nonce, 24) || !fromB64(raw.ciphertext, 32 + 16) || !fromB64(raw.signature, 64)
    || !copyBytes(input.me.encPrivate, 32) || !safePositive(input.now) || !safePositive(input.maxAgeMs) || input.maxAgeMs > EPOCH_PACKAGE_MAX_AGE_MS
    || !safeCount(input.maxFutureSkewMs) || (raw.epoch as number) > MAX_EPOCH) return fail('format')
  if (raw.groupId !== input.groupId || from.userId !== input.ownerUserId || to.userId !== input.me.userId || to.deviceId !== input.me.deviceId) return fail('trust')
  if ((raw.epoch as number) < input.minEpoch) return fail('stale-epoch')
  if ((raw.createdAt as number) < input.now - input.maxAgeMs || (raw.createdAt as number) > input.now + input.maxFutureSkewMs) return fail('time')
  const sender = input.roster.device(from.userId as string, from.deviceId as string)
  if (!sender) return fail('unknown-device')
  const header: PackageHeader = { version: 1, groupId: raw.groupId, epoch: raw.epoch as number, from: { userId: from.userId as string, deviceId: from.deviceId as string },
    to: { userId: to.userId as string, deviceId: to.deviceId as string }, createdAt: raw.createdAt as number }
  const unsigned = { ...header, nonce: raw.nonce as string, ciphertext: raw.ciphertext as string }
  const verify = input.verify ?? nobleEd25519Verify
  try {
    const verified = Reflect.apply(verify, undefined, [fromB64(raw.signature, 64)!, epochPackageBytes(unsigned), fromB64(sender.signKey, 32)!])
    if (verified === false) return fail('signature')
    if (verified !== true) return fail('adapter')
  } catch { return fail('adapter') }
  let shared: Uint8Array | null = null
  let messageKey: Uint8Array | null = null
  try {
    shared = nobleX25519SharedSecret(input.me.encPrivate, fromB64(sender.encKey, 32)!)
    if (allZero(shared)) return fail('ciphertext')
    messageKey = packageKey(shared, header)
    const opened = nobleXChaCha20Poly1305Decrypt(messageKey, fromB64(raw.nonce, 24)!, fromB64(raw.ciphertext, 48)!, packageAad(header))
    const key = copyBytes(opened, 32)
    wipe(opened)
    if (!key || allZero(key)) return fail('ciphertext')
    return Object.freeze({ ok: true as const, epoch: header.epoch, key })
  } catch { return fail('ciphertext') } finally { wipe(shared, messageKey) }
}

/** Seals the key for every accepted device of the given users (except the sender's own device). Users with no accepted device list are returned in `missing`. */
export function sealEpochKeyForMembers(input: Omit<SealEpochKeyInput, 'to'> & Readonly<{ userIds: readonly string[]; roster: Roster; /** Users who must NOT receive the key (the one who just left or was removed): they are skipped even if listed. */ exclude?: readonly string[] }>): Readonly<{ packages: readonly EpochKeyPackage[]; missing: readonly string[] }> {
  const packages: EpochKeyPackage[] = []
  const missing: string[] = []
  for (const userId of input.userIds) {
    if (input.exclude?.includes(userId)) continue
    const devices = input.roster.devices(userId).filter(device => !(userId === input.from.userId && device.deviceId === input.from.deviceId))
    if (devices.length === 0 && !(userId === input.from.userId)) { missing.push(userId); continue }
    for (const device of devices) {
      const sealed = sealEpochKey({ ...input, to: { userId, deviceId: device.deviceId, encKey: device.encKey } })
      if (sealed) packages.push(sealed); else missing.push(`${userId}/${device.deviceId}`)
    }
  }
  return Object.freeze({ packages: Object.freeze(packages), missing: Object.freeze(missing) })
}

