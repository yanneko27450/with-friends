import type { EpochKeyPackage, GroupKeyring } from './chat-keys.ts'
import { EPOCH_PACKAGE_MAX_AGE_MS, MAX_EPOCH, openEpochKey, sealEpochKeyForMembers } from './chat-keys.ts'
import type { DeviceListV2, Roster } from './chat-roster.ts'
import { copyBytes, encoder, fail, plain, safeCount, safePositive, toB64, validToken, type Fail } from './chat-codec.ts'

// CHAT3b-CLIENT: the client side of the relay's four sync routes (CHAT3b-RELAY design, section 3).
//
//   POST /chat/roster/put   { list }                         any member, only their own list (list.userId must be their memberId)
//   POST /chat/roster/get   {}                               every list in the group: { rosters: [{ memberId, list, storedAt }], serverTime }
//   POST /chat/epoch/put    { packets: [{ toMember, toDevice, epoch, packet }] }    group owner only, at most 2 packets per request
//   POST /chat/epoch/get    { after? }                       only packets addressed to the caller's own devices: { packets: [{ toDevice, epoch, packet, at }], serverTime }
//   CHAT-6: POST /chat/join/put { proof }, /chat/join/get {} (owner only), /chat/members/put { list } (owner only), /chat/members/get {}
//
// The relay stores and forwards opaque data; nothing it says is trusted: lists are verified against the pinned identity keys (chat-roster.ts), key packages by the
// owner's device signature and the recipient's key (chat-keys.ts). `serverTime` and `storedAt` are the relay's word and are only used to warn about a wrong clock.
// userId is always the memberId of the group (0.6.0). The transport (HTTP, the Bearer key, mapping status codes to SyncResult) is the caller's.

/** The relay takes at most two packets per request (4 KB body). */
export const EPOCH_PUT_BATCH = 2
/** A key package, JSON then base64url, must fit what the relay accepts. */
export const EPOCH_PACKET_MAX_CHARS = 1_400
/** Differences between our clock and the relay's above this are reported (device lists and key packages are judged by OUR clock). */
export const CLOCK_DRIFT_WARN_MS = 10 * 60_000
/** At most 5 members with 5 devices each is 25 packets; 40 is a safe upper bound kept from the time devices per member were 8. */
const OUTBOX_MAX = 40
const MAX_ROSTERS = 50

export type SyncResult<T> = (Readonly<{ ok: true }> & T) | Readonly<{ ok: false; kind: 'retry' | 'rejected'; reason?: string }>
export type RosterEntry = Readonly<{ memberId: string; list: unknown; storedAt: number }>
export type EpochPacketIn = Readonly<{ toDevice: string; epoch: number; packet: string; at: number }>
export type EpochPacketOut = Readonly<{ toMember: string; toDevice: string; epoch: number; packet: string }>
export type SyncTransport = Readonly<{
  rosterPut(list: DeviceListV2): Promise<SyncResult<{ listVersion: number; serverTime: number }>>
  rosterGet(): Promise<SyncResult<{ rosters: readonly RosterEntry[]; serverTime: number }>>
  epochPut(packets: readonly EpochPacketOut[]): Promise<SyncResult<{ stored: number }>>
  epochGet(after?: number): Promise<SyncResult<{ packets: readonly EpochPacketIn[]; serverTime: number }>>
  /** CHAT-6: a member puts its own join proof (opaque to the relay); the owner reads every member's proof. */
  joinProofPut(proof: Readonly<{ n: string; identityKey: string; mac: string }>): Promise<SyncResult<{}>>
  joinProofsGet(): Promise<SyncResult<{ proofs: readonly Readonly<{ memberId: string; proof: unknown }>[] }>>
  /** CHAT-6: the owner puts the owner-signed member list; any member reads it. The relay does not verify it (nobody believes it unverified). */
  membersPut(list: unknown): Promise<SyncResult<{}>>
  membersGet(): Promise<SyncResult<{ list: unknown; serverTime: number }>>
}>

const drift = (serverTime: unknown, now: number): number | null => (safePositive(serverTime) ? serverTime - now : null)

