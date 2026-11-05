import {
  nobleEd25519Verify,
  nobleHkdfSha256,
  nobleHmacSha256,
  nobleX25519PublicKey,
  nobleX25519SharedSecret,
} from './noble-crypto.js'

// B3: periodic rekey of one device-to-device chat session (CHAT060-SEC).
//
// Every REKEY_AFTER_MESSAGES messages or REKEY_AFTER_MS, the two devices run a signed ephemeral-ephemeral X25519
// exchange (init, response, confirm). The new key material is HKDF(DH(eph_a, eph_b), salt = previous chain key). Both
// ephemeral private keys are wiped as soon as the shared secret is derived and the previous key is wiped as soon as the
// peer is known to have moved on, and at the latest one hour after the rekey (OLD_KEY_GRACE_MS; the responder side
// keeps the agreed key while it waits for the confirm and, only with dropOldKeyOnUnconfirmed:false, can outlive the hour). This is NOT a double
// ratchet: a device compromise exposes the traffic of the current generation (at most about 100 messages / 7 days to the
// normal rekey point, the sending side stops at 120 messages / 8 days, received messages have no cap) and, for up to one
// hour, the previous one; older generations are not recoverable from the device state. The previous key is never part of
// a snapshot. Against a passive attacker the chain heals itself (the
// next generation needs a fresh ephemeral DH); an attacker who keeps reading the device keeps reading.
// The output (generation, 32-byte key) plugs into chat-envelope.ts as (epoch, groupKey).
//
// Pure module: no I/O, no clock, no randomness of its own (both injected), so every rule is testable.
// Time rules: the two devices' clocks may differ by up to REKEY_MAX_FUTURE_SKEW_MS (six hours) in either direction. An init is accepted when it is at most
// REKEY_INIT_MAX_AGE_MS + REKEY_MAX_FUTURE_SKEW_MS old and at most REKEY_MAX_FUTURE_SKEW_MS ahead of
// the receiver's clock; response and confirm only get the future bound (their freshness is the local pending TTL).
// A `time` answer from handleInit, handleResponse or handleConfirm therefore means "the two clocks disagree by more than six hours" (or the message is
// that old), not a passing glitch: the caller should tell the user to fix the device clock. Nothing else happens on either side, but the responder's
// pending state then runs into its one-hour limit, which in the default mode retires that side of the session (see dropOldKeyOnUnconfirmed).
// A clock that goes backwards is ignored (the module keeps the highest time it has seen); the flip side is that one absurdly large `now` sticks, and the
// caller must make sure `now` is a sane wall-clock reading (never taken from a message or the relay). Nothing here runs by itself: wipes happen inside calls,
// so a caller that wants the one-hour limits to hold on an idle device must call status(now) at nextExpiryAt().

const encoder = new TextEncoder()
const tokenPattern = /^[A-Za-z0-9_-]{1,100}$/
const base64urlPattern = /^[A-Za-z0-9_-]+$/

export const REKEY_AFTER_MESSAGES = 100
export const REKEY_AFTER_MS = 7 * 24 * 3_600_000
/** The sender refuses to encrypt under a key that is this far past due (peer offline for a week: nothing is lost, the mailbox TTL is 1 hour). */
export const SEND_HARD_LIMIT_MESSAGES = 120
export const SEND_HARD_LIMIT_MS = 8 * 24 * 3_600_000
/** Unanswered init / unconfirmed response are dropped (and their secrets wiped) after this long. Equals the mailbox TTL. */
export const REKEY_PENDING_TTL_MS = 3_600_000
/** The initiator's own pending init lives for REKEY_PENDING_TTL_MS; this is a reference age, not a guarantee. The window in which a responder still answers an init is this plus REKEY_MAX_FUTURE_SKEW_MS (clock differences), so a responder can answer an init whose sender has stopped waiting. */
export const REKEY_INIT_MAX_AGE_MS = 1_800_000
/** Upper bound for keeping the previous generation receive-only after we moved on. Normally it is wiped at the peer's first message under the new generation. */
export const OLD_KEY_GRACE_MS = 3_600_000
/** The largest difference between the two devices' clocks that still lets a rekey through (planner, 11-02: six hours). Beyond it the message is refused with `time`, see the notes at the top. */
export const REKEY_MAX_FUTURE_SKEW_MS = 6 * 3_600_000
/** The party with the larger (userId, deviceId) waits this long after wanting a rekey before it starts one, so the other side's init normally arrives first and the two do not start at once. */
export const REKEY_HIGHER_PARTY_DELAY_MS = 300_000
const SEEN_INIT_LIMIT = 32

export type RekeyParty = Readonly<{ userId: string; deviceId: string }>
type RekeyHeader = Readonly<{ version: 1; conversationId: string; generation: number; from: RekeyParty; to: RekeyParty; createdAt: number }>
export type RekeyInit = RekeyHeader & Readonly<{ kind: 'rekey-init'; initId: string; ephemeralPublicKey: string; signature: string }>
export type RekeyResponse = RekeyHeader & Readonly<{ kind: 'rekey-response'; initId: string; ephemeralPublicKey: string; signature: string }>
export type RekeyConfirm = RekeyHeader & Readonly<{ kind: 'rekey-confirm'; initId: string; mac: string; signature: string }>

export type RekeyFailure = 'format' | 'trust' | 'signature' | 'adapter' | 'time' | 'generation' | 'duplicate' | 'crossing' | 'stale'
  | 'unexpected' | 'dh' | 'mac' | 'sign' | 'not-due' | 'pending' | 'wiped' | 'no-key' | 'overdue' | 'stalled' | 'expired' | 'unknown'
export type RekeyResult<T> = Readonly<{ ok: true } & T> | Readonly<{ ok: false; reason: RekeyFailure }>

