import { nobleSha256 } from './noble-crypto.js'
import {
  createChatEnvelope,
  verifyAndDecryptChatEnvelope,
  type ChatEnvelopeV2,
  type ChatUniquenessStore,
  type ChatVerifier,
} from './chat-envelope.ts'
import { copyBytes, fail, fromB64, plain, safeCount, safePositive, toB64, validToken, wipe, type Fail } from './chat-codec.ts'
import {
  CHAT_CLIENT_MAX_TEXT_BYTES,
  chainHash,
  dmStream,
  encodeFrame,
  groupStream,
  hasVisibleText,
  parseFrame,
  sanitizeChatText,
  secretHint,
  type FrameKind,
  type OrderResult,
  type SendChains,
  type SendChainsSnapshot,
  type SeqTracker,
} from './chat-frame.ts'
import { dmMessageKey, dmRekeyedMessageKey, groupMessageKey, type DmKeyContext, type GroupKeyring } from './chat-keys.ts'
import { RekeySession, type RekeySnapshot } from './chat-rekey.ts'
import type { PersistentReplayStore } from './chat-replay.ts'
import type { Roster } from './chat-roster.ts'

// CHAT3-CLIENT: the send and receive flows. Pure of I/O: the relay is reached through an injected ChatTransport, the clock and the RNG are injected,
// every piece of state has a snapshot() the caller stores (somewhere Claude cannot read: they hold keys or ciphertext waiting to be sent).
//
// Send:     prepare (length, valid text, secret hint) -> frame (sequence number + previous hash) -> nonce / opening -> encrypt under a context-bound key
//           -> sign -> publish. The sequence number is committed only when the relay has accepted (or already holds) the envelope.
// Receive:  the sender device's keys come from the roster (identity-signed device lists), then signature, decrypt, commitment, replay claim, frame,
//           order check. Nothing is shown unless all of that passed; the result carries what a report needs, for pane memory only.

/**
 * A message can wait up to an hour before the relay accepts it (the relay checks sentAt against ITS clock at acceptance) and then sits in the mailbox for
 * another hour, so a reader can see sentAt two hours old; five more minutes for clocks.
 */
export const CHAT_RECEIVE_MAX_AGE_MS = 7_500_000
/** A sealed envelope that has not reached the relay after this long is given up (its sequence number is kept, so the receiver sees a gap, not a fork). */
export const PENDING_MAX_AGE_MS = 3_000_000
const MAX_BATCH = 200
const MAX_CURSOR_JUMP = 1_000_000
const REPORTED_LIMIT = 4_000
export const CHAT_RECEIVE_MAX_FUTURE_MS = 300_000
/** What a replay store must remember a claim for (see chat-replay.ts). */
export const CHAT_REPLAY_WINDOW_MS = CHAT_RECEIVE_MAX_AGE_MS + CHAT_RECEIVE_MAX_FUTURE_MS + 60_000
const DM_EPOCH = 0
const MAX_PENDING = 256

export type TransportResult =
  | Readonly<{ ok: true }>
  /** duplicate: the relay already holds this messageId (counts as delivered); retry: not delivered, try again later (429, 5xx, network); rejected: will never be accepted. */
  | Readonly<{ ok: false; kind: 'duplicate' | 'retry' | 'rejected'; reason?: string }>
export type PollMessage = Readonly<{ sequence: number; envelope: unknown }>
export type PollResult = Readonly<{ ok: true; messages: readonly PollMessage[] }> | Readonly<{ ok: false; reason?: string }>
export type DmPollResult = Readonly<{ ok: true; boxes: Readonly<Record<string, Readonly<{ messages: readonly PollMessage[] }>>> }> | Readonly<{ ok: false; reason?: string }>
export type ChatTransport = Readonly<{
  /** `resend` is true when an earlier attempt may have reached the relay (its answer was lost, or the process restarted): a 409 then means "already there". */
  publish(envelope: ChatEnvelopeV2, options: Readonly<{ resend: boolean }>): Promise<TransportResult>
  dmSend(code: string, envelope: ChatEnvelopeV2, options: Readonly<{ resend: boolean }>): Promise<TransportResult>
  poll(after: number): Promise<PollResult>
  dmPoll(boxes: readonly Readonly<{ code: string; after: number }>[]): Promise<DmPollResult>
}>

export type ChatSelf = Readonly<{
  userId: string
  deviceId: string
  /** The device's X25519 private key (32 bytes). Read, never kept or modified. */
  encPrivate: Uint8Array
  /** Ed25519 signature with the device's signing key; called without a receiver, must return a plain 64-byte Uint8Array. */
  sign(message: Uint8Array): Uint8Array
}>

export type ChatClientOptions = Readonly<{
  groupId: string
  me: ChatSelf
  roster: Roster
  keyring: GroupKeyring
  sendChains: SendChains
  tracker: SeqTracker
  /** Claims of received messages (A8): a persistent store that remembers a claim for at least CHAT_REPLAY_WINDOW_MS; the client refuses anything else. */
  replay: PersistentReplayStore
  /** Claims of messages this device made (guards against its own RNG repeating). */
  sent: ChatUniquenessStore
  now(): number
  /**
   * Called synchronously with the client snapshot AFTER an envelope is sealed and BEFORE it is sent. If it throws the envelope is dropped unsent. This is what
   * makes a crash between "relay has it" and "we heard back" harmless: after a restart the stored envelope is re-sent (as a resend) instead of its sequence
   * number being used again. `chains` is the sender-chain snapshot taken at the same moment: store both in one write, or a restart can pair a new client
   * snapshot with an old chain (the client then refuses to start) or the reverse (a sequence number could be used twice). Store them where Claude cannot read.
   */
  persistPending(snapshot: ClientSnapshot, chains: SendChainsSnapshot): void
  random?(length: number): Uint8Array
  verify?: ChatVerifier
}>

type Sealed = Readonly<{ stream: string; kind: FrameKind; code: string; envelope: ChatEnvelopeV2; seq: number; hash: string; epoch: number; attempts: number }>
export type PendingSnapshot = Readonly<{ stream: string; kind: FrameKind; code: string; envelope: ChatEnvelopeV2; seq: number; hash: string; epoch: number; attempts: number }>
export type ClientSnapshot = Readonly<{
  version: 1
  pending: readonly PendingSnapshot[]
  cursors: Readonly<{ group: number; dm: Readonly<Record<string, number>> }>
  /** B3 sessions, one per (mailbox, peer device). They hold LIVE session keys (and the poll cursors): store this whole snapshot where Claude cannot read. */
  rekey: Readonly<Record<string, RekeySnapshot>>
  /** Rekey answers (response, confirm) that still have to reach the relay. */
  controls: readonly Readonly<{ peer: Peer; message: unknown }>[]
}>