// ---- own device list ---------------------------------------------------------------------------------------------------------------

export type PublishRosterResult = Readonly<{ ok: true; listVersion: number; driftMs: number | null }> | Fail<'format' | 'retry' | 'rejected'> & Readonly<{ detail?: string }>

/** Puts our own list on the relay. The list is checked locally first (it must be ours: userId = our memberId). */
export async function publishRoster(transport: SyncTransport, list: DeviceListV2, memberId: string, now: number): Promise<PublishRosterResult> {
  if (!validToken(memberId) || !list || (list as { userId?: unknown }).userId !== memberId) return fail('format')
  let result: Awaited<ReturnType<SyncTransport['rosterPut']>>
  try { result = await transport.rosterPut(list) } catch { return fail('retry') }
  if (!result || result.ok !== true) return Object.freeze({ ok: false as const, reason: (result && result.ok === false && result.kind === 'rejected' ? 'rejected' : 'retry') as 'retry' | 'rejected', detail: result && result.ok === false ? result.reason : undefined })
  return Object.freeze({ ok: true as const, listVersion: result.listVersion, driftMs: drift(result.serverTime, now) })
}

// ---- other people's lists -----------------------------------------------------------------------------------------------------------

export type RefreshOutcome = 'accepted' | 'unchanged' | 'wrong-member' | 'bad-entry' | string
export type RefreshRostersResult = Readonly<{
  ok: true
  /** One entry per member the relay returned: 'accepted' (new or newer list), 'unchanged', or the reason the list was refused (signature, rollback, conflict, expired, unknown-user, ...). */
  members: Readonly<Record<string, RefreshOutcome>>
  driftMs: number | null
  /** True when our clock and the relay's differ by more than CLOCK_DRIFT_WARN_MS: lists are judged by OUR clock, so tell the user to fix it. */
  clockWarning: boolean
}> | Fail<'retry' | 'rejected'>

export async function refreshRosters(transport: SyncTransport, roster: Roster, now: number): Promise<RefreshRostersResult> {
  let result: Awaited<ReturnType<SyncTransport['rosterGet']>>
  try { result = await transport.rosterGet() } catch { return fail('retry') }
  if (!result || result.ok !== true || !Array.isArray(result.rosters)) return fail(result && result.ok === false && result.kind === 'rejected' ? 'rejected' : 'retry')
  const members = new Map<string, RefreshOutcome>()
  for (const item of result.rosters.slice(0, MAX_ROSTERS)) {
    const entry = plain(item, ['list', 'memberId', 'storedAt'])
    if (!entry || !validToken(entry.memberId) || members.has(entry.memberId)) { members.set(`#${members.size}`, 'bad-entry'); continue }
    const list = entry.list as { userId?: unknown } | null
    if (!list || typeof list !== 'object' || list.userId !== entry.memberId) { members.set(entry.memberId, 'wrong-member'); continue } // a list is only believed under its own member id
    const accepted = roster.acceptList(list)
    members.set(entry.memberId, accepted.ok ? (accepted.changed ? 'accepted' : 'unchanged') : accepted.reason)
  }
  const driftMs = drift(result.serverTime, now)
  return Object.freeze({ ok: true as const, members: Object.freeze(Object.fromEntries(members)), driftMs, clockWarning: driftMs !== null && Math.abs(driftMs) > CLOCK_DRIFT_WARN_MS })
}

// ---- epoch key packets: owner side ---------------------------------------------------------------------------------------------------

export const encodePacket = (pkg: EpochKeyPackage): string | null => {
  const text = toB64(encoder.encode(JSON.stringify(pkg)))
  return text.length <= EPOCH_PACKET_MAX_CHARS ? text : null
}
const decoder = new TextDecoder('utf-8')
export const decodePacket = (packet: unknown): unknown => {
  if (typeof packet !== 'string' || packet.length === 0 || packet.length > EPOCH_PACKET_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(packet)) return null
  try {
    const bytes = Uint8Array.from(atob(packet.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - packet.length % 4) % 4)), character => character.charCodeAt(0))
    if (toB64(bytes) !== packet) return null
    return JSON.parse(decoder.decode(bytes))
  } catch { return null }
}

