import { nobleSha256 } from './noble-crypto.js'
import { RULES } from './redact.ts'
import { encoder, fromB64, plain, safeCount, safePositive, toB64 } from './chat-codec.ts'

// A2 (CHAT3-CLIENT): per-stream sequence numbers and a hash chain, carried in a frame at the front of the AEAD text.
//
//   frame = "F1." + kind + "." + seq + "." + prev + "." + body        kind: g = group mailbox, d = direct-message mailbox
//
// The envelope format is unchanged (the relay validates exactly eleven fields); the frame is inside the AEAD payload, so it is
// authenticated by the AEAD, signed (the signature covers the ciphertext) and bound by the commitment (the record text is the whole frame).
// `prev` is the chain hash of the previous message of the SAME stream (one sender device -> its readers in one epoch / one DM box), or
// FRAME_GENESIS for the first one. Not detected, by construction: the last messages of a stream being dropped (nothing after them to compare)
// and anything across streams (there is no order between different senders).

export const FRAME_GENESIS = 'A'.repeat(43)
/** Highest sequence number (nine digits); a stream that reaches it needs a new epoch / new DM box. */
export const MAX_SEQ = 999_999_999
/** The text budget of an envelope is 2,000 bytes; the frame header takes at most 59 of them, the rest is rounded down for headroom. */
export const CHAT_CLIENT_MAX_TEXT_BYTES = 1_900
/** How many recent messages per stream the receiver remembers for the order checks. */
export const SEQ_WINDOW = 256
const MAX_STREAMS = 512
const streamPattern = /^[A-Za-z0-9_:>/.-]{1,640}$/
const framePattern = /^F1\.([gdr])\.([1-9][0-9]{0,8})\.([A-Za-z0-9_-]{43})\./
const hashPattern = /^[A-Za-z0-9_-]{43}$/

/** g: group message, d: direct message, r: a rekey control message (B3), only in direct-message mailboxes. */
export type FrameKind = 'g' | 'd' | 'r'
export type Frame = Readonly<{ kind: FrameKind; seq: number; prev: string; body: string }>

export function encodeFrame(kind: FrameKind, seq: number, prev: string, body: string): string | null {
  if ((kind !== 'g' && kind !== 'd' && kind !== 'r') || !safePositive(seq) || seq > MAX_SEQ || !hashPattern.test(prev) || !fromB64(prev, 32) || typeof body !== 'string' || body.length === 0) return null
  return `F1.${kind}.${seq}.${prev}.${body}`
}

export function parseFrame(text: unknown): Frame | null {
  if (typeof text !== 'string') return null
  const match = framePattern.exec(text)
  if (!match) return null
  const body = text.slice(match[0].length)
  const prev = match[3]!
  if (body.length === 0 || !fromB64(prev, 32)) return null
  return Object.freeze({ kind: match[1] as FrameKind, seq: Number(match[2]), prev, body })
}

export type ChainSource = Readonly<{ groupId: string; senderId: string; deviceId: string; messageId: string; commit: string }>
/** Hash that the next message of a stream names as `prev`. Built from fields every reader of the envelope has (signed, and the commit covers the text). */
export const chainHash = (envelope: ChainSource): string => toB64(nobleSha256(encoder.encode(JSON.stringify([
  'friends-chat/chain/v1', envelope.groupId, envelope.senderId, envelope.deviceId, envelope.messageId, envelope.commit,
]))))

// Stream names carry the USER as well as the device: device ids are only unique inside one user's signed list, so two users' same-named devices must not share a counter or a chain.
export const groupStream = (groupId: string, epoch: number, senderUserId: string, senderDeviceId: string): string => `g:${groupId}:${epoch}:${senderUserId}/${senderDeviceId}`
export const dmStream = (groupId: string, code: string, senderUserId: string, senderDeviceId: string, recipientUserId: string, recipientDeviceId: string): string =>
  `d:${groupId}:${code}:${senderUserId}/${senderDeviceId}>${recipientUserId}/${recipientDeviceId}`

export type SendChainsSnapshot = Readonly<{ version: 1; streams: readonly Readonly<{ stream: string; seq: number; hash: string }>[] }>

