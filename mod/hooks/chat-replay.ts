import type { ChatUniquenessStore } from './chat-envelope.ts'
import { plain, safeCount, safePositive } from './chat-codec.ts'

// A8 (CHAT3-CLIENT): a replay store that survives a restart and forgets only what the time window already covers.
//
// A claim is (messageId, epoch:nonce) taken at the local time `at`. A message is accepted only if its sentAt is within
// [now - maxMessageAgeMs, now + maxFutureSkewMs] (chat-envelope.ts checks this BEFORE it claims), so a replay of something claimed at `at`
// can still pass the time check until at + maxMessageAgeMs + maxFutureSkewMs. The caller passes that sum (plus a margin) as `windowMs`.
// Nothing younger than that is ever dropped, and when the table is full the store stops accepting rather than forgetting.
//
// `save` runs synchronously BEFORE a claim returns true; if it throws, the claim is undone and the error propagates (the envelope code then
// reports `adapter`): a message whose claim could not be written is not accepted, so a crash cannot turn it into a replay later.

export const REPLAY_MAX_ENTRIES = 10_000
const messageIdPattern = /^[A-Za-z0-9_-]{22}$/
const noncePattern = /^[A-Za-z0-9_-]{32}$/

export type ReplayEntry = readonly [messageId: string, epoch: number, nonce: string, at: number]
export type ReplaySnapshot = Readonly<{ version: 1; clock: number; entries: readonly ReplayEntry[] }>
export type PersistentReplayOptions = Readonly<{
  /** How long a claim must be remembered, in ms (max message age + max future skew + margin). */
  windowMs: number
  /** Wall clock, ms. Must not come from a message or the relay. The store keeps the highest value it has seen. */
  now(): number
  /** Writes the snapshot where the next start will find it. Throwing means "not saved". */
  save(snapshot: ReplaySnapshot): void
  snapshot?: ReplaySnapshot
  maxEntries?: number
}>
export type PersistentReplayStore = ChatUniquenessStore & Readonly<{ snapshot(): ReplaySnapshot; size(): number; /** How long a claim is remembered (the `windowMs` it was created with). */ windowMs: number }>

export function createPersistentReplayStore(options: PersistentReplayOptions): PersistentReplayStore | null {
  const raw = plain(options, Object.keys(options ?? {}).filter(key => ['windowMs', 'now', 'save', 'snapshot', 'maxEntries'].includes(key)))
  if (!raw || Object.keys(options).length !== Object.keys(raw).length || !safePositive(raw.windowMs) || typeof raw.now !== 'function' || typeof raw.save !== 'function'
    || (raw.maxEntries !== undefined && (!safePositive(raw.maxEntries) || raw.maxEntries > REPLAY_MAX_ENTRIES))) return null
  const windowMs = raw.windowMs
  const readClock = raw.now as () => number
  const write = raw.save as (snapshot: ReplaySnapshot) => void
  const maximum = (raw.maxEntries as number | undefined) ?? REPLAY_MAX_ENTRIES
  const entries: { messageId: string; epoch: number; nonce: string; at: number }[] = []
  const ids = new Set<string>()
  const nonces = new Set<string>()
  let highWater = 0

  const tick = (): number => {
    const now = readClock()
    if (!safePositive(now)) throw new Error('replay-store: invalid clock')
    if (now > highWater) highWater = now
    return highWater
  }
  const prune = (now: number): void => {
    const keep = entries.filter(entry => now - entry.at < windowMs)
    if (keep.length === entries.length) return
    entries.length = 0
    entries.push(...keep)
    ids.clear()
    nonces.clear()
    for (const entry of entries) { ids.add(entry.messageId); nonces.add(`${entry.epoch}:${entry.nonce}`) }
  }
  const snapshot = (): ReplaySnapshot => Object.freeze({
    version: 1 as const,
    clock: highWater,
    entries: Object.freeze(entries.map(entry => Object.freeze([entry.messageId, entry.epoch, entry.nonce, entry.at] as const))),
  })

  if (raw.snapshot !== undefined) {
    const stored = plain(raw.snapshot, ['clock', 'entries', 'version'])
    if (!stored || stored.version !== 1 || !safeCount(stored.clock) || !Array.isArray(stored.entries) || stored.entries.length > maximum) return null
    for (const item of stored.entries) {
      if (!Array.isArray(item) || item.length !== 4 || typeof item[0] !== 'string' || !messageIdPattern.test(item[0]) || !safeCount(item[1])
        || typeof item[2] !== 'string' || !noncePattern.test(item[2]) || !safePositive(item[3]) || item[3] > (stored.clock as number)) return null
      if (ids.has(item[0]) || nonces.has(`${item[1]}:${item[2]}`)) return null
      entries.push({ messageId: item[0], epoch: item[1], nonce: item[2], at: item[3] })
      ids.add(item[0])
      nonces.add(`${item[1]}:${item[2]}`)
    }
    highWater = stored.clock as number
  }
  try { prune(tick()) } catch { return null }

  return Object.freeze({
    claim(messageId: string, epoch: number, nonce: string): boolean {
      if (typeof messageId !== 'string' || !messageIdPattern.test(messageId) || !safeCount(epoch) || typeof nonce !== 'string' || !noncePattern.test(nonce)) {
        throw new Error('replay-store: invalid identifiers')
      }
      const now = tick()
      prune(now)
      const nonceKey = `${epoch}:${nonce}`
      if (ids.has(messageId) || nonces.has(nonceKey)) return false
      if (entries.length >= maximum) throw new Error('replay-store: full')
      entries.push({ messageId, epoch, nonce, at: now })
      ids.add(messageId)
      nonces.add(nonceKey)
      try { write(snapshot()) } catch (error) {
        entries.pop()
        ids.delete(messageId)
        nonces.delete(nonceKey)
        throw error
      }
      return true
    },
    snapshot,
    size: () => entries.length,
    windowMs,
  })
}