export type OutboxState = Readonly<{ outbox: OutboxSnapshot; keyring: ReturnType<GroupKeyring['snapshot']> }>
export type OutboxSnapshot = Readonly<{ version: 1; packets: readonly EpochPacketOut[] }>

/**
 * The owner's queue of key packets that the relay has not accepted yet. A rotation changes the keyring in memory at once; the packets must reach the relay
 * even if the relay is down or the process restarts, so they are stored (together with the keyring) BEFORE the first put. Only the packet of the highest epoch
 * per target device is kept. Persist atomically: `persist` gets the outbox and the keyring snapshot (which holds the live epoch key: where Claude cannot read).
 */
export class EpochOutbox {
  readonly #persist: (state: OutboxState) => void
  readonly #keyring: GroupKeyring
  #packets: EpochPacketOut[] = []
  #flushing: Promise<Readonly<{ sent: number; left: number; dropped: number; stopped?: 'retry' | 'rejected' | 'not-owner' }>> | null = null
  private constructor(persist: (state: OutboxState) => void, keyring: GroupKeyring) { this.#persist = persist; this.#keyring = keyring }

  static create(options: Readonly<{ persist: (state: OutboxState) => void; keyring: GroupKeyring }>, snapshot?: OutboxSnapshot): EpochOutbox | null {
    if (!options || typeof options.persist !== 'function' || !options.keyring) return null
    const outbox = new EpochOutbox(options.persist, options.keyring)
    if (snapshot === undefined) return outbox
    const raw = plain(snapshot, ['packets', 'version'])
    if (!raw || raw.version !== 1 || !Array.isArray(raw.packets) || raw.packets.length > 40) return null
    for (const item of raw.packets) {
      const packet = outbox.#valid(item)
      if (!packet) return null
      outbox.#packets.push(packet)
    }
    return outbox
  }

  #valid(item: unknown): EpochPacketOut | null {
    const entry = plain(item, ['epoch', 'packet', 'toDevice', 'toMember'])
    if (!entry || !validToken(entry.toMember) || !validToken(entry.toDevice) || !safePositive(entry.epoch) || entry.epoch > MAX_EPOCH
      || typeof entry.packet !== 'string' || entry.packet.length > EPOCH_PACKET_MAX_CHARS || decodePacket(entry.packet) === null) return null
    return Object.freeze({ toMember: entry.toMember, toDevice: entry.toDevice, epoch: entry.epoch, packet: entry.packet })
  }

