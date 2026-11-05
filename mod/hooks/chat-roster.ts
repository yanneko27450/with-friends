import { nobleEd25519Verify, nobleSha256 } from './noble-crypto.js'
import { encoder, fail, fromB64, plain, safeCount, safePositive, toB64, validToken, type Fail } from './chat-codec.ts'

// A5 (CHAT3-CLIENT): a receiver learns a sender device's keys ONLY from a device list that the user's identity key signed.
// The relay's /chat/device registry, an envelope's own fields and a roster the relay hands out are never a source of trust.
//
// DeviceListV2 = { version: 2, userId, listVersion, issuedAt, devices: [{ deviceId, signKey, encKey }], signature }
//   signKey = the device's Ed25519 signing public key, encKey = its X25519 public key (43-character base64url each).
//   The identity key signs the WHOLE list including `issuedAt` (ms), so a relay cannot alter a list or splice devices into it, a list older than one
//   already seen is refused (rollback), and a list older than DEVICE_LIST_MAX_AGE_MS counts for nothing (expired): a relay that withholds a newer list
//   (a revoked device stays trusted) can do so for at most 14 days, then the sender's devices stop being trusted until a fresh list arrives. That narrows the
//   window; it does not close it. V1 (no issuedAt) is not accepted at all: it was never released and could not expire.
//   The first list seen for a user has no version floor of its own: `pin(userId, key, minListVersion)` takes the floor from the friend-adding flow.
//   `userId` is the member id of the group (0.6.0: identities live inside one group).

/** CHAT-5R: one number for the whole product - the relay refuses a roster, a chat device registration or epoch packets beyond 5 devices per member (relay/core.mjs CHAT_MAX_DEVICES). */
export const MAX_DEVICES_PER_USER = 5
/** A list not re-issued for this long is expired (the owner of the identity key must sign a new one, listVersion + 1). */
export const DEVICE_LIST_MAX_AGE_MS = 14 * 24 * 3_600_000
/** A list claiming to be issued further ahead than this (the relay checks issuedAt within one hour of its clock as well) is refused. */
export const DEVICE_LIST_MAX_FUTURE_MS = 3_600_000
const DEVICE_LIST_DOMAIN = 'with-friends device-list v2'
const MAX_LIST_VERSION = 2 ** 31

export type DeviceEntry = Readonly<{ deviceId: string; signKey: string; encKey: string }>
export type DeviceListV2 = Readonly<{ version: 2; userId: string; listVersion: number; issuedAt: number; devices: readonly DeviceEntry[]; signature: string }>

export const deviceListBytes = (list: Omit<DeviceListV2, 'signature'>): Uint8Array => encoder.encode(JSON.stringify([
  DEVICE_LIST_DOMAIN, list.version, list.userId, list.listVersion, list.issuedAt, list.devices.map(device => [device.deviceId, device.signKey, device.encKey]),
]))

export type RosterFailure = 'format' | 'unknown-user' | 'signature' | 'rollback' | 'conflict' | 'adapter' | 'expired' | 'time'
export type RosterAccept = Readonly<{ ok: true; changed: boolean; listVersion: number }> | Fail<RosterFailure>
export type ListStatus = 'none' | 'fresh' | 'expired'

export type RosterSnapshot = Readonly<{
  version: 1
  users: readonly Readonly<{ userId: string; identityKey: string; minListVersion: number; list: DeviceListV2 | null }>[]
}>

type Verifier = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean
type UserEntry = { identityKey: string; minListVersion: number; list: DeviceListV2 | null; digest: string }