export type RekeyConfig = Readonly<{
  conversationId: string
  local: RekeyParty
  remote: RekeyParty
  /** Ed25519 public key of the remote device, base64url, taken from the identity-signed device list. */
  remoteDevicePublicKey: string
  /** Signs with the local device's Ed25519 key (called without a receiver). Must return a plain Uint8Array of exactly 64 bytes. */
  sign(message: Uint8Array): Uint8Array
  verify?(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean
  /** CSPRNG. Default: crypto.getRandomValues. The returned buffer is used (and later wiped) in place. */
  random?(length: number): Uint8Array
  /**
   * Default true. When a response was sent but no confirm (or authenticated message) arrived within REKEY_PENDING_TTL_MS, the responder also wipes the
   * key it was still using and flags the session `stalled` (the planner's rule: no old key survives its hour). With false it keeps the agreed key and does
   * not flag anything; if the initiator did switch (the confirm arrived late or never), the two sides are then on different generations without either
   * knowing: the caller must report every signature-verified envelope whose generation it cannot open to notePeerGeneration, which raises the flag.
   * Either way a confirm that arrives after the pending hour is refused (`unexpected`): the pending state is gone by then.
   * The flag is raised on one side only. In the default mode the retired responder can neither send nor start a rekey, so the initiator is never told by the
   * module: the caller has to learn it out of band (a new invitation, its own timeout). With false the responder can still send, and the initiator learns from
   * its next init or from notePeerGeneration.
   */
  dropOldKeyOnUnconfirmed?: boolean
  /** Default REKEY_HIGHER_PARTY_DELAY_MS. 0 disables the delay (tests, or when the two sides are known to start from one place). */
  higherPartyDelayMs?: number
}>

export type RekeySnapshot = Readonly<{
  version: 1
  conversationId: string
  /** Highest time the session has seen: a restored session never goes back before it (so a rolled-back clock cannot revive expired state). */
  clock: number
  active: Readonly<{ generation: number; key: string; chainKey: string; installedAt: number; peerCreatedAt: number; sent: number; received: number; initId: string; confirmMac: string }> | null
  pendingResponse: Readonly<{ initId: string; generation: number; key: string; confirmKey: string; chainKey: string; createdAt: number; initCreatedAt: number }> | null
  /** Initiator side: the signed confirm we keep re-sendable until the peer shows it switched. */
  awaitingAck: Readonly<{ confirm: RekeyConfirm; since: number }> | null
  /** True once the two sides are known to be out of step (a confirm never arrived, or the peer is ahead): the caller must restart the session under a new conversation ID. */
  stalled: boolean
  seenInits: readonly Readonly<{ initId: string; createdAt: number }>[]
}>

const toB64 = (value: Uint8Array): string => {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const fromB64 = (value: unknown, length: number): Uint8Array | null => {
  if (typeof value !== 'string' || value.length > Math.ceil(length * 4 / 3) || !base64urlPattern.test(value)) return null
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0))
    return bytes.length === length && toB64(bytes) === value ? bytes : null
  } catch { return null }
}
const plain = (value: unknown, expected: readonly string[]): Readonly<Record<string, unknown>> | null => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== expected.length || keys.some(key => typeof key !== 'string') || expected.some(key => !keys.includes(key))) return null
    const snapshot: Record<string, unknown> = {}
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) return null
      snapshot[key] = descriptor.value
    }
    return Object.freeze(snapshot)
  } catch { return null }
}
const validToken = (value: unknown): value is string => typeof value === 'string' && tokenPattern.test(value)
const safeCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0)
const safeTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const safeGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1
const party = (value: unknown): RekeyParty | null => {
  const raw = plain(value, ['deviceId', 'userId'])
  return raw && validToken(raw.userId) && validToken(raw.deviceId) ? Object.freeze({ userId: raw.userId, deviceId: raw.deviceId }) : null
}
const sameParty = (left: RekeyParty, right: RekeyParty): boolean => left.userId === right.userId && left.deviceId === right.deviceId
const partyOrder = (value: RekeyParty): string => `${value.userId}\u0000${value.deviceId}`
const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  let different = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index++) different |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return different === 0
}
const allZero = (value: Uint8Array): boolean => {
  let bits = 0
  for (const byte of value) bits |= byte
  return bits === 0
}
const wipe = (...values: (Uint8Array | null | undefined)[]): void => { for (const value of values) value?.fill(0) }
const copy = (value: Uint8Array): Uint8Array => new Uint8Array(value)

export const rekeyInitBytes = (m: Omit<RekeyInit, 'signature'>): Uint8Array => encoder.encode(JSON.stringify([
  'friends-rekey/init/v1', m.version, m.conversationId, m.generation, m.from.userId, m.from.deviceId, m.to.userId, m.to.deviceId,
  m.initId, m.ephemeralPublicKey, m.createdAt,
]))
/** The response signature also covers the initiator's ephemeral key, so it cannot be replayed against another init. */
export const rekeyResponseBytes = (m: Omit<RekeyResponse, 'signature'>, initiatorEphemeralPublicKey: string): Uint8Array => encoder.encode(JSON.stringify([
  'friends-rekey/response/v1', m.version, m.conversationId, m.generation, m.from.userId, m.from.deviceId, m.to.userId, m.to.deviceId,
  m.initId, initiatorEphemeralPublicKey, m.ephemeralPublicKey, m.createdAt,
]))
export const rekeyConfirmBytes = (m: Omit<RekeyConfirm, 'signature'>): Uint8Array => encoder.encode(JSON.stringify([
  'friends-rekey/confirm/v1', m.version, m.conversationId, m.generation, m.from.userId, m.from.deviceId, m.to.userId, m.to.deviceId,
  m.initId, m.mac, m.createdAt,
]))
const keyInfoBytes = (conversationId: string, generation: number, initiator: RekeyParty, responder: RekeyParty, initId: string,
  initiatorEphemeral: string, responderEphemeral: string): Uint8Array => encoder.encode(JSON.stringify([
  'friends-rekey/key/v2', conversationId, generation, initiator.userId, initiator.deviceId, responder.userId, responder.deviceId,
  initId, initiatorEphemeral, responderEphemeral,
]))
const confirmMacBytes = (conversationId: string, generation: number, initId: string): Uint8Array =>
  encoder.encode(JSON.stringify(['friends-rekey/confirm-mac/v1', conversationId, generation, initId]))