  get size(): number { return this.#packets.length }
  snapshot(): OutboxSnapshot { return Object.freeze({ version: 1 as const, packets: Object.freeze([...this.#packets]) }) }

  /** Queues packets (a newer epoch replaces an older packet for the same device) and stores outbox + keyring. false: nothing queued or the store failed (the packets stay queued in memory). */
  enqueue(packets: readonly EpochPacketOut[]): boolean {
    const checked: EpochPacketOut[] = []
    for (const item of packets) { const packet = this.#valid(item); if (!packet) return false; checked.push(packet) }
    const fresh = new Set(checked.filter(packet => !this.#packets.some(known => known.toMember === packet.toMember && known.toDevice === packet.toDevice)).map(packet => `${packet.toMember}/${packet.toDevice}`))
    if (this.#packets.length + fresh.size > OUTBOX_MAX) return false // all or nothing
    for (const packet of checked) {
      const index = this.#packets.findIndex(known => known.toMember === packet.toMember && known.toDevice === packet.toDevice)
      if (index >= 0 && this.#packets[index]!.epoch >= packet.epoch) continue
      if (index >= 0) this.#packets[index] = packet; else this.#packets.push(packet)
    }
    try { this.#persist(Object.freeze({ outbox: this.snapshot(), keyring: this.#keyring.snapshot() })); return true } catch { return false }
  }

  /** Removes every queued packet for these members (they left or were removed: the relay would refuse a whole request that names a non-member). */
  dropMembers(memberIds: readonly string[]): number {
    const before = this.#packets.length
    this.#packets = this.#packets.filter(packet => !memberIds.includes(packet.toMember))
    return before - this.#packets.length
  }

  #store(): void {
    try { this.#persist(Object.freeze({ outbox: this.snapshot(), keyring: this.#keyring.snapshot() })) } catch { /* a stale outbox on disk only means a harmless re-put after a restart */ }
  }

  /**
   * Puts the queued packets two at a time. A batch the relay accepted leaves the queue (matched by identity: a packet that was replaced by a higher epoch while
   * the request was on its way stays queued); a retry-type failure stops (the puts are idempotent); a batch the relay REFUSES is retried one packet at a time, so one bad packet
   * cannot take its neighbour down with it, and only the refused packet is dropped (counted in `dropped`). Calls do not overlap: a second call waits for the first.
   */
  flush(transport: SyncTransport): Promise<Readonly<{ sent: number; left: number; dropped: number; stopped?: 'retry' | 'rejected' | 'not-owner' }>> {
    if (this.#flushing) return this.#flushing
    const run = this.#flush(transport).finally(() => { this.#flushing = null })
    this.#flushing = run
    return run
  }

  async #put(transport: SyncTransport, batch: readonly EpochPacketOut[]): Promise<'ok' | 'retry' | 'not-owner' | 'refused'> {
    let result: Awaited<ReturnType<SyncTransport['epochPut']>>
    try { result = await transport.epochPut(batch) } catch { return 'retry' }
    if (result && result.ok === true) return 'ok'
    if (result && result.ok === false && result.kind === 'rejected') return result.reason === 'not-owner' || result.reason === 'forbidden' ? 'not-owner' : 'refused' // forbidden: our key no longer works - stop, do not throw the queue away
    return 'retry'
  }

  async #flush(transport: SyncTransport): Promise<Readonly<{ sent: number; left: number; dropped: number; stopped?: 'retry' | 'rejected' | 'not-owner' }>> {
    let sent = 0
    let dropped = 0
    const remove = (done: readonly EpochPacketOut[]): void => { this.#packets = this.#packets.filter(packet => !done.includes(packet)); this.#store() }
    while (this.#packets.length > 0) {
      const batch = this.#packets.slice(0, EPOCH_PUT_BATCH)
      const outcome = await this.#put(transport, batch)
      if (outcome === 'ok') { remove(batch); sent += batch.length; continue }
      if (outcome === 'retry') return Object.freeze({ sent, left: this.#packets.length, dropped, stopped: 'retry' as const })
      if (outcome === 'not-owner') return Object.freeze({ sent, left: this.#packets.length, dropped, stopped: 'not-owner' as const })
      // refused: find the bad packet by sending them one by one
      for (const packet of batch) {
        const single = await this.#put(transport, [packet])
        if (single === 'ok') { remove([packet]); sent++ }
        else if (single === 'refused') { remove([packet]); dropped++ }
        else return Object.freeze({ sent, left: this.#packets.length, dropped, stopped: single === 'not-owner' ? 'not-owner' as const : 'retry' as const })
      }
    }
    return Object.freeze({ sent, left: 0, dropped })
  }
}

export type DistributeInput = Readonly<{
  keyring: GroupKeyring
  outbox: EpochOutbox
  roster: Roster
  groupId: string
  /** The group's current members (memberIds), including the owner and the one who joined; NOT the one who left (and `exclude` names whoever must not get the key). */
  memberIds: readonly string[]
  exclude?: readonly string[]
  change: Readonly<{ type: 'join' | 'leave' | 'kick'; userId: string }>
  from: Readonly<{ userId: string; deviceId: string; encPrivate: Uint8Array; sign(message: Uint8Array): Uint8Array }>
  now: number
  random?: (length: number) => Uint8Array
}>
export type DistributeResult = Readonly<{ ok: true; epoch: number; packets: number; missing: readonly string[]; stored: boolean }> | Fail<'rotate' | 'seal'>

/**
 * Owner only, one device only: a membership change gives a new epoch (A3), the new key is sealed for every device of every remaining member, and the packets
 * go into the outbox (stored with the keyring). The caller then calls outbox.flush(transport). `missing` lists members with no fresh device list (nobody can seal for them).
 */
export function rotateAndSeal(input: DistributeInput): DistributeResult {
  const next = input.keyring.onMembership(input.change)
  if (!next) return fail('rotate')
  try {
    const exclude = [...(input.exclude ?? []), ...(input.change.type === 'join' ? [] : [input.change.userId])]
    input.outbox.dropMembers(exclude) // packets still waiting for someone who is gone would make the relay refuse the whole batch they sit in
    const sealed = sealEpochKeyForMembers({ groupId: input.groupId, epoch: next.epoch, key: next.key, userIds: input.memberIds, exclude, roster: input.roster, createdAt: input.now,
      from: input.from, random: input.random })
    const out: EpochPacketOut[] = []
    for (const pkg of sealed.packages) {
      const packet = encodePacket(pkg)
      if (!packet) return fail('seal')
      out.push({ toMember: pkg.to.userId, toDevice: pkg.to.deviceId, epoch: pkg.epoch, packet })
    }
    const stored = input.outbox.enqueue(out)
    return Object.freeze({ ok: true as const, epoch: next.epoch, packets: out.length, missing: sealed.missing, stored })
  } finally { next.key.fill(0) }
}

// ---- epoch key packets: member side ---------------------------------------------------------------------------------------------------

export type FetchEpochResult = Readonly<{
  ok: true
  installed: readonly number[]
  failed: readonly Readonly<{ epoch: number; reason: string }>[]
  driftMs: number | null
  clockWarning: boolean
}> | Fail<'retry' | 'rejected'>

/** Asks the relay for key packets addressed to this device, opens them (owner's signature, our key, epoch above everything we ever held) and installs the keys. */
export async function fetchEpochKeys(transport: SyncTransport, input: Readonly<{
  keyring: GroupKeyring
  roster: Roster
  groupId: string
  ownerMemberId: string
  me: Readonly<{ userId: string; deviceId: string; encPrivate: Uint8Array }>
  now: number
}>): Promise<FetchEpochResult> {
  if (!copyBytes(input.me.encPrivate, 32)) return fail('rejected')
  let result: Awaited<ReturnType<SyncTransport['epochGet']>>
  try { result = await transport.epochGet(input.keyring.highEpoch) } catch { return fail('retry') }
  if (!result || result.ok !== true || !Array.isArray(result.packets)) return fail(result && result.ok === false && result.kind === 'rejected' ? 'rejected' : 'retry')
  const installed: number[] = []
  const failed: { epoch: number; reason: string }[] = []
  const incoming = result.packets.slice(0, 40).map(item => plain(item, ['at', 'epoch', 'packet', 'toDevice'])).filter((item): item is NonNullable<typeof item> => item !== null)
    .filter(item => item.toDevice === input.me.deviceId && safeCount(item.epoch)).sort((left, right) => (left.epoch as number) - (right.epoch as number))
  for (const item of incoming) {
    const value = decodePacket(item.packet)
    const opened = openEpochKey({ value, groupId: input.groupId, ownerUserId: input.ownerMemberId, roster: input.roster, me: input.me, now: input.now,
      maxAgeMs: EPOCH_PACKAGE_MAX_AGE_MS, maxFutureSkewMs: CLOCK_DRIFT_WARN_MS, minEpoch: input.keyring.highEpoch + 1 })
    if (!opened.ok) { failed.push({ epoch: item.epoch as number, reason: opened.reason }); continue }
    const status = input.keyring.install(opened.epoch, opened.key)
    opened.key.fill(0)
    if (status === 'ok') installed.push(opened.epoch); else failed.push({ epoch: opened.epoch, reason: status })
  }
  const driftMs = drift(result.serverTime, input.now)
  return Object.freeze({ ok: true as const, installed: Object.freeze(installed), failed: Object.freeze(failed), driftMs, clockWarning: driftMs !== null && Math.abs(driftMs) > CLOCK_DRIFT_WARN_MS })
}