export type PrepareFailure = 'blank' | 'invalid' | 'too-long' | 'secret-hint'
export type SendFailure = PrepareFailure | 'no-key' | 'stream-full' | 'pending' | 'no-recipient' | 'seal' | 'transport' | 'rejected' | 'persist'

export type ReceivedMessage = Readonly<{
  ok: true
  kind: 'group' | 'dm'
  /** The group id (kind group) or the DM mailbox code (kind dm). */
  box: string
  messageId: string
  senderId: string
  deviceId: string
  sentAt: number
  /** Clean display text (control, bidirectional and tag characters removed). */
  text: string
  order: OrderResult
  /** Pane memory only (THREAT_MODEL 2.12, L22 a): what a report needs - the envelope, the exact text that was committed (the whole frame) and the opening. */
  report: Readonly<{ envelope: ChatEnvelopeV2; text: string; opening: string }>
}>
export type OpenFailure = 'format' | 'trust' | 'epoch' | 'time' | 'signature' | 'ciphertext' | 'commit' | 'replay' | 'adapter'
  | 'self' | 'unknown-device' | 'no-key' | 'epoch-ahead' | 'epoch-stale' | 'frame' | 'context' | 'blank' | 'sender' | 'no-session' | 'stalled' | 'control'
export type OpenResult = ReceivedMessage | Fail<OpenFailure>

/** Failures that may stop being failures once the roster or the keyring is updated: the poll cursor stays in front of them until the relay expires them. */
const HELD: ReadonlySet<string> = new Set(['unknown-device', 'no-key', 'epoch-ahead', 'adapter', 'no-session'])
/** A DM mailbox is shared by all devices of both users; envelopes sealed for another device simply do not open here. That is normal, not an error. */
const DM_QUIET: ReadonlySet<string> = new Set(['ciphertext', 'control'])
const NOTHING: ReadonlySet<string> = new Set()
/** Re-send a kept confirm at most this often (the peer may simply not have polled yet). */
const CONFIRM_RESEND_MS = 30 * 60_000
const MAX_CONTROLS = 64
const MAX_SESSIONS = 256
type Peer = Readonly<{ code: string; userId: string; deviceId: string }>
type SessionEntry = { session: RekeySession; signKey: string; peer: Peer; lastConfirmAt: number }
type Control = Readonly<{ peer: Peer; message: unknown }>
type KeyChoice = Readonly<{ ok: true; epoch: number; key: Uint8Array }> | Fail<string>

export type DeliveryStatus = 'sent' | 'queued' | 'rejected'
export type SendResult = Readonly<{ ok: true; messageId: string }> | Fail<SendFailure>
export type DmSendResult = Readonly<{
  ok: boolean
  results: readonly Readonly<{ deviceId: string; status: DeliveryStatus | 'blocked-by-pending' | 'failed'; messageId?: string; reason?: string }>[]
}> | Fail<SendFailure>
export type PollSummary = Readonly<{
  delivered: readonly ReceivedMessage[]
  dropped: readonly Readonly<{ sequence: number; reason: OpenFailure }>[]
  /** Messages kept for a later poll because the roster, the keyring or the replay store may still catch up (until they are too old to be accepted). */
  held: number
  /** What the re-send of waiting envelopes did before this poll. */
  flushed: Readonly<{ sent: number; queued: number; rejected: number }>
}>

const peek = (value: unknown): Readonly<{ senderId: string; deviceId: string; epoch: number; groupId: string }> | null => {
  const raw = plain(value, ['ciphertext', 'commit', 'deviceId', 'epoch', 'groupId', 'messageId', 'nonce', 'senderId', 'sentAt', 'signature', 'version'])
  if (!raw || !validToken(raw.senderId) || !validToken(raw.deviceId) || !validToken(raw.groupId) || !safeCount(raw.epoch)) return null
  return { senderId: raw.senderId, deviceId: raw.deviceId, groupId: raw.groupId, epoch: raw.epoch }
}
const hasUnpairedSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) return true
  }
  return false
}
const defaultRandom = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length))

export class ChatClient {
  readonly #o: ChatClientOptions
  readonly #random: (length: number) => Uint8Array
  /** chat-envelope.ts accepts a claim adapter with exactly one own property, `claim`: the stores are wrapped to that shape. */
  readonly #replay: ChatUniquenessStore
  readonly #sent: ChatUniquenessStore
  readonly #pending = new Map<string, Sealed>()
  #groupCursor = 0
  readonly #dmCursors = new Map<string, number>()
  /** Sequence numbers already reported as dropped, so a message the cursor cannot move past is not reported on every poll. */
  readonly #reported = new Set<string>()
  #prunedEpoch = -1
  readonly #sessions = new Map<string, SessionEntry>()
  /** Stored session states whose peer device is not in the roster right now (or not used yet in this run): kept so they are not lost, opened when needed. */
  readonly #rekeySnapshots = new Map<string, RekeySnapshot>()
  #controls: Control[] = []
  #persistFailing = false
  #lastStored = ''
  /** Device pairs whose stored session state could not be used: nothing is sent or accepted for them until resetDmSession (a fresh session would silently fall back to the static key). */
  readonly #broken = new Set<string>()
  /** send, flush and poll change the same state (pending envelopes, chains, cursors): they run one after the other, never interleaved. */
  #queue: Promise<unknown> = Promise.resolve()

