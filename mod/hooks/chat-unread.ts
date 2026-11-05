// mod/hooks/chat-unread.ts
// Chat tab unread count: how many messages are newer than the read marker,
// and how that number is shown. Output is a number or a short digit string.
import type { ChatViewMessage } from './chat-types'

export const UNREAD_BADGE_MAX = 99

export function countUnread(msgs: readonly ChatViewMessage[], readUpTo: number): number {
  const upTo = Number.isFinite(readUpTo) ? readUpTo : 0
  const seen = new Set<string>()
  let count = 0
  for (const msg of msgs) {
    if (seen.has(msg.id)) continue
    seen.add(msg.id)
    if (msg.isMe) continue
    if (!Number.isFinite(msg.receivedAt)) continue
    if (msg.receivedAt > upTo) count++
  }
  return count
}

export function nextReadUpTo(msgs: readonly ChatViewMessage[], current: number): number {
  let result = Number.isFinite(current) ? current : 0
  for (const msg of msgs) {
    if (Number.isFinite(msg.receivedAt) && msg.receivedAt > result) result = msg.receivedAt
  }
  return result
}

export function formatUnreadBadge(n: number): string {
  if (!Number.isFinite(n)) return ''
  const whole = Math.floor(n)
  if (whole < 1) return ''
  if (whole > UNREAD_BADGE_MAX) return '99+'
  return String(whole)
}