const listSnapshot = (value: unknown): DeviceListV2 | null => {
  const raw = plain(value, ['devices', 'issuedAt', 'listVersion', 'signature', 'userId', 'version'])
  if (!raw || raw.version !== 2 || !validToken(raw.userId) || !safePositive(raw.listVersion) || raw.listVersion > MAX_LIST_VERSION || !safePositive(raw.issuedAt)
    || !fromB64(raw.signature, 64)) return null
  const devices = raw.devices
  if (!Array.isArray(devices) || devices.length < 1 || devices.length > MAX_DEVICES_PER_USER) return null
  const entries: DeviceEntry[] = []
  const signKeys = new Set<string>()
  const encKeys = new Set<string>()
  for (let index = 0; index < devices.length; index++) {
    const device = plain(devices[index], ['deviceId', 'encKey', 'signKey'])
    if (!device || !validToken(device.deviceId) || !fromB64(device.signKey, 32) || !fromB64(device.encKey, 32)) return null
    const previous = entries[index - 1]
    if (previous && !(previous.deviceId < device.deviceId)) return null // sorted, no duplicates: one byte sequence per list
    const signKey = device.signKey as string
    const encKey = device.encKey as string
    if (signKeys.has(signKey) || encKeys.has(encKey)) return null // one key, one device
    signKeys.add(signKey)
    encKeys.add(encKey)
    entries.push(Object.freeze({ deviceId: device.deviceId, signKey, encKey }))
  }
  return Object.freeze({ version: 2 as const, userId: raw.userId, listVersion: raw.listVersion, issuedAt: raw.issuedAt, devices: Object.freeze(entries), signature: raw.signature as string })
}

export class Roster {
  readonly #verify: Verifier
  readonly #now: () => number
  readonly #users = new Map<string, UserEntry>()