const headerOf = (raw: Readonly<Record<string, unknown>>): RekeyHeader | null => {
  const from = party(raw.from)
  const to = party(raw.to)
  if (raw.version !== 1 || !validToken(raw.conversationId) || !safeGeneration(raw.generation) || !from || !to || !safeTime(raw.createdAt)) return null
  return Object.freeze({ version: 1, conversationId: raw.conversationId, generation: raw.generation, from, to, createdAt: raw.createdAt })
}
const initSnapshot = (value: unknown): RekeyInit | null => {
  const raw = plain(value, ['conversationId', 'createdAt', 'ephemeralPublicKey', 'from', 'generation', 'initId', 'kind', 'signature', 'to', 'version'])
  const header = raw && headerOf(raw)
  if (!raw || !header || raw.kind !== 'rekey-init' || !fromB64(raw.initId, 16) || !fromB64(raw.ephemeralPublicKey, 32) || !fromB64(raw.signature, 64)) return null
  return Object.freeze({ ...header, kind: 'rekey-init', initId: raw.initId as string, ephemeralPublicKey: raw.ephemeralPublicKey as string, signature: raw.signature as string })
}
const responseSnapshot = (value: unknown): RekeyResponse | null => {
  const raw = plain(value, ['conversationId', 'createdAt', 'ephemeralPublicKey', 'from', 'generation', 'initId', 'kind', 'signature', 'to', 'version'])
  const header = raw && headerOf(raw)
  if (!raw || !header || raw.kind !== 'rekey-response' || !fromB64(raw.initId, 16) || !fromB64(raw.ephemeralPublicKey, 32) || !fromB64(raw.signature, 64)) return null
  return Object.freeze({ ...header, kind: 'rekey-response', initId: raw.initId as string, ephemeralPublicKey: raw.ephemeralPublicKey as string, signature: raw.signature as string })
}
const confirmSnapshot = (value: unknown): RekeyConfirm | null => {
  const raw = plain(value, ['conversationId', 'createdAt', 'from', 'generation', 'initId', 'kind', 'mac', 'signature', 'to', 'version'])
  const header = raw && headerOf(raw)
  if (!raw || !header || raw.kind !== 'rekey-confirm' || !fromB64(raw.initId, 16) || !fromB64(raw.mac, 32) || !fromB64(raw.signature, 64)) return null
  return Object.freeze({ ...header, kind: 'rekey-confirm', initId: raw.initId as string, mac: raw.mac as string, signature: raw.signature as string })
}

/** `peerCreatedAt`: the peer's own clock at the moment it created the handshake message that produced this generation. An init created before it is older news. */
type Active = { generation: number; key: Uint8Array; chainKey: Uint8Array; installedAt: number; peerCreatedAt: number; sent: number; received: number; initId: string; confirmMac: string }
type Previous = { generation: number; key: Uint8Array; expiresAt: number }
type PendingInit = { initId: string; generation: number; privateKey: Uint8Array; publicKey: string; createdAt: number }
type PendingResponse = { initId: string; generation: number; key: Uint8Array; confirmKey: Uint8Array; chainKey: Uint8Array; createdAt: number; initCreatedAt: number }
type AwaitingAck = { confirm: RekeyConfirm; since: number }
type Seen = { initId: string; createdAt: number }
type Derived = { key: Uint8Array; confirmKey: Uint8Array; chainKey: Uint8Array }

const defaultRandom = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length))

export class RekeySession {
  readonly #conversationId: string
  readonly #local: RekeyParty
  readonly #remote: RekeyParty
  readonly #remoteKey: Uint8Array
  readonly #sign: RekeyConfig['sign']
  readonly #verify: NonNullable<RekeyConfig['verify']>
  readonly #random: NonNullable<RekeyConfig['random']>
  readonly #dropOldKey: boolean
  readonly #higherDelay: number
  #active: Active | null = null
  #previous: Previous | null = null
  #pendingInit: PendingInit | null = null
  #pendingResponse: PendingResponse | null = null
  #awaitingAck: AwaitingAck | null = null
  #stalled = false
  #seen: Seen[] = []
  #wiped = false
  #highWater = 0
  #wantSince: number | null = null

  private constructor(config: RekeyConfig, remoteKey: Uint8Array, local: RekeyParty, remote: RekeyParty) {
    this.#conversationId = config.conversationId
    this.#local = local
    this.#remote = remote
    this.#remoteKey = remoteKey
    this.#sign = config.sign
    this.#verify = config.verify ?? nobleEd25519Verify
    this.#random = config.random ?? defaultRandom
    this.#dropOldKey = config.dropOldKeyOnUnconfirmed !== false
    this.#higherDelay = config.higherPartyDelayMs ?? REKEY_HIGHER_PARTY_DELAY_MS
  }