/** Sender side: the last COMMITTED (relay-accepted) message of each stream. The next message is seq+1 and names that hash. */
export class SendChains {
  readonly #streams = new Map<string, { seq: number; hash: string }>()
  private constructor() {}

  static create(snapshot?: SendChainsSnapshot): SendChains | null {
    const chains = new SendChains()
    if (snapshot === undefined) return chains
    const raw = plain(snapshot, ['streams', 'version'])
    if (!raw || raw.version !== 1 || !Array.isArray(raw.streams) || raw.streams.length > MAX_STREAMS) return null
    for (const stored of raw.streams) {
      const entry = plain(stored, ['hash', 'seq', 'stream'])
      if (!entry || typeof entry.stream !== 'string' || !streamPattern.test(entry.stream) || !safePositive(entry.seq) || entry.seq > MAX_SEQ
        || typeof entry.hash !== 'string' || !fromB64(entry.hash, 32) || chains.#streams.has(entry.stream)) return null
      chains.#streams.set(entry.stream, { seq: entry.seq, hash: entry.hash })
    }
    return chains
  }

  /** What the next message of the stream must carry, or null if the stream is full / the table is full. */
  next(stream: string): Readonly<{ seq: number; prev: string }> | null {
    if (typeof stream !== 'string' || !streamPattern.test(stream)) return null
    const last = this.#streams.get(stream)
    if (!last) return this.#streams.size >= MAX_STREAMS ? null : Object.freeze({ seq: 1, prev: FRAME_GENESIS })
    return last.seq >= MAX_SEQ ? null : Object.freeze({ seq: last.seq + 1, prev: last.hash })
  }

  /** Advances the stream once the relay has accepted (or already holds) the message. Only the very next sequence number is accepted. */
  commit(stream: string, seq: number, hash: string): boolean {
    const expected = this.next(stream)
    if (!expected || expected.seq !== seq || typeof hash !== 'string' || !fromB64(hash, 32)) return false
    this.#streams.set(stream, { seq, hash })
    return true
  }

  /** Forgets the streams that `keep` returns false for (old epochs). */
  retain(keep: (stream: string) => boolean): void {
    for (const stream of [...this.#streams.keys()]) if (!keep(stream)) this.#streams.delete(stream)
  }

  snapshot(): SendChainsSnapshot {
    return Object.freeze({ version: 1 as const, streams: Object.freeze([...this.#streams].map(([stream, last]) => Object.freeze({ stream, seq: last.seq, hash: last.hash }))) })
  }
}

export type OrderStatus = 'ok' | 'gap' | 'late' | 'fork' | 'rewind' | 'duplicate'
export type OrderResult = Readonly<{ status: OrderStatus; /** For `gap` and for a forked message ahead of the last seen one: how many sequence numbers were skipped. */ missing: number }>
type TrackedEntry = { seq: number; prev: string; hash: string }
type TrackedStream = { high: number; entries: TrackedEntry[] }
export type SeqTrackerSnapshot = Readonly<{
  version: 1
  streams: readonly Readonly<{ stream: string; high: number; entries: readonly (readonly [number, string, string])[] }>[]
}>

/** Receiver side: checks the order of verified messages per stream. It never rejects a message; it reports what it saw. */
export class SeqTracker {
  readonly #streams = new Map<string, TrackedStream>()
  private constructor() {}

  static create(snapshot?: SeqTrackerSnapshot): SeqTracker | null {
    const tracker = new SeqTracker()
    if (snapshot === undefined) return tracker
    const raw = plain(snapshot, ['streams', 'version'])
    if (!raw || raw.version !== 1 || !Array.isArray(raw.streams) || raw.streams.length > MAX_STREAMS) return null
    for (const stored of raw.streams) {
      const entry = plain(stored, ['entries', 'high', 'stream'])
      if (!entry || typeof entry.stream !== 'string' || !streamPattern.test(entry.stream) || !safeCount(entry.high) || entry.high > MAX_SEQ
        || !Array.isArray(entry.entries) || entry.entries.length > SEQ_WINDOW || tracker.#streams.has(entry.stream)) return null
      const entries: TrackedEntry[] = []
      for (const item of entry.entries) {
        if (!Array.isArray(item) || item.length !== 3 || !safePositive(item[0]) || item[0] > entry.high || typeof item[1] !== 'string' || !fromB64(item[1], 32)
          || typeof item[2] !== 'string' || !fromB64(item[2], 32) || entries.some(known => known.seq === item[0])) return null
        entries.push({ seq: item[0], prev: item[1], hash: item[2] })
      }
      tracker.#streams.set(entry.stream, { high: entry.high, entries })
    }
    return tracker
  }

  observe(stream: string, seq: number, prev: string, hash: string): OrderResult {
    if (typeof stream !== 'string' || !streamPattern.test(stream) || !safePositive(seq) || seq > MAX_SEQ) return Object.freeze({ status: 'fork' as const, missing: 0 })
    let state = this.#streams.get(stream)
    if (!state) {
      if (this.#streams.size >= MAX_STREAMS) this.#streams.delete(this.#streams.keys().next().value as string) // oldest stream starts over
      state = { high: 0, entries: [] }
      this.#streams.set(stream, state)
    }
    const known = state.entries.find(entry => entry.seq === seq)
    if (known) return Object.freeze({ status: known.hash === hash ? 'duplicate' as const : 'fork' as const, missing: 0 })
    if (seq <= state.high - SEQ_WINDOW) return Object.freeze({ status: 'rewind' as const, missing: 0 })
    const before = state.entries.find(entry => entry.seq === seq - 1)
    const after = state.entries.find(entry => entry.seq === seq + 1)
    const forked = (before !== undefined && before.hash !== prev) || (after !== undefined && after.prev !== hash) || (seq === 1 && prev !== FRAME_GENESIS)
    const missing = seq > state.high ? seq - state.high - 1 : 0
    const status: OrderStatus = forked ? 'fork' : seq > state.high ? (missing > 0 ? 'gap' : 'ok') : 'late'
    state.entries.push({ seq, prev, hash })
    if (seq > state.high) state.high = seq
    state.entries = state.entries.filter(entry => entry.seq > state.high - SEQ_WINDOW)
    return Object.freeze({ status, missing })
  }

  retain(keep: (stream: string) => boolean): void {
    for (const stream of [...this.#streams.keys()]) if (!keep(stream)) this.#streams.delete(stream)
  }

  snapshot(): SeqTrackerSnapshot {
    return Object.freeze({
      version: 1 as const,
      streams: Object.freeze([...this.#streams].map(([stream, state]) => Object.freeze({
        stream, high: state.high, entries: Object.freeze(state.entries.map(entry => Object.freeze([entry.seq, entry.prev, entry.hash] as const))),
      }))),
    })
  }
}

// What the screen shows must be plain text: control characters, bidirectional controls and invisible tag characters are removed
// (chat-types.ts promises "already clean" to the view layer). Line breaks and tabs stay; U+2028/2029 become line breaks. Invisible formatting
// characters (zero-width space, word joiner, soft hyphen, filler characters, variation selectors other than the emoji one) go too; U+200C/U+200D stay because
// emoji sequences and some scripts need them. The committed text (the report) is NOT cleaned: a screen that shows it must clean it the same way.
const DISPLAY_STRIP = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F-\u1160\u17B4-\u17B5\u180B-\u180F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u2800\u3164\uFE00-\uFE0E\uFEFF\uFFA0\uFFF9-\uFFFC]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu
// A text counts as visible only if something is left once joiners, variation selectors and white space are ignored.
const NOT_VISIBLE = /[\u200C\u200D\uFE0F\s]/g
export const hasVisibleText = (text: string): boolean => text.replace(NOT_VISIBLE, '').length > 0
export function sanitizeChatText(text: string): string {
  return text.replace(/[\u2028\u2029]/g, '\n').replace(DISPLAY_STRIP, '')
}

// "Secret hint": the sender is asked to confirm once when the text looks like a key, token or password (same patterns that redact.ts
// uses before classification; only the ones it labels [secret]). A hint is advice, not a block.
const SECRET_PATTERNS = RULES.filter(([, label]) => label === '[secret]').map(([pattern]) => new RegExp(pattern.source, pattern.flags.replace('g', '')))
export const secretHint = (text: string): boolean => SECRET_PATTERNS.some(pattern => pattern.test(text))