  private constructor(verify: Verifier, now: () => number) { this.#verify = verify; this.#now = now }

  /**
   * `now` is the local wall clock (never taken from a message or the relay). Returns null for a malformed snapshot: every stored list is verified again
   * against its pinned identity key (age is not checked on restore: an expired list simply stays expired). Pass `undefined`, not `null`, for "nothing stored yet".
   */
  static create(options: Readonly<{ now: () => number; verify?: Verifier }>, snapshot?: RosterSnapshot): Roster | null {
    if (!options || typeof options.now !== 'function' || (options.verify !== undefined && typeof options.verify !== 'function')) return null
    const roster = new Roster(options.verify ?? nobleEd25519Verify, options.now)
    if (snapshot === undefined) return roster
    const raw = plain(snapshot, ['users', 'version'])
    if (!raw || raw.version !== 1 || !Array.isArray(raw.users)) return null
    for (const stored of raw.users) {
      const entry = plain(stored, ['identityKey', 'list', 'minListVersion', 'userId'])
      if (!entry || !validToken(entry.userId) || !safeCount(entry.minListVersion) || roster.pin(entry.userId, entry.identityKey as string, entry.minListVersion) !== 'pinned') return null
      if (entry.list !== null && !roster.#accept(entry.list, false).ok) return null
    }
    return roster
  }

  /**
   * Pins the identity public key of a user (when the friend is added) and the lowest list version worth believing (from the invitation; 0 = none).
   * A second, different key is refused: `repin` is the explicit way. The same key again may raise the floor, never lower it.
   */
  pin(userId: string, identityKey: string, minListVersion = 0): 'pinned' | 'same' | 'identity-changed' | 'format' {
    if (!validToken(userId) || !fromB64(identityKey, 32) || !safeCount(minListVersion) || minListVersion > MAX_LIST_VERSION) return 'format'
    const existing = this.#users.get(userId)
    if (existing) {
      if (existing.identityKey !== identityKey) return 'identity-changed'
      existing.minListVersion = Math.max(existing.minListVersion, minListVersion)
      if (existing.list && existing.list.listVersion < existing.minListVersion) { existing.list = null; existing.digest = '' } // a list below the new floor is no longer believed
      return 'same'
    }
    this.#users.set(userId, { identityKey, minListVersion, list: null, digest: '' })
    return 'pinned'
  }

  /** The user chose to trust a new identity key: the old device list is dropped (it was signed by the old key). */
  repin(userId: string, identityKey: string, minListVersion = 0): boolean {
    if (!validToken(userId) || !fromB64(identityKey, 32) || !safeCount(minListVersion) || minListVersion > MAX_LIST_VERSION) return false
    const existing = this.#users.get(userId)
    if (existing?.identityKey === identityKey) { existing.minListVersion = Math.max(existing.minListVersion, minListVersion); return true } // the same key again: nothing to drop, and the version floor must survive
    this.#users.set(userId, { identityKey, minListVersion, list: null, digest: '' })
    return true
  }

  /** CHAT-6: the user is no longer in the owner-signed member list. Their pin and device list are dropped, so nothing from them is believed any more. */
  forget(userId: string): boolean { return this.#users.delete(userId) }

  /** CHAT-6: the user ids that currently have a pinned identity key. */
  pinnedUsers(): readonly string[] { return Object.freeze([...this.#users.keys()]) }

  /** CHAT-6: the identity key pinned for a user ('' when none). */
  identityOf(userId: string): string { return this.#users.get(userId)?.identityKey ?? '' }

  acceptList(value: unknown): RosterAccept { return this.#accept(value, true) }

  #accept(value: unknown, checkAge: boolean): RosterAccept {
    const list = listSnapshot(value)
    if (!list) return fail('format')
    const user = this.#users.get(list.userId)
    if (!user) return fail('unknown-user')
    const bytes = deviceListBytes(list)
    let verified: unknown
    try { verified = this.#verify(fromB64(list.signature, 64)!, bytes, fromB64(user.identityKey, 32)!) } catch { return fail('adapter') }
    if (verified === false) return fail('signature')
    if (verified !== true) return fail('adapter')
    if (checkAge) {
      const now = this.#now()
      if (!safePositive(now)) return fail('adapter')
      if (list.issuedAt > now + DEVICE_LIST_MAX_FUTURE_MS) return fail('time')
      if (now - list.issuedAt > DEVICE_LIST_MAX_AGE_MS) return fail('expired')
    }
    if (list.listVersion < user.minListVersion) return fail('rollback') // below the floor from the friend-adding step
    const digest = toB64(nobleSha256(bytes))
    if (user.list) {
      if (list.listVersion < user.list.listVersion) return fail('rollback')
      if (list.listVersion === user.list.listVersion) {
        return digest === user.digest ? Object.freeze({ ok: true as const, changed: false, listVersion: list.listVersion }) : fail('conflict')
      }
    }
    user.list = list
    user.digest = digest
    return Object.freeze({ ok: true as const, changed: true, listVersion: list.listVersion })
  }

  /** 'fresh': a list is held and not older than DEVICE_LIST_MAX_AGE_MS; 'expired': one is held but it is too old - ask the user to re-issue it. */
  status(userId: string): ListStatus {
    const list = this.#users.get(userId)?.list
    if (!list) return 'none'
    const now = this.#now()
    if (!safePositive(now)) return 'expired' // a clock that gives no time vouches for nothing
    return now - list.issuedAt > DEVICE_LIST_MAX_AGE_MS ? 'expired' : 'fresh'
  }

  /** The keys of one device, only if the user's current list is fresh and names it. */
  device(userId: string, deviceId: string): DeviceEntry | null {
    return this.devices(userId).find(device => device.deviceId === deviceId) ?? null
  }

  devices(userId: string): readonly DeviceEntry[] {
    return this.status(userId) === 'fresh' ? this.#users.get(userId)!.list!.devices : []
  }

  listVersion(userId: string): number {
    return this.#users.get(userId)?.list?.listVersion ?? 0
  }

  snapshot(): RosterSnapshot {
    return Object.freeze({
      version: 1 as const,
      users: Object.freeze([...this.#users].map(([userId, entry]) => Object.freeze({ userId, identityKey: entry.identityKey, minListVersion: entry.minListVersion, list: entry.list }))),
    })
  }
}