  /** Returns null for a malformed config or snapshot (pass `undefined`, not `null`, for "nothing stored yet"). */
  static create(config: RekeyConfig, snapshot?: RekeySnapshot): RekeySession | null {
    let present: string[] = []
    try {
      present = config && typeof config === 'object'
        ? ['conversationId', 'dropOldKeyOnUnconfirmed', 'higherPartyDelayMs', 'local', 'random', 'remote', 'remoteDevicePublicKey', 'sign', 'verify'].filter(key => Object.hasOwn(config, key)) : []
    } catch { return null }
    const raw = plain(config, present)
    const local = raw && party(raw.local)
    const remote = raw && party(raw.remote)
    const remoteKey = raw && fromB64(raw.remoteDevicePublicKey, 32)
    if (!raw || !validToken(raw.conversationId) || !local || !remote || !remoteKey || sameParty(local, remote)
      || typeof raw.sign !== 'function' || (raw.verify !== undefined && typeof raw.verify !== 'function')
      || (raw.random !== undefined && typeof raw.random !== 'function')
      || (raw.dropOldKeyOnUnconfirmed !== undefined && typeof raw.dropOldKeyOnUnconfirmed !== 'boolean')
      || (raw.higherPartyDelayMs !== undefined && !safeCount(raw.higherPartyDelayMs))) return null
    const session = new RekeySession({ conversationId: raw.conversationId, local, remote, remoteDevicePublicKey: raw.remoteDevicePublicKey as string,
      sign: raw.sign as RekeyConfig['sign'], verify: raw.verify as RekeyConfig['verify'], random: raw.random as RekeyConfig['random'],
      dropOldKeyOnUnconfirmed: raw.dropOldKeyOnUnconfirmed as boolean | undefined, higherPartyDelayMs: raw.higherPartyDelayMs as number | undefined }, remoteKey, local, remote)
    if (snapshot !== undefined && !session.#restore(snapshot)) return null
    return session
  }

  get generation(): number { return this.#active?.generation ?? 0 }

  /** Validates the caller's clock and keeps the highest value seen, so a clock that jumps back cannot resurrect expired state. */
  #clock(now: unknown): number | null {
    if (!safeTime(now)) return null
    if (now > this.#highWater) this.#highWater = now
    return this.#highWater
  }

  #expire(now: number): void {
    if (this.#previous && now >= this.#previous.expiresAt) { wipe(this.#previous.key); this.#previous = null }
    if (this.#pendingInit && now - this.#pendingInit.createdAt >= REKEY_PENDING_TTL_MS) { wipe(this.#pendingInit.privateKey); this.#pendingInit = null }
    if (this.#pendingResponse && now - this.#pendingResponse.createdAt >= REKEY_PENDING_TTL_MS) {
      wipe(this.#pendingResponse.key, this.#pendingResponse.confirmKey, this.#pendingResponse.chainKey)
      this.#pendingResponse = null
      // No confirm and no authenticated message within the hour. The planner's rule: no old key survives its hour, so the key we were still using goes too
      // and the session must be restarted (flagged). Without the option the agreed key stays (see RekeyConfig.dropOldKeyOnUnconfirmed).
      if (this.#dropOldKey && this.#active) {
        wipe(this.#active.key, this.#active.chainKey)
        this.#active = null
        this.#stalled = true
      }
    }
    // After the grace period the responder's pending state is gone, so a re-sent confirm would be useless.
    if (this.#awaitingAck && now - this.#awaitingAck.since >= OLD_KEY_GRACE_MS) this.#awaitingAck = null
    this.#seen = this.#seen.filter(entry => now - entry.createdAt < REKEY_INIT_MAX_AGE_MS + 2 * REKEY_MAX_FUTURE_SKEW_MS)
  }

  /** Should this device start a rekey now? The larger party waits REKEY_HIGHER_PARTY_DELAY_MS after it first wanted one (not persisted: a restart only delays it further). */
  #wanted(now: number): boolean {
    const wanted = !this.#active || this.#due(now)
    if (!wanted) { this.#wantSince = null; return false }
    if (this.#higherDelay === 0 || partyOrder(this.#local) < partyOrder(this.#remote)) return true
    if (this.#wantSince === null) this.#wantSince = now
    return now - this.#wantSince >= this.#higherDelay
  }

  #due(now: number): boolean {
    const active = this.#active
    return !!active && (active.sent + active.received >= REKEY_AFTER_MESSAGES || now - active.installedAt >= REKEY_AFTER_MS)
  }

  status(now: number): Readonly<{ generation: number; sent: number; received: number; ageMs: number; due: boolean; overdue: boolean; stalled: boolean; awaitingAck: boolean; pending: 'none' | 'initiated' | 'responded' }> {
    const t = this.#clock(now) ?? this.#highWater
    this.#expire(t)
    const active = this.#active
    return Object.freeze({ generation: active?.generation ?? 0, sent: active?.sent ?? 0, received: active?.received ?? 0,
      ageMs: active ? Math.max(0, t - active.installedAt) : 0, due: this.#due(t),
      overdue: !!active && (active.sent >= SEND_HARD_LIMIT_MESSAGES || t - active.installedAt >= SEND_HARD_LIMIT_MS),
      stalled: this.#stalled, awaitingAck: this.#awaitingAck !== null,
      pending: this.#pendingInit ? 'initiated' : this.#pendingResponse ? 'responded' : 'none' })
  }

  /** Key for the next outgoing message (counts it). Refuses when there is no key yet or the key is far past its rekey deadline. The caller should wipe the returned copy after use. */
  nextSendKey(now: number): RekeyResult<{ generation: number; key: Uint8Array }> {
    const t = this.#clock(now)
    if (t === null) return { ok: false, reason: 'adapter' }
    this.#expire(t)
    const active = this.#active
    if (this.#wiped) return { ok: false, reason: 'wiped' }
    if (this.#stalled) return { ok: false, reason: 'stalled' }
    if (!active) return { ok: false, reason: 'no-key' }
    if (active.sent >= SEND_HARD_LIMIT_MESSAGES || t - active.installedAt >= SEND_HARD_LIMIT_MS) return { ok: false, reason: 'overdue' }
    active.sent++
    return { ok: true, generation: active.generation, key: copy(active.key) }
  }

  /** Key that can decrypt a message tagged with this generation, or null. Does not change any state except expiry. The caller should wipe the returned copy after use. */
  receiveKey(generation: number, now: number): Uint8Array | null {
    const t = this.#clock(now)
    if (t === null) return null
    this.#expire(t)
    if (this.#active?.generation === generation) return copy(this.#active.key)
    if (this.#previous?.generation === generation) return copy(this.#previous.key)
    if (this.#pendingResponse?.generation === generation) return copy(this.#pendingResponse.key)
    return null
  }

  /**
   * Same as receiveKey but with a reason when there is no key, so a message under a wiped generation gets a clear answer instead of a silent hang:
   * 'expired' = an older generation whose key was already wiped (confirm, the peer's first message, or the one-hour limit); 'unknown' = anything else.
   */
  receiveKeyResult(generation: number, now: number): RekeyResult<{ key: Uint8Array }> {
    const key = this.receiveKey(generation, now)
    if (key) return { ok: true, key }
    if (this.#wiped) return { ok: false, reason: 'wiped' }
    if (safeGeneration(generation) && generation < (this.#active?.generation ?? 0)) return { ok: false, reason: 'expired' }
    return { ok: false, reason: this.#stalled ? 'stalled' : 'unknown' }
  }

  /**
   * Call only after the envelope's signature was verified with the REMOTE device's key and its AEAD decrypted under receiveKey(generation): that is
   * what makes a message under the pending key proof that the initiator holds it. Counts it and, once the peer uses the active generation, wipes the previous key and stops re-sending the confirm. */
  noteReceived(generation: number, now: number): void {
    const t = this.#clock(now)
    if (t === null) return
    this.#expire(t)
    const pending = this.#pendingResponse
    // An authenticated message under the key we derived for the pending generation proves the initiator holds it: same evidence as the confirm.
    if (pending && pending.generation === generation && this.#active?.generation !== generation) {
      this.#promote(pending, toB64(nobleHmacSha256(pending.confirmKey, confirmMacBytes(this.#conversationId, pending.generation, pending.initId))), pending.initCreatedAt, t)
    }
    if (this.#active?.generation !== generation) return
    this.#active.received++
    this.#awaitingAck = null
    if (this.#previous) { wipe(this.#previous.key); this.#previous = null }
  }

  /**
   * Call when an envelope from the peer whose signature already verified (no decryption needed) names `generation`.
   * A generation we neither hold nor are waiting for, ahead of ours, is positive evidence that the two sides are out of step.
   */
  notePeerGeneration(generation: number, now: number): void {
    const t = this.#clock(now)
    if (t === null) return
    this.#expire(t)
    if (!safeGeneration(generation) || this.#wiped) return
    if (generation > (this.#active?.generation ?? 0) && generation !== this.#pendingResponse?.generation) this.#stalled = true
  }

  /**
   * The earliest time at which something held in memory is due to be wiped (the previous key, an unanswered init's ephemeral key, an unconfirmed response,
   * the kept confirm), or null. The module has no timer: expiry and zeroing happen inside the next call, so the caller must call status(now) at or after
   * this time (a timer set from this value) or the secret simply stays in memory until the next call. Never read the clock from a message or a peer.
   * Re-read it after every call that changes state (a new handshake step moves it) and re-arm the timer; a timer that fires slightly early just gets a
   * later value back from the next call, so schedule again instead of assuming one call is enough.
   */
  nextExpiryAt(): number | null {
    const due: number[] = []
    if (this.#previous) due.push(this.#previous.expiresAt)
    if (this.#pendingInit) due.push(this.#pendingInit.createdAt + REKEY_PENDING_TTL_MS)
    if (this.#pendingResponse) due.push(this.#pendingResponse.createdAt + REKEY_PENDING_TTL_MS)
    if (this.#awaitingAck) due.push(this.#awaitingAck.since + OLD_KEY_GRACE_MS)
    return due.length ? Math.min(...due) : null
  }

  /** True when this device should start a rekey now: due, no handshake in progress, not stalled, and (for the larger party) past its delay. */
  rekeyDue(now: number): boolean {
    const t = this.#clock(now)
    if (t === null) return false
    this.#expire(t)
    return !this.#wiped && !this.#stalled && !this.#pendingInit && !this.#pendingResponse && this.#due(t) && this.#wanted(t)
  }

  /** The signed confirm to (re-)send while the peer has not shown that it switched. Null otherwise. Sending it again is harmless: the responder accepts it once and ignores copies. */
  pendingConfirm(now: number): RekeyConfirm | null {
    const t = this.#clock(now)
    if (t === null) return null
    this.#expire(t)
    return this.#wiped ? null : this.#awaitingAck?.confirm ?? null
  }

  /** Start a rekey (or the first key exchange). Returns the signed init to send. */
  startRekey(now: number): RekeyResult<{ message: RekeyInit }> {
    const t = this.#clock(now)
    if (t === null) return { ok: false, reason: 'adapter' }
    this.#expire(t)
    if (this.#wiped) return { ok: false, reason: 'wiped' }
    if (this.#stalled) return { ok: false, reason: 'stalled' }
    if (this.#pendingInit || this.#pendingResponse) return { ok: false, reason: 'pending' }
    if (!this.#wanted(t)) return { ok: false, reason: 'not-due' }
    const privateKey = this.#rand(32)
    if (!privateKey) return { ok: false, reason: 'adapter' }
    const initId = this.#rand(16)
    if (!initId) { wipe(privateKey); return { ok: false, reason: 'adapter' } }
    let publicKey: string
    try { publicKey = toB64(nobleX25519PublicKey(privateKey)) } catch { wipe(privateKey); return { ok: false, reason: 'adapter' } }
    const unsigned = Object.freeze({ kind: 'rekey-init' as const, version: 1 as const, conversationId: this.#conversationId,
      generation: this.generation + 1, from: this.#local, to: this.#remote, initId: toB64(initId), ephemeralPublicKey: publicKey, createdAt: t })
    const signature = this.#signBytes(rekeyInitBytes(unsigned))
    if (!signature) { wipe(privateKey); return { ok: false, reason: 'sign' } }
    this.#pendingInit = { initId: unsigned.initId, generation: unsigned.generation, privateKey, publicKey, createdAt: t }
    return { ok: true, message: Object.freeze({ ...unsigned, signature }) }
  }

  /** We are the responder. */
  handleInit(value: unknown, now: number): RekeyResult<{ message: RekeyResponse }> {
    const t = this.#clock(now)
    if (t === null) return { ok: false, reason: 'adapter' }
    this.#expire(t)
    if (this.#wiped) return { ok: false, reason: 'wiped' }
    if (this.#stalled) return { ok: false, reason: 'stalled' } // a stalled session is restarted under a new conversation ID, not resumed
    const init = initSnapshot(value)
    if (!init) return { ok: false, reason: 'format' }
    if (init.conversationId !== this.#conversationId || !sameParty(init.from, this.#remote) || !sameParty(init.to, this.#local)) return { ok: false, reason: 'trust' }
    // The cheap checks come first: forged inits must not cost a signature verification each.
    if (init.createdAt < t - REKEY_INIT_MAX_AGE_MS - REKEY_MAX_FUTURE_SKEW_MS || init.createdAt > t + REKEY_MAX_FUTURE_SKEW_MS) return { ok: false, reason: 'time' }
    if (this.#seen.some(entry => entry.initId === init.initId)) return { ok: false, reason: 'duplicate' }
    const verified = this.#verifyBytes(init.signature, rekeyInitBytes(init))
    if (verified !== true) return { ok: false, reason: verified === false ? 'signature' : 'adapter' }
    if (this.#pendingResponse && init.generation === this.#pendingResponse.generation + 1) {
      // The relay delivered the peer's next rekey ahead of the confirm for the one we answered: out of order, not out of step. Nothing to remember or flag.
      return { ok: false, reason: 'unexpected' }
    }
    if (init.generation !== this.generation + 1) {
      // An init the peer created before the handshake that produced our current generation (a crossing init that got reordered, an older attempt
      // the relay held back) is old news, not evidence of anything: the peer's own clock orders them.
      if (this.#active && init.createdAt <= this.#active.peerCreatedAt) {
        this.#remember(init.initId, init.createdAt)
        return { ok: false, reason: 'stale' }
      }
      // A fresh, signed, never-seen init for a generation we are not about to open: the peer is ahead of us or behind us (lost state, restored backup).
      this.#remember(init.initId, init.createdAt)
      this.#stalled = true
      return { ok: false, reason: 'generation' }
    }
    if (this.#pendingInit && this.#pendingInit.generation === init.generation && partyOrder(this.#local) < partyOrder(this.#remote)) {
      this.#remember(init.initId, init.createdAt)
      return { ok: false, reason: 'crossing' } // both started: the lower party's init wins, so ours stands and theirs is ignored
    }
    // An older init that arrives late (reordered or replayed by the relay) must not replace the handshake we already answered.
    if (this.#pendingResponse && init.createdAt <= this.#pendingResponse.initCreatedAt) {
      this.#remember(init.initId, init.createdAt)
      return { ok: false, reason: 'stale' }
    }
    const privateKey = this.#rand(32)
    if (!privateKey) return { ok: false, reason: 'adapter' }
    let publicKey: string
    let derived: Derived | null = null
    try {
      publicKey = toB64(nobleX25519PublicKey(privateKey))
      derived = this.#derive(privateKey, fromB64(init.ephemeralPublicKey, 32)!, init.generation, this.#remote, this.#local, init.initId, init.ephemeralPublicKey, publicKey)
    } catch { wipe(privateKey); return { ok: false, reason: 'dh' } }
    wipe(privateKey)
    if (!derived) return { ok: false, reason: 'dh' }
    const unsigned = Object.freeze({ kind: 'rekey-response' as const, version: 1 as const, conversationId: this.#conversationId,
      generation: init.generation, from: this.#local, to: this.#remote, initId: init.initId, ephemeralPublicKey: publicKey, createdAt: t })
    const signature = this.#signBytes(rekeyResponseBytes(unsigned, init.ephemeralPublicKey))
    if (!signature) { wipe(derived.key, derived.confirmKey, derived.chainKey); return { ok: false, reason: 'sign' } }
    if (this.#pendingInit && this.#pendingInit.generation === init.generation) { wipe(this.#pendingInit.privateKey); this.#pendingInit = null }
    if (this.#pendingResponse) wipe(this.#pendingResponse.key, this.#pendingResponse.confirmKey, this.#pendingResponse.chainKey)
    this.#pendingResponse = { initId: init.initId, generation: init.generation, key: derived.key, confirmKey: derived.confirmKey, chainKey: derived.chainKey,
      createdAt: t, initCreatedAt: init.createdAt }
    this.#remember(init.initId, init.createdAt)
    return { ok: true, message: Object.freeze({ ...unsigned, signature }) }
  }

  /** We are the initiator and got the response. Installs the new key and returns the confirm for the responder. */
  handleResponse(value: unknown, now: number): RekeyResult<{ message: RekeyConfirm; generation: number }> {
    const t = this.#clock(now)
    if (t === null) return { ok: false, reason: 'adapter' }
    this.#expire(t)
    if (this.#wiped) return { ok: false, reason: 'wiped' }
    const response = responseSnapshot(value)
    if (!response) return { ok: false, reason: 'format' }
    if (response.conversationId !== this.#conversationId || !sameParty(response.from, this.#remote) || !sameParty(response.to, this.#local)) return { ok: false, reason: 'trust' }
    const pending = this.#pendingInit
    if (!pending || pending.initId !== response.initId || pending.generation !== response.generation) return { ok: false, reason: 'unexpected' }
    if (response.createdAt > t + REKEY_MAX_FUTURE_SKEW_MS) return { ok: false, reason: 'time' } // cheap check first
    const verified = this.#verifyBytes(response.signature, rekeyResponseBytes(response, pending.publicKey))
    if (verified !== true) return { ok: false, reason: verified === false ? 'signature' : 'adapter' }
    let derived: Derived | null
    try {
      derived = this.#derive(pending.privateKey, fromB64(response.ephemeralPublicKey, 32)!, pending.generation, this.#local, this.#remote,
        pending.initId, pending.publicKey, response.ephemeralPublicKey)
    } catch { return { ok: false, reason: 'dh' } }
    if (!derived) return { ok: false, reason: 'dh' }
    const mac = toB64(nobleHmacSha256(derived.confirmKey, confirmMacBytes(this.#conversationId, pending.generation, pending.initId)))
    const unsigned = Object.freeze({ kind: 'rekey-confirm' as const, version: 1 as const, conversationId: this.#conversationId,
      generation: pending.generation, from: this.#local, to: this.#remote, initId: pending.initId, mac, createdAt: t })
    const signature = this.#signBytes(rekeyConfirmBytes(unsigned))
    if (!signature) { wipe(derived.key, derived.confirmKey, derived.chainKey); return { ok: false, reason: 'sign' } }
    const confirm = Object.freeze({ ...unsigned, signature })
    wipe(derived.confirmKey, pending.privateKey)
    this.#pendingInit = null
    if (this.#previous) wipe(this.#previous.key)
    this.#previous = this.#active ? { generation: this.#active.generation, key: this.#active.key, expiresAt: t + OLD_KEY_GRACE_MS } : null
    if (this.#active) wipe(this.#active.chainKey)
    this.#active = { generation: pending.generation, key: derived.key, chainKey: derived.chainKey, installedAt: t, peerCreatedAt: response.createdAt, sent: 0, received: 0, initId: pending.initId, confirmMac: mac }
    this.#awaitingAck = { confirm, since: t }
    this.#wantSince = null
    return { ok: true, message: confirm, generation: pending.generation }
  }

  /** We are the responder and the initiator proved it derived the same key: switch over and wipe the old key. A copy of a confirm we already accepted is accepted again without changing anything. */
  handleConfirm(value: unknown, now: number): RekeyResult<{ generation: number }> {
    const t = this.#clock(now)
    if (t === null) return { ok: false, reason: 'adapter' }
    this.#expire(t)
    if (this.#wiped) return { ok: false, reason: 'wiped' }
    const confirm = confirmSnapshot(value)
    if (!confirm) return { ok: false, reason: 'format' }
    if (confirm.conversationId !== this.#conversationId || !sameParty(confirm.from, this.#remote) || !sameParty(confirm.to, this.#local)) return { ok: false, reason: 'trust' }
    if (confirm.createdAt > t + REKEY_MAX_FUTURE_SKEW_MS) return { ok: false, reason: 'time' } // cheap check before any signature verification
    const pending = this.#pendingResponse
    const active = this.#active
    // A signed confirm for a generation beyond anything we hold or answered: the peer is ahead of us.
    if (confirm.generation > Math.max(active?.generation ?? 0, pending?.generation ?? 0)) {
      const verifiedAhead = this.#verifyBytes(confirm.signature, rekeyConfirmBytes(confirm))
      if (verifiedAhead !== true) return { ok: false, reason: verifiedAhead === false ? 'signature' : 'adapter' }
      this.#stalled = true
      return { ok: false, reason: 'unexpected' }
    }
    if (!pending) {
      const copyOfAccepted = !!active && active.generation === confirm.generation && active.initId === confirm.initId
      if (!copyOfAccepted) return { ok: false, reason: 'unexpected' }
      const verifiedCopy = this.#verifyBytes(confirm.signature, rekeyConfirmBytes(confirm))
      if (verifiedCopy !== true) return { ok: false, reason: verifiedCopy === false ? 'signature' : 'adapter' }
      return equalBytes(fromB64(active!.confirmMac, 32)!, fromB64(confirm.mac, 32)!) ? { ok: true, generation: active!.generation } : { ok: false, reason: 'mac' }
    }
    if (pending.initId !== confirm.initId || pending.generation !== confirm.generation) return { ok: false, reason: 'unexpected' }
    const verified = this.#verifyBytes(confirm.signature, rekeyConfirmBytes(confirm))
    if (verified !== true) return { ok: false, reason: verified === false ? 'signature' : 'adapter' }
    const expected = nobleHmacSha256(pending.confirmKey, confirmMacBytes(this.#conversationId, pending.generation, pending.initId))
    if (!equalBytes(expected, fromB64(confirm.mac, 32)!)) return { ok: false, reason: 'mac' }
    this.#promote(pending, confirm.mac, pending.initCreatedAt, t)
    return { ok: true, generation: pending.generation }
  }

  /** The initiator is known to hold the pending key: make it the active one and wipe everything older. */
  #promote(pending: PendingResponse, confirmMac: string, peerCreatedAt: number, t: number): void {
    if (this.#active) wipe(this.#active.key, this.#active.chainKey)
    if (this.#previous) { wipe(this.#previous.key); this.#previous = null }
    wipe(pending.confirmKey)
    this.#active = { generation: pending.generation, key: pending.key, chainKey: pending.chainKey, installedAt: t, peerCreatedAt, sent: 0, received: 0, initId: pending.initId, confirmMac }
    this.#pendingResponse = null
    this.#wantSince = null
    this.#awaitingAck = null // a confirm we kept for an earlier generation (as initiator) is obsolete now
  }

  /**
   * Secrets that are safe to persist. Ephemeral private keys are deliberately never part of it: a restart mid-handshake just starts over.
   * Persist it BEFORE sending a response or a confirm: a crash between sending and persisting leaves the two sides on different generations.
   * The previous generation's key is deliberately not in it (it must not outlive its hour on disk); messages still in flight under it after a restart
   * get the `expired` answer. It holds the live session keys: store it where the model cannot read it, or encrypted.
   */
  snapshot(now?: number): RekeySnapshot | null {
    if (this.#wiped) return null
    this.#expire(this.#clock(now) ?? this.#highWater)
    const a = this.#active, r = this.#pendingResponse
    return Object.freeze({
      version: 1 as const, conversationId: this.#conversationId, clock: this.#highWater,
      active: a && Object.freeze({ generation: a.generation, key: toB64(a.key), chainKey: toB64(a.chainKey), installedAt: a.installedAt, peerCreatedAt: a.peerCreatedAt, sent: a.sent, received: a.received, initId: a.initId, confirmMac: a.confirmMac }),
      pendingResponse: r && Object.freeze({ initId: r.initId, generation: r.generation, key: toB64(r.key), confirmKey: toB64(r.confirmKey),
        chainKey: toB64(r.chainKey), createdAt: r.createdAt, initCreatedAt: r.initCreatedAt }),
      awaitingAck: this.#awaitingAck && Object.freeze({ confirm: this.#awaitingAck.confirm, since: this.#awaitingAck.since }),
      stalled: this.#stalled,
      seenInits: Object.freeze(this.#seen.map(entry => Object.freeze({ ...entry }))),
    })
  }

  /** Erase every secret now (leave, remove, panic). The session is unusable afterwards. */
  wipe(): void {
    wipe(this.#active?.key, this.#active?.chainKey, this.#previous?.key, this.#pendingInit?.privateKey,
      this.#pendingResponse?.key, this.#pendingResponse?.confirmKey, this.#pendingResponse?.chainKey)
    this.#active = this.#previous = this.#pendingInit = this.#pendingResponse = this.#awaitingAck = null
    this.#seen = []
    this.#wiped = true
  }

  #remember(initId: string, createdAt: number): void {
    this.#seen.push({ initId, createdAt })
    if (this.#seen.length > SEEN_INIT_LIMIT) this.#seen.splice(0, this.#seen.length - SEEN_INIT_LIMIT)
  }

  #rand(length: number): Uint8Array | null {
    let bytes: unknown
    try { bytes = Reflect.apply(this.#random, undefined, [length]) } catch { return null }
    return bytes instanceof Uint8Array && bytes.length === length ? bytes : null
  }

  #derive(privateKey: Uint8Array, peerPublicKey: Uint8Array, generation: number, initiator: RekeyParty, responder: RekeyParty,
    initId: string, initiatorEphemeral: string, responderEphemeral: string): Derived | null {
    let shared: Uint8Array | null = null
    let okm: Uint8Array | null = null
    try {
      shared = nobleX25519SharedSecret(privateKey, peerPublicKey)
      if (!(shared instanceof Uint8Array) || shared.length !== 32 || allZero(shared)) return null
      const salt = this.#active ? this.#active.chainKey : new Uint8Array(32)
      okm = nobleHkdfSha256(shared, salt, keyInfoBytes(this.#conversationId, generation, initiator, responder, initId, initiatorEphemeral, responderEphemeral), 96)
      return { key: okm.slice(0, 32), confirmKey: okm.slice(32, 64), chainKey: okm.slice(64, 96) }
    } finally { wipe(shared, okm) }
  }

  #signBytes(message: Uint8Array): string | null {
    try {
      const signed = Reflect.apply(this.#sign, undefined, [message])
      if (!signed || Object.getPrototypeOf(signed) !== Uint8Array.prototype || (signed as Uint8Array).length !== 64) return null
      return toB64(signed as Uint8Array)
    } catch { return null }
  }

  #verifyBytes(signature: string, message: Uint8Array): boolean | null {
    try {
      const verified = Reflect.apply(this.#verify, undefined, [fromB64(signature, 64)!, message, copy(this.#remoteKey)])
      return verified === true ? true : verified === false ? false : null
    } catch { return null }
  }

  #restore(value: unknown): boolean {
    const keys: Uint8Array[] = []
    const fail = (): false => { wipe(...keys); return false }
    const key32 = (v: unknown): Uint8Array | null => { const k = fromB64(v, 32); if (k) keys.push(k); return k }
    const raw = plain(value, ['active', 'awaitingAck', 'clock', 'conversationId', 'pendingResponse', 'seenInits', 'stalled', 'version'])
    if (!raw || raw.version !== 1 || raw.conversationId !== this.#conversationId || typeof raw.stalled !== 'boolean' || !safeCount(raw.clock)) return false
    // Every time field must lie within the clock the snapshot was taken at (plus the peer-clock allowance): a doctored value cannot stretch a limit.
    const limit = raw.clock + REKEY_MAX_FUTURE_SKEW_MS
    let active: Active | null = null, pending: PendingResponse | null = null, ack: AwaitingAck | null = null
    if (raw.active !== null) {
      const a = plain(raw.active, ['chainKey', 'confirmMac', 'generation', 'initId', 'installedAt', 'key', 'peerCreatedAt', 'received', 'sent'])
      const key = a && key32(a.key), chainKey = a && key32(a.chainKey)
      if (!a || !key || !chainKey || !safeGeneration(a.generation) || !safeTime(a.installedAt) || a.installedAt > raw.clock || !safeTime(a.peerCreatedAt) || a.peerCreatedAt > limit
        || !safeCount(a.sent) || !safeCount(a.received) || !fromB64(a.initId, 16) || !fromB64(a.confirmMac, 32)) return fail()
      active = { generation: a.generation, key, chainKey, installedAt: a.installedAt, peerCreatedAt: a.peerCreatedAt, sent: a.sent, received: a.received, initId: a.initId as string, confirmMac: a.confirmMac as string }
    }
    if (raw.pendingResponse !== null) {
      const r = plain(raw.pendingResponse, ['chainKey', 'confirmKey', 'createdAt', 'generation', 'initCreatedAt', 'initId', 'key'])
      const key = r && key32(r.key), confirmKey = r && key32(r.confirmKey), chainKey = r && key32(r.chainKey)
      if (!r || !key || !confirmKey || !chainKey || !fromB64(r.initId, 16) || !safeGeneration(r.generation) || r.generation !== (active?.generation ?? 0) + 1
        || !safeTime(r.createdAt) || r.createdAt > raw.clock || !safeTime(r.initCreatedAt) || r.initCreatedAt > limit) return fail()
      pending = { initId: r.initId as string, generation: r.generation, key, confirmKey, chainKey, createdAt: r.createdAt, initCreatedAt: r.initCreatedAt }
    }
    if (raw.awaitingAck !== null) {
      const w = plain(raw.awaitingAck, ['confirm', 'since'])
      const confirm = w && confirmSnapshot(w.confirm)
      if (!w || !confirm || !active || !safeTime(w.since) || w.since !== active.installedAt || confirm.generation !== active.generation || confirm.initId !== active.initId
        || confirm.conversationId !== this.#conversationId || !sameParty(confirm.from, this.#local) || !sameParty(confirm.to, this.#remote)) return fail()
      ack = { confirm, since: w.since }
    }
    const seen: Seen[] = []
    if (!Array.isArray(raw.seenInits) || raw.seenInits.length > SEEN_INIT_LIMIT) return fail()
    for (const entry of raw.seenInits as unknown[]) {
      const e = plain(entry, ['createdAt', 'initId'])
      if (!e || !fromB64(e.initId, 16) || !safeTime(e.createdAt) || e.createdAt > limit) return fail()
      seen.push({ initId: e.initId as string, createdAt: e.createdAt })
    }
    this.#highWater = raw.clock
    this.#active = active
    this.#previous = null
    this.#pendingResponse = pending
    this.#awaitingAck = ack
    this.#stalled = raw.stalled
    this.#seen = seen
    return true
  }
}