  private constructor(options: ChatClientOptions) {
    this.#o = options
    this.#random = options.random ?? defaultRandom
    this.#replay = Object.freeze({ claim: (messageId: string, epoch: number, nonce: string): boolean => options.replay.claim(messageId, epoch, nonce) })
    this.#sent = Object.freeze({ claim: (messageId: string, epoch: number, nonce: string): boolean => options.sent.claim(messageId, epoch, nonce) })
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task)
    this.#queue = run.then(() => undefined, () => undefined)
    return run
  }

  static create(options: ChatClientOptions, snapshot?: ClientSnapshot): ChatClient | null {
    const me = options?.me
    if (!options || !validToken(options.groupId) || !me || !validToken(me.userId) || !validToken(me.deviceId) || !copyBytes(me.encPrivate, 32) || typeof me.sign !== 'function'
      || !options.roster || !options.keyring || !options.sendChains || !options.tracker || !options.replay || typeof options.replay.claim !== 'function'
      || typeof options.replay.windowMs !== 'number' || !(options.replay.windowMs >= CHAT_REPLAY_WINDOW_MS)
      || !options.sent || typeof options.sent.claim !== 'function' || typeof options.now !== 'function' || typeof options.persistPending !== 'function'
      || (options.random !== undefined && typeof options.random !== 'function') || (options.verify !== undefined && typeof options.verify !== 'function')
      || options.keyring.groupId !== options.groupId) return null
    const client = new ChatClient(options)
    if (snapshot === undefined) return client
    return client.#restore(snapshot) ? client : null
  }

  #restore(snapshot: ClientSnapshot): boolean {
    try {
      const raw = plain(snapshot, ['controls', 'cursors', 'pending', 'rekey', 'version'])
      const cursors = raw && plain(raw.cursors, ['dm', 'group'])
      const dmValue = cursors?.dm
      const rekeyValue = raw?.rekey
      if (!raw || !cursors || raw.version !== 1 || !Array.isArray(raw.pending) || raw.pending.length > MAX_PENDING || !safeCount(cursors.group)
        || !dmValue || typeof dmValue !== 'object' || Array.isArray(dmValue) || !rekeyValue || typeof rekeyValue !== 'object' || Array.isArray(rekeyValue)) return false
      if (!Array.isArray(raw.controls) || raw.controls.length > MAX_CONTROLS) return false
      for (const item of raw.controls) {
        const control = plain(item, ['message', 'peer'])
        const peer = control && plain(control.peer, ['code', 'deviceId', 'userId'])
        if (!control || !peer || !validToken(peer.code) || !validToken(peer.userId) || !validToken(peer.deviceId) || !control.message || typeof control.message !== 'object') return false
        this.#controls.push({ peer: { code: peer.code, userId: peer.userId, deviceId: peer.deviceId }, message: control.message })
      }
      const rekeyKeys = Reflect.ownKeys(rekeyValue)
      if (rekeyKeys.length > MAX_SESSIONS) return false
      for (const key of rekeyKeys) {
        const value = typeof key === 'string' ? Object.getOwnPropertyDescriptor(rekeyValue, key)?.value : undefined
        if (typeof key !== 'string' || key.length > 400 || !value || typeof value !== 'object') return false
        this.#rekeySnapshots.set(key, value as RekeySnapshot)
      }
      this.#groupCursor = cursors.group
      for (const key of Reflect.ownKeys(dmValue)) {
        const value = typeof key === 'string' ? Object.getOwnPropertyDescriptor(dmValue, key)?.value : undefined
        if (typeof key !== 'string' || !validToken(key) || !safeCount(value)) return false
        this.#dmCursors.set(key, value)
      }
      const me = this.#o.me
      for (const item of raw.pending) {
        const entry = plain(item, ['attempts', 'code', 'envelope', 'epoch', 'hash', 'kind', 'seq', 'stream'])
        const header = entry && peek(entry.envelope)
        const fields = entry && plain(entry.envelope, ['ciphertext', 'commit', 'deviceId', 'epoch', 'groupId', 'messageId', 'nonce', 'senderId', 'sentAt', 'signature', 'version'])
        if (!entry || !header || !fields || (entry.kind !== 'g' && entry.kind !== 'd' && entry.kind !== 'r') || typeof entry.code !== 'string' || !safeCount(entry.attempts) || !safeCount(entry.epoch)
          || !safePositive(entry.seq) || typeof entry.stream !== 'string' || typeof entry.hash !== 'string' || !fromB64(entry.hash, 32)
          || typeof fields.messageId !== 'string' || typeof fields.commit !== 'string' || !safePositive(fields.sentAt)
          || header.groupId !== this.#o.groupId || header.senderId !== me.userId || header.deviceId !== me.deviceId || this.#pending.has(entry.stream)
          || header.epoch !== entry.epoch) return false
        if (entry.hash !== chainHash({ groupId: header.groupId, senderId: header.senderId, deviceId: header.deviceId, messageId: fields.messageId, commit: fields.commit })) return false
        if (entry.kind === 'g'
          ? entry.stream !== groupStream(this.#o.groupId, entry.epoch, me.userId, me.deviceId) || entry.code !== ''
          : !validToken(entry.code) || !entry.stream.startsWith(`d:${this.#o.groupId}:${entry.code}:${me.userId}/${me.deviceId}>`)) return false
        // A group envelope of an epoch we have left is dead (the same rule as #pruneEpochs); its chain was dropped with the epoch, so it must not be compared with it.
        if (entry.kind === 'g' && entry.epoch !== (this.#o.keyring.hasKey ? this.#o.keyring.epoch : 0)) continue
        const next = this.#o.sendChains.next(entry.stream)
        if (!next) continue
        if (next.seq < entry.seq) return false // within one epoch the chain snapshot is older than this envelope's predecessors: the two were not saved together
        if (next.seq > entry.seq) continue // already committed (the chain was saved after the relay answered): nothing to resend
        // It may have reached the relay before the process stopped: it is always a resend.
        this.#pending.set(entry.stream, Object.freeze({ stream: entry.stream, kind: entry.kind, code: entry.code, envelope: entry.envelope as ChatEnvelopeV2,
          seq: entry.seq, hash: entry.hash, epoch: entry.epoch, attempts: Math.max(1, entry.attempts) }))
      }
      return true
    } catch { return false }
  }

  // ---- send -------------------------------------------------------------------------------------------------------------------------

  /** Length, text validity and the secret hint. A hint is advice: call again with confirmedSecret: true to send anyway. */
  prepare(text: string, options: Readonly<{ confirmedSecret?: boolean }> = {}): Readonly<{ ok: true; text: string }> | Fail<PrepareFailure> {
    if (typeof text !== 'string' || hasUnpairedSurrogate(text)) return fail('invalid')
    const trimmed = text.trim()
    // a text that would show as nothing (only invisible characters) is blank too: the receiver would drop it and see a gap
    if (trimmed.length === 0 || !hasVisibleText(sanitizeChatText(trimmed))) return fail('blank')
    if (new TextEncoder().encode(trimmed).length > CHAT_CLIENT_MAX_TEXT_BYTES) return fail('too-long')
    if (secretHint(trimmed) && options.confirmedSecret !== true) return fail('secret-hint')
    return Object.freeze({ ok: true as const, text: trimmed })
  }

  /** Builds the envelope for one stream. Does not touch the chain: that moves when the relay accepts it. */
  #seal(kind: FrameKind, text: string, stream: string, code: string, epoch: number, messageKey: Uint8Array): Sealed | Fail<'stream-full' | 'seal'> {
    const next = this.#o.sendChains.next(stream)
    if (!next) return fail('stream-full')
    const frame = encodeFrame(kind, next.seq, next.prev, text)
    if (!frame) return fail('seal')
    let messageId = ''
    let nonce = ''
    let opening: Uint8Array | null = null
    let keyCopy: Uint8Array | null = null
    try {
      const idBytes = copyBytes(this.#random(16), 16)
      const nonceBytes = copyBytes(this.#random(24), 24)
      opening = copyBytes(this.#random(32), 32)
      if (!idBytes || !nonceBytes || !opening) return fail('seal')
      messageId = toB64(idBytes)
      nonce = toB64(nonceBytes)
      keyCopy = new Uint8Array(messageKey)
      const envelope = createChatEnvelope({
        groupId: this.#o.groupId, senderId: this.#o.me.userId, deviceId: this.#o.me.deviceId, messageId, sentAt: this.#o.now(), epoch, nonce,
        plaintext: frame, opening, groupKey: keyCopy, uniquenessStore: this.#sent, sign: this.#o.me.sign,
      })
      return Object.freeze({ stream, kind, code, envelope, seq: next.seq, hash: chainHash(envelope), epoch, attempts: 0 })
    } catch {
      return fail('seal')
    } finally { wipe(opening, keyCopy) }
  }

  /** Drops the chain and order state of epochs we have left (a new epoch starts every stream again at 1). */
  #pruneEpochs(): void {
    const epoch = this.#o.keyring.hasKey ? this.#o.keyring.epoch : 0
    if (epoch === this.#prunedEpoch) return
    this.#prunedEpoch = epoch
    const prefix = `g:${this.#o.groupId}:`
    const keep = (stream: string): boolean => !stream.startsWith(prefix) || stream.slice(prefix.length).startsWith(`${epoch}:`)
    this.#o.sendChains.retain(keep)
    this.#o.tracker.retain(keep)
    for (const [stream, sealed] of this.#pending) if (sealed.kind === 'g' && sealed.epoch !== epoch) this.#pending.delete(stream)
  }

  async #attempt(transport: ChatTransport, stream: string): Promise<'sent' | 'queued' | 'rejected'> {
    const sealed = this.#pending.get(stream)
    if (!sealed) return 'rejected'
    if (this.#o.now() - sealed.envelope.sentAt > PENDING_MAX_AGE_MS) {
      // too old for the relay's one-hour window: give it up but keep its place in the chain (a receiver that never saw it reports a gap, not a fork)
      this.#pending.delete(stream)
      this.#o.sendChains.commit(sealed.stream, sealed.seq, sealed.hash)
      return 'rejected'
    }
    const options = Object.freeze({ resend: sealed.attempts > 0 })
    let result: TransportResult
    try { result = sealed.kind === 'g' ? await transport.publish(sealed.envelope, options) : await transport.dmSend(sealed.code, sealed.envelope, options) } catch { result = { ok: false, kind: 'retry' } }
    if (this.#pending.get(stream) !== sealed) return 'queued' // not ours any more (cannot happen while calls are serialized)
    if (result && result.ok === true) return this.#delivered(stream, sealed)
    if (result && result.ok === false && result.kind === 'duplicate') return this.#delivered(stream, sealed)
    if (result && result.ok === false && result.kind === 'rejected') { this.#pending.delete(stream); return 'rejected' }
    // 'retry' - and anything the transport answered that we do not understand: not knowing is not a rejection
    this.#pending.set(stream, Object.freeze({ ...sealed, attempts: sealed.attempts + 1 }))
    return 'queued'
  }

  #delivered(stream: string, sealed: Sealed): 'sent' {
    this.#pending.delete(stream)
    this.#o.sendChains.commit(sealed.stream, sealed.seq, sealed.hash)
    return 'sent'
  }

  async #flush(transport: ChatTransport): Promise<Readonly<{ sent: number; queued: number; rejected: number }>> {
    this.#pruneEpochs()
    let sent = 0
    let queued = 0
    let rejected = 0
    for (const stream of [...this.#pending.keys()]) {
      const status = await this.#attempt(transport, stream)
      if (status === 'sent') sent++; else if (status === 'queued') queued++; else rejected++
    }
    return Object.freeze({ sent, queued, rejected })
  }

  /** Re-sends everything that is waiting. */
  flush(transport: ChatTransport): Promise<Readonly<{ sent: number; queued: number; rejected: number }>> {
    return this.#serial(() => this.#flush(transport))
  }

  /** `getKey` runs only once the stream's slot is free: asking a rekey session for a send key COUNTS a message against its 100/120 budget, so a send that is turned away must not ask. It also wipes what it hands out. */
  async #sendOne(transport: ChatTransport, kind: FrameKind, text: string, stream: string, code: string, getKey: () => KeyChoice): Promise<Readonly<{ status: DeliveryStatus | 'blocked-by-pending' | 'failed'; messageId?: string; reason?: string }>> {
    if (this.#pending.has(stream) && (await this.#attempt(transport, stream)) === 'queued') return { status: 'blocked-by-pending' }
    if (this.#pending.size >= MAX_PENDING) return { status: 'failed', reason: 'pending' }
    if (this.#persistFailing) { // storing failed last time: find out whether it works again BEFORE a message is counted against the session's budget
      try { this.#o.persistPending(this.snapshot(), this.#o.sendChains.snapshot()); this.#persistFailing = false } catch { return { status: 'failed', reason: 'persist' } }
    }
    const choice = getKey()
    if (!choice.ok) return { status: 'failed', reason: choice.reason }
    let sealed: Sealed | Fail<'stream-full' | 'seal'>
    try { sealed = this.#seal(kind, text, stream, code, choice.epoch, choice.key) } finally { wipe(choice.key) }
    if (!('envelope' in sealed)) return { status: 'failed', reason: sealed.reason }
    this.#pending.set(stream, sealed)
    try { this.#o.persistPending(this.snapshot(), this.#o.sendChains.snapshot()) } catch { this.#pending.delete(stream); this.#persistFailing = true; return { status: 'failed', reason: 'persist' } }
    return { status: await this.#attempt(transport, stream), messageId: sealed.envelope.messageId }
  }

  sendGroup(transport: ChatTransport, text: string, options: Readonly<{ confirmedSecret?: boolean }> = {}): Promise<SendResult> {
    return this.#serial(() => this.#sendGroup(transport, text, options))
  }

  async #sendGroup(transport: ChatTransport, text: string, options: Readonly<{ confirmedSecret?: boolean }>): Promise<SendResult> {
    const prepared = this.prepare(text, options)
    if (!prepared.ok) return prepared
    this.#pruneEpochs()
    const current = this.#o.keyring.current()
    if (!current) return fail('no-key')
    const messageKey = groupMessageKey(current.key, this.#o.groupId, current.epoch)
    wipe(current.key)
    if (!messageKey) return fail('seal')
    try {
      const stream = groupStream(this.#o.groupId, current.epoch, this.#o.me.userId, this.#o.me.deviceId)
      const outcome = await this.#sendOne(transport, 'g', prepared.text, stream, '', () => Object.freeze({ ok: true as const, epoch: current.epoch, key: new Uint8Array(messageKey) }))
      if (outcome.status === 'sent') return Object.freeze({ ok: true as const, messageId: outcome.messageId! })
      if (outcome.status === 'blocked-by-pending') return fail('pending')
      if (outcome.status === 'queued') return fail('transport')
      if (outcome.status === 'rejected') return fail('rejected')
      return fail((outcome.reason === 'stream-full' ? 'stream-full' : outcome.reason === 'pending' ? 'pending' : outcome.reason === 'persist' ? 'persist' : 'seal') as SendFailure)
    } finally { wipe(messageKey) }
  }

  /** B2: one envelope per recipient device - every device of the peer and every other device of ours - each posted to the same DM mailbox. */
  sendDm(transport: ChatTransport, input: Readonly<{ code: string; peerUserId: string; text: string; confirmedSecret?: boolean }>): Promise<DmSendResult> {
    return this.#serial(() => this.#sendDm(transport, input))
  }

  async #sendDm(transport: ChatTransport, input: Readonly<{ code: string; peerUserId: string; text: string; confirmedSecret?: boolean }>): Promise<DmSendResult> {
    const prepared = this.prepare(input.text, { confirmedSecret: input.confirmedSecret })
    if (!prepared.ok) return prepared
    if (!validToken(input.code) || !validToken(input.peerUserId) || input.peerUserId === this.#o.me.userId) return fail('seal')
    const peerDevices = this.#o.roster.devices(input.peerUserId)
    if (peerDevices.length === 0) return fail('no-recipient')
    const recipients = [
      ...peerDevices.map(device => ({ userId: input.peerUserId, device })),
      ...this.#o.roster.devices(this.#o.me.userId).filter(device => device.deviceId !== this.#o.me.deviceId).map(device => ({ userId: this.#o.me.userId, device })),
    ]
    this.#pruneEpochs()
    const results: { deviceId: string; status: DeliveryStatus | 'blocked-by-pending' | 'failed'; messageId?: string; reason?: string }[] = []
    for (const { userId, device } of recipients) {
      const peer: Peer = { code: input.code, userId, deviceId: device.deviceId }
      const stream = dmStream(this.#o.groupId, input.code, this.#o.me.userId, this.#o.me.deviceId, userId, device.deviceId)
      results.push({ deviceId: device.deviceId, ...(await this.#sendOne(transport, 'd', prepared.text, stream, input.code, () => this.#dmSendKey(peer, device.encKey))) })
    }
    await this.#maintain(transport)
    return Object.freeze({ ok: results.every(result => result.status === 'sent'), results: Object.freeze(results) })
  }

  // ---- B3: periodic rekey of every device pair (direct messages) ------------------------------------------------------------------------
  //
  // Generation 0 is the static key of the device pair (B2). The first rekey, and one after 100 messages or 7 days, run chat-rekey.ts's signed ephemeral exchange; its
  // three messages travel as ordinary DM envelopes with frame kind "r" (the relay sees nothing new). From generation 1 on, messages are sealed under keys derived
  // from the session key (envelope epoch = generation) and the static key is refused for that device pair (no downgrade). Group chat is NOT covered: it has the
  // epoch rotation on membership change (A3) but no per-message-count rekey.

  #sessionKey(peer: Peer): string { return `${peer.code}|${peer.userId}/${peer.deviceId}` }

  /** The B3 session with one peer device, created on first use from the device list's keys; null if the roster has no fresh key for that device. */
  #dmSession(peer: Peer, create = true): RekeySession | null {
    const device = this.#o.roster.device(peer.userId, peer.deviceId)
    if (!device) return null
    const key = this.#sessionKey(peer)
    if (this.#broken.has(key)) return null
    const known = this.#sessions.get(key)
    if (known && known.signKey !== device.signKey) { known.session.wipe(); this.#sessions.delete(key); this.#rekeySnapshots.delete(key) } // the device's key changed: the old session means nothing
    else if (known) return known.session
    if (!create && !this.#rekeySnapshots.has(key)) return null // a mailbox is shared by all devices: an envelope we have not decrypted is nobody's business
    if (this.#sessions.size >= MAX_SESSIONS) return null
    const ids = [`${this.#o.me.userId}/${this.#o.me.deviceId}`, `${peer.userId}/${peer.deviceId}`].sort()
    const conversationId = `dm${toB64(nobleSha256(new TextEncoder().encode(JSON.stringify(['friends-chat/rekey-conversation/v1', this.#o.groupId, peer.code, ids[0], ids[1]])))).slice(0, 40)}`
    const config = { conversationId, local: { userId: this.#o.me.userId, deviceId: this.#o.me.deviceId }, remote: { userId: peer.userId, deviceId: peer.deviceId },
      remoteDevicePublicKey: device.signKey, sign: this.#o.me.sign, random: this.#random, verify: this.#o.verify }
    const stored = this.#rekeySnapshots.get(key)
    const session = RekeySession.create(config, stored)
    if (!session) {
      // The stored state cannot be used. Starting a fresh generation-0 session would quietly bring the static key back while the peer is on a later generation: the pair is marked broken instead.
      if (stored !== undefined) this.#broken.add(key) // the raw state stays in #rekeySnapshots (and so in every snapshot): each restart judges it again, and only resetDmSession removes it
      return null
    }
    this.#rekeySnapshots.delete(key) // the live session now owns that state; keeping the raw copy would keep old generation keys in memory
    this.#sessions.set(key, { session, signKey: device.signKey, peer, lastConfirmAt: 0 })
    return session
  }

  /** The key (and envelope epoch) for the next message to one device: the rekeyed generation if there is one, else the static key. */
  #dmSendKey(peer: Peer, recipientEncKey: string): KeyChoice {
    const context: DmKeyContext = { groupId: this.#o.groupId, code: peer.code, sender: { userId: this.#o.me.userId, deviceId: this.#o.me.deviceId }, recipient: { userId: peer.userId, deviceId: peer.deviceId } }
    const session = this.#dmSession(peer)
    if (!session) return fail('rekey-unavailable') // broken state or no room for another session: never fall back to the static key by accident
    {
      const next = session.nextSendKey(this.#o.now())
      if (next.ok) {
        const key = dmRekeyedMessageKey(next.key, context, next.generation)
        wipe(next.key)
        return key ? Object.freeze({ ok: true as const, epoch: next.generation, key }) : fail('key')
      }
      if (next.reason !== 'no-key') return fail(`rekey-${next.reason}`) // overdue (peer silent for a week), stalled, wiped
    }
    const key = dmMessageKey(this.#o.me.encPrivate, recipientEncKey, context)
    return key ? Object.freeze({ ok: true as const, epoch: DM_EPOCH, key }) : fail('key')
  }

  /** true: finished with this message (sent, waiting in the send queue, refused for good, or pointless because the device or session is gone); false: try again later. */
  async #sendControl(transport: ChatTransport, peer: Peer, message: unknown): Promise<boolean> {
    const device = this.#o.roster.device(peer.userId, peer.deviceId)
    if (!device) return true
    const stream = dmStream(this.#o.groupId, peer.code, this.#o.me.userId, this.#o.me.deviceId, peer.userId, peer.deviceId)
    const outcome = await this.#sendOne(transport, 'r', JSON.stringify(message), stream, peer.code, () => this.#dmSendKey(peer, device.encKey))
    if (outcome.status === 'blocked-by-pending') return false
    if (outcome.status === 'failed') return outcome.reason !== 'pending' && outcome.reason !== 'persist'
    if ((message as { kind?: unknown } | null)?.kind === 'rekey-confirm') { const entry = this.#sessions.get(this.#sessionKey(peer)); if (entry) entry.lastConfirmAt = this.#o.now() }
    return true
  }

  /** Answers queued by received control messages, then whatever each session wants to say now (expiry, re-sent confirm, a new rekey). */
  async #maintain(transport: ChatTransport): Promise<void> {
    // sessions restored from storage are opened here, so that their timers run even if nobody has used the pair since the restart
    for (const key of [...this.#rekeySnapshots.keys()]) {
      const [code, rest] = key.split('|')
      const [userId, deviceId] = (rest ?? '').split('/')
      if (code && userId && deviceId) this.#dmSession({ code, userId, deviceId }, false)
    }
    for (const control of [...this.#controls]) {
      if (await this.#sendControl(transport, control.peer, control.message)) this.#controls = this.#controls.filter(known => known !== control) // kept (and stored) until it is sent
    }
    const now = this.#o.now()
    for (const [key, entry] of [...this.#sessions]) {
      // A device that a FRESH list no longer names was revoked: its session means nothing. An expired or missing list says nothing about it (a relay could hold a new list back
      // for two weeks and make every session vanish): the session sleeps until a fresh list arrives.
      if (this.#o.roster.status(entry.peer.userId) === 'fresh' && !this.#o.roster.device(entry.peer.userId, entry.peer.deviceId)) {
        entry.session.wipe(); this.#sessions.delete(key); this.#rekeySnapshots.delete(key); continue
      }
      const session = entry.session
      session.status(now) // expiry and wiping happen inside the next call: this is that call
      const confirm = session.pendingConfirm(now)
      if (confirm && now - entry.lastConfirmAt >= CONFIRM_RESEND_MS) { entry.lastConfirmAt = now; await this.#sendControl(transport, entry.peer, confirm) }
      // the first exchange (no generation yet) is not "due" in the module's sense: it is simply wanted; later ones are due after 100 messages or 7 days
      if (session.generation === 0 || session.rekeyDue(now)) {
        const started = session.startRekey(now)
        if (started.ok) await this.#sendControl(transport, entry.peer, started.message)
      }
    }
    this.#storeIfChanged() // old keys wiped above must not stay on disk
  }

  #storeIfChanged(): void {
    try {
      const snapshot = this.snapshot()
      const chains = this.#o.sendChains.snapshot()
      // compared by hash (no second copy of the live keys is kept) and without the sessions' `clock`, which moves with every call and says nothing new
      const text = JSON.stringify([snapshot, chains], (key, value) => (key === 'clock' ? undefined : value))
      const digest = toB64(nobleSha256(new TextEncoder().encode(text)))
      if (digest === this.#lastStored) return
      this.#o.persistPending(snapshot, chains)
      this.#lastStored = digest
    } catch { /* the next send stores again before anything leaves */ }
  }

  /** Runs the rekey housekeeping (expiry of old keys, re-sent confirms, due rekeys). Call it from time to time; polling and sending do it as well. */
  maintain(transport: ChatTransport): Promise<void> {
    return this.#serial(() => this.#maintain(transport))
  }

  /** What the screen needs to say about the encryption of one device pair: the generation in use and whether the session is stuck. Null: no session. */
  dmSecurity(code: string, peerUserId: string, peerDeviceId: string): ReturnType<RekeySession['status']> | null {
    const key = this.#sessionKey({ code, userId: peerUserId, deviceId: peerDeviceId })
    this.#dmSession({ code, userId: peerUserId, deviceId: peerDeviceId }, false) // opens a stored state, if there is one
    if (this.#broken.has(key)) return Object.freeze({ generation: 0, sent: 0, received: 0, ageMs: 0, due: false, overdue: false, stalled: true, awaitingAck: false, pending: 'none' as const })
    const entry = this.#sessions.get(key)
    return entry ? entry.session.status(this.#o.now()) : null
  }

  /** Throws one device pair's session away (after `stalled`, or `rekey-overdue` once the peer is back). The pair starts again with the static key; the other device must do the same. */
  resetDmSession(code: string, peerUserId: string, peerDeviceId: string): Promise<boolean> {
    return this.#serial(async () => {
      const key = this.#sessionKey({ code, userId: peerUserId, deviceId: peerDeviceId })
      const entry = this.#sessions.get(key)
      entry?.session.wipe()
      this.#sessions.delete(key)
      const stored = this.#rekeySnapshots.delete(key)
      const marked = this.#broken.delete(key)
      const had = stored || marked || entry !== undefined
      this.#controls = this.#controls.filter(control => this.#sessionKey(control.peer) !== key)
      try { this.#o.persistPending(this.snapshot(), this.#o.sendChains.snapshot()) } catch { /* stored again by the next send */ }
      return had
    })
  }

  /** One waiting answer of each kind per device pair (a newer one replaces an older one), at most MAX_CONTROLS in all. */
  #queueControl(control: Control): void {
    const kind = (control.message as { kind?: unknown } | null)?.kind
    const pair = this.#sessionKey(control.peer)
    this.#controls = this.#controls.filter(known => !(this.#sessionKey(known.peer) === pair && (known.message as { kind?: unknown } | null)?.kind === kind))
    this.#controls.push(control)
    if (this.#controls.length > MAX_CONTROLS) this.#controls = this.#controls.slice(this.#controls.length - MAX_CONTROLS)
  }

  #control(peer: Peer, body: string): void {
    const session = this.#dmSession(peer)
    if (!session) return
    let message: unknown
    try { message = JSON.parse(body) } catch { return }
    const kind = (message as { kind?: unknown } | null)?.kind
    const now = this.#o.now()
    if (kind === 'rekey-init') {
      const answer = session.handleInit(message, now)
      if (answer.ok) this.#queueControl({ peer, message: answer.message })
    } else if (kind === 'rekey-response') {
      const answer = session.handleResponse(message, now)
      if (answer.ok) this.#queueControl({ peer, message: answer.message })
    } else if (kind === 'rekey-confirm') session.handleConfirm(message, now)
    try { this.#o.persistPending(this.snapshot(), this.#o.sendChains.snapshot()) } catch { /* the answer is not sent unless its state can be stored: #sendOne stores again before it sends */ }
  }

  // ---- receive ----------------------------------------------------------------------------------------------------------------------

  #finish(kind: 'group' | 'dm', box: string, expected: FrameKind, stream: string, result: ReturnType<typeof verifyAndDecryptChatEnvelope>, peer?: Peer): OpenResult {
    if (!result.ok) return fail(result.reason)
    const frame = parseFrame(result.plaintext)
    if (!frame) return fail('frame')
    if (frame.kind !== expected && !(kind === 'dm' && frame.kind === 'r')) return fail('context')
    const envelope = result.envelope
    // the order is recorded as soon as the sender's frame is valid, even if the text then turns out to show as nothing: that sequence number is used up
    const order = this.#o.tracker.observe(stream, frame.seq, frame.prev, chainHash(envelope))
    if (frame.kind === 'r') { this.#control(peer!, frame.body); return fail('control') } // rekey traffic never reaches the screen
    const text = sanitizeChatText(frame.body).trim()
    if (!hasVisibleText(text)) return fail('blank')
    return Object.freeze({ ok: true as const, kind, box, messageId: envelope.messageId, senderId: envelope.senderId, deviceId: envelope.deviceId,
      sentAt: envelope.sentAt, text, order, report: Object.freeze({ envelope, text: result.plaintext, opening: result.opening }) })
  }

  openGroup(value: unknown): OpenResult {
    this.#pruneEpochs()
    const header = peek(value)
    if (!header) return fail('format')
    if (header.groupId !== this.#o.groupId) return fail('trust')
    if (header.senderId === this.#o.me.userId && header.deviceId === this.#o.me.deviceId) return fail('self')
    const sender = this.#o.roster.device(header.senderId, header.deviceId)
    if (!sender) return fail('unknown-device')
    const current = this.#o.keyring.current()
    if (!current) return fail('no-key')
    if (header.epoch !== current.epoch) { wipe(current.key); return fail(header.epoch > current.epoch ? 'epoch-ahead' : 'epoch-stale') }
    const messageKey = groupMessageKey(current.key, this.#o.groupId, current.epoch)
    wipe(current.key)
    if (!messageKey) return fail('adapter')
    const result = verifyAndDecryptChatEnvelope(value, { expectedGroupId: this.#o.groupId, expectedSenderId: header.senderId, expectedDeviceId: header.deviceId,
      trustedSenderDevicePublicKey: sender.signKey, currentEpoch: current.epoch, groupKey: messageKey, now: this.#o.now(),
      maxMessageAgeMs: CHAT_RECEIVE_MAX_AGE_MS, maxFutureSkewMs: CHAT_RECEIVE_MAX_FUTURE_MS, replayStore: this.#replay }, this.#o.verify)
    wipe(messageKey)
    return this.#finish('group', this.#o.groupId, 'g', groupStream(this.#o.groupId, current.epoch, header.senderId, header.deviceId), result)
  }

  openDm(input: Readonly<{ code: string; peerUserId: string; value: unknown }>): OpenResult {
    const header = peek(input.value)
    if (!header || !validToken(input.code) || !validToken(input.peerUserId)) return fail('format')
    if (header.groupId !== this.#o.groupId) return fail('trust')
    if (header.senderId !== input.peerUserId && header.senderId !== this.#o.me.userId) return fail('sender')
    if (header.senderId === this.#o.me.userId && header.deviceId === this.#o.me.deviceId) return fail('self')
    const sender = this.#o.roster.device(header.senderId, header.deviceId)
    if (!sender) return fail('unknown-device')
    const peer: Peer = { code: input.code, userId: header.senderId, deviceId: header.deviceId }
    if (this.#broken.has(this.#sessionKey(peer))) return fail('stalled')
    const context: DmKeyContext = { groupId: this.#o.groupId, code: input.code, sender: { userId: header.senderId, deviceId: header.deviceId }, recipient: { userId: this.#o.me.userId, deviceId: this.#o.me.deviceId } }
    const generation = header.epoch
    const session = this.#dmSession(peer, false)
    if (this.#broken.has(this.#sessionKey(peer))) return fail('stalled') // the mark is set by the call above when a stored state turns out to be unusable
    const now = this.#o.now()
    let messageKey: Uint8Array | null
    let staticControlOnly = false
    if (generation === DM_EPOCH) {
      // The static key is for the first contact. Once a session key exists for this device pair it is refused (a stolen static key must not bring the pair back) - except
      // (1) while the peer has not yet shown that it switched (it answered our init and may have written before our confirm arrived), and (2) for signed rekey
      // messages, which need no secrecy: a fresh init from a peer that lost its state is how a stuck pair gets noticed (the session flags itself stalled).
      if (session) {
        const state = session.status(now)
        if (state.stalled || (session.generation > 0 && !state.awaitingAck)) staticControlOnly = true
      }
      messageKey = dmMessageKey(this.#o.me.encPrivate, sender.encKey, context)
    } else {
      if (!session) return fail('no-session')
      const opened = session.receiveKeyResult(generation, now)
      if (!opened.ok) {
        if (opened.reason === 'expired') return fail('epoch-stale')
        if (opened.reason === 'stalled' || opened.reason === 'wiped') return fail('stalled')
        // A generation we never held. NOT reported to the session as "the peer is ahead" (notePeerGeneration): the envelope signature does not say which mailbox it
        // belongs to, so a relay could move a validly signed group envelope into this DM box and stall the pair. Desync is detected from the signed rekey messages only.
        return fail('epoch-ahead')
      }
      messageKey = dmRekeyedMessageKey(opened.key, context, generation)
      wipe(opened.key)
    }
    if (!messageKey) return fail('adapter')
    const result = verifyAndDecryptChatEnvelope(input.value, { expectedGroupId: this.#o.groupId, expectedSenderId: header.senderId, expectedDeviceId: header.deviceId,
      trustedSenderDevicePublicKey: sender.signKey, currentEpoch: generation, groupKey: messageKey, now,
      maxMessageAgeMs: CHAT_RECEIVE_MAX_AGE_MS, maxFutureSkewMs: CHAT_RECEIVE_MAX_FUTURE_MS, replayStore: this.#replay }, this.#o.verify)
    wipe(messageKey)
    if (staticControlOnly && result.ok && parseFrame(result.plaintext)?.kind !== 'r') return fail('epoch-stale')
    if (result.ok && generation > 0) session?.noteReceived(generation, now) // an authenticated message under this generation: the peer holds the key
    if (result.ok) this.#dmSession(peer) // an envelope that opened was meant for this device: the pair now has a session (the first rekey is started from here)
    return this.#finish('dm', input.code, 'd', dmStream(this.#o.groupId, input.code, header.senderId, header.deviceId, this.#o.me.userId, this.#o.me.deviceId), result, peer)
  }

  #report(box: string, sequence: number): boolean {
    const key = `${box}:${sequence}`
    if (this.#reported.has(key)) return false
    if (this.#reported.size >= REPORTED_LIMIT) this.#reported.clear()
    this.#reported.add(key)
    return true
  }

  #sweep(box: string, messages: readonly PollMessage[], after: number, open: (envelope: unknown) => OpenResult, quiet: ReadonlySet<string>): Readonly<{ summary: Omit<PollSummary, 'flushed'>; cursor: number }> {
    const delivered: ReceivedMessage[] = []
    const dropped: { sequence: number; reason: OpenFailure }[] = []
    let heldFrom = Number.POSITIVE_INFINITY
    let highest = after
    let held = 0
    // A relay that lies about sequence numbers must not be able to push the cursor out of reach or hand us unbounded work.
    const ordered = messages.filter(message => message && safePositive(message.sequence) && message.sequence > after && message.sequence - after <= MAX_CURSOR_JUMP)
      .sort((left, right) => left.sequence - right.sequence).slice(0, MAX_BATCH)
    for (const message of ordered) {
      const opened = open(message.envelope)
      if (opened.ok) delivered.push(opened)
      else if (HELD.has(opened.reason)) {
        // sentAt is not verified yet here (the signature has not been checked): a missing, absurd or far-future value must not keep a message waiting for ever
        const sentAt = (message.envelope as { sentAt?: unknown } | null)?.sentAt
        if (typeof sentAt !== 'number' || !Number.isFinite(sentAt) || sentAt > this.#o.now() + CHAT_RECEIVE_MAX_FUTURE_MS || this.#o.now() - sentAt > CHAT_RECEIVE_MAX_AGE_MS) {
          if (this.#report(box, message.sequence)) dropped.push({ sequence: message.sequence, reason: 'time' }) // too old (or not believable): stop waiting
        } else { held++; heldFrom = Math.min(heldFrom, message.sequence) }
      } else if (opened.reason !== 'self' && opened.reason !== 'replay' && !quiet.has(opened.reason)) {
        if (this.#report(box, message.sequence)) dropped.push({ sequence: message.sequence, reason: opened.reason })
      }
      highest = Math.max(highest, message.sequence)
    }
    const cursor = Number.isFinite(heldFrom) ? Math.max(after, heldFrom - 1) : highest
    return { summary: Object.freeze({ delivered: Object.freeze(delivered), dropped: Object.freeze(dropped), held }), cursor }
  }

  pollGroup(transport: ChatTransport): Promise<PollSummary | Fail<'transport'>> {
    return this.#serial(async () => {
      const flushed = await this.#flush(transport)
      let polled: PollResult
      try { polled = await transport.poll(this.#groupCursor) } catch { return fail('transport') }
      if (!polled || !polled.ok || !Array.isArray(polled.messages)) return fail('transport')
      const { summary, cursor } = this.#sweep(this.#o.groupId, polled.messages, this.#groupCursor, envelope => this.openGroup(envelope), NOTHING)
      this.#groupCursor = cursor
      return Object.freeze({ ...summary, flushed })
    })
  }

  /** At most ten mailboxes per call (the relay's batch limit); `peerUserId` says who the other person of each box is. */
  pollDm(transport: ChatTransport, boxes: readonly Readonly<{ code: string; peerUserId: string }>[]): Promise<Readonly<Record<string, PollSummary>> | Fail<'transport'>> {
    return this.#serial(async () => {
      if (boxes.length === 0 || boxes.length > 10) return fail('transport')
      const flushed = await this.#flush(transport)
      let polled: DmPollResult
      try { polled = await transport.dmPoll(boxes.map(box => ({ code: box.code, after: this.#dmCursors.get(box.code) ?? 0 }))) } catch { return fail('transport') }
      if (!polled || !polled.ok || !polled.boxes || typeof polled.boxes !== 'object') return fail('transport')
      const out = new Map<string, PollSummary>()
      for (const box of boxes) {
        const entry = Object.hasOwn(polled.boxes, box.code) ? polled.boxes[box.code] : undefined
        if (!entry || !Array.isArray(entry.messages)) continue
        const after = this.#dmCursors.get(box.code) ?? 0
        const { summary, cursor } = this.#sweep(`dm:${box.code}`, entry.messages, after, envelope => this.openDm({ code: box.code, peerUserId: box.peerUserId, value: envelope }), DM_QUIET)
        this.#dmCursors.set(box.code, cursor)
        out.set(box.code, Object.freeze({ ...summary, flushed }))
      }
      await this.#maintain(transport) // answers to rekey messages received above, expiry, due rekeys
      return Object.freeze(Object.fromEntries(out)) // fromEntries makes own properties even for a mailbox code such as "__proto__"
    })
  }

  /** Start reading every mailbox from the beginning again (the replay store makes sure nothing is shown twice). For a relay whose sequence numbers were reset. */
  resetCursors(): Promise<void> {
    return this.#serial(async () => {
      this.#groupCursor = 0
      this.#dmCursors.clear()
      this.#reported.clear()
    })
  }

  /** Envelopes waiting for the relay (ciphertext and signature only) and the poll cursors. Chains, tracker, replay store, keyring and roster have their own snapshots. */
  snapshot(): ClientSnapshot {
    return Object.freeze({
      version: 1 as const,
      pending: Object.freeze([...this.#pending.values()].map(sealed => Object.freeze({ ...sealed }))),
      cursors: Object.freeze({ group: this.#groupCursor, dm: Object.freeze(Object.fromEntries(this.#dmCursors)) }),
      rekey: Object.freeze(this.#rekeyStates()),
      controls: Object.freeze(this.#controls.map(control => Object.freeze({ peer: control.peer, message: control.message }))),
    })
  }

  #rekeyStates(): Record<string, RekeySnapshot> {
    const out = new Map<string, RekeySnapshot>(this.#rekeySnapshots)
    for (const [key, entry] of this.#sessions) {
      const state = entry.session.snapshot(this.#o.now())
      if (state) out.set(key, state); else out.delete(key)
    }
    return Object.fromEntries(out)
  }
}
