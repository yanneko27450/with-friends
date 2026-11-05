import { expect, test } from 'claude-code/testing'
import { UNREAD_BADGE_MAX, countUnread, formatUnreadBadge, nextReadUpTo } from '../hooks/chat-unread'
import type { ChatViewMessage } from '../hooks/chat-types'

function msg(id: string, over: Partial<ChatViewMessage> = {}): ChatViewMessage {
  return {
    id,
    senderId: 'sender-' + id,
    senderName: 'Amy',
    isMe: false,
    sentAt: 0,
    receivedAt: 0,
    text: 'hello',
    ...over,
  }
}

const a = msg('a', { receivedAt: 100 })
const b = msg('b', { isMe: true, receivedAt: 200 })
const c = msg('c', { receivedAt: 300 })
const cAgain = msg('c', { receivedAt: 300 })

test('UNREAD_BADGE_MAX 是 99', () => {
  expect(UNREAD_BADGE_MAX).toBe(99)
})

test('countUnread 照卡片範例算：自己的不算、重複 id 只算一次', () => {
  expect(countUnread([a, b, c, cAgain], 0)).toBe(2)
  expect(countUnread([a, b, c, cAgain], 100)).toBe(1)
  expect(countUnread([a, b, c, cAgain], 300)).toBe(0)
})

test('countUnread 在 receivedAt 剛好等於 readUpTo 時不算未讀', () => {
  expect(countUnread([a], 100)).toBe(0)
  expect(countUnread([a], 99)).toBe(1)
})

test('countUnread 把不是有限數字的 readUpTo 視為 0，receivedAt 不是有限數字的不算', () => {
  expect(countUnread([a, b, c], NaN)).toBe(2)
  expect(countUnread([a, b, c], Infinity)).toBe(2)
  const weird = [msg('x', { receivedAt: NaN }), msg('y', { receivedAt: Infinity }), msg('z', { receivedAt: -10 })]
  expect(countUnread(weird, 0)).toBe(0)
  expect(countUnread(weird, -20)).toBe(1)
})

test('countUnread 不改傳入陣列，空陣列回 0', () => {
  const frozen = Object.freeze([a, b, c])
  expect(countUnread(frozen, 0)).toBe(2)
  expect(countUnread([], 0)).toBe(0)
})

test('countUnread 處理十萬則訊息也只算一次每一則', () => {
  const many: ChatViewMessage[] = []
  for (let i = 0; i < 100000; i++) many.push(msg('m' + i, { receivedAt: i }))
  expect(countUnread(many, 50000)).toBe(49999)
})

test('nextReadUpTo 照卡片範例：取最大 receivedAt（含自己的），不會變小', () => {
  expect(nextReadUpTo([a, b, c], 50)).toBe(300)
  expect(nextReadUpTo([a, b, c], 999)).toBe(999)
  expect(nextReadUpTo([a, b], 0)).toBe(200)
})

test('nextReadUpTo 在空陣列或全部非有限數字時不下降', () => {
  expect(nextReadUpTo([], 42)).toBe(42)
  expect(nextReadUpTo([], NaN)).toBe(0)
  const weird = [msg('x', { receivedAt: NaN }), msg('y', { receivedAt: Infinity })]
  expect(nextReadUpTo(weird, 42)).toBe(42)
  expect(nextReadUpTo([a], NaN)).toBe(100)
})

test('formatUnreadBadge 的邊界值', () => {
  expect(formatUnreadBadge(0)).toBe('')
  expect(formatUnreadBadge(0.9)).toBe('')
  expect(formatUnreadBadge(1)).toBe('1')
  expect(formatUnreadBadge(7)).toBe('7')
  expect(formatUnreadBadge(99)).toBe('99')
  expect(formatUnreadBadge(99.9)).toBe('99')
  expect(formatUnreadBadge(100)).toBe('99+')
  expect(formatUnreadBadge(100000)).toBe('99+')
  expect(formatUnreadBadge(NaN)).toBe('')
  expect(formatUnreadBadge(-3)).toBe('')
  expect(formatUnreadBadge(Infinity)).toBe('')
})
