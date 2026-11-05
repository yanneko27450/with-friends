import { expect, test } from 'claude-code/testing'
import { formatMessageLine, formatMessageTime, sortMessages, tailWindow, truncateToCells } from '../hooks/chat-list'
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

const TZ_TAIPEI = 480
const NOW = Date.UTC(2026, 9, 29, 6, 0, 0)

test('sortMessages 依 sentAt 由舊到新排序', () => {
  const out = sortMessages([msg('c', { sentAt: 300 }), msg('a', { sentAt: 100 }), msg('b', { sentAt: 200 })])
  expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c'])
})

test('sortMessages 在 sentAt 相同時依 id 由小到大排序', () => {
  const out = sortMessages([msg('id-b', { sentAt: 100 }), msg('id-a', { sentAt: 100 })])
  expect(out.map((m) => m.id)).toEqual(['id-a', 'id-b'])
})

test('sortMessages 同一個 id 只留第一次出現的那一則', () => {
  const out = sortMessages([
    msg('x', { sentAt: 300, text: 'first' }),
    msg('y', { sentAt: 100, text: 'other' }),
    msg('x', { sentAt: 50, text: 'second' }),
  ])
  expect(out).toHaveLength(2)
  expect(out.map((m) => m.text)).toEqual(['other', 'first'])
})

test('sortMessages 把不是有限數字的 sentAt 視為 0，負數照原值排', () => {
  const out = sortMessages([
    msg('id-d', { sentAt: Infinity }),
    msg('id-b', { sentAt: 0 }),
    msg('id-a', { sentAt: NaN }),
    msg('id-c', { sentAt: -50 }),
  ])
  expect(out.map((m) => m.id)).toEqual(['id-c', 'id-a', 'id-b', 'id-d'])
})

test('sortMessages 不改傳入陣列，回傳新陣列', () => {
  const input = Object.freeze([msg('b', { sentAt: 200 }), msg('a', { sentAt: 100 })])
  const out = sortMessages(input)
  expect(out).not.toBe(input)
  expect(input.map((m) => m.id)).toEqual(['b', 'a'])
  expect(out.map((m) => m.id)).toEqual(['a', 'b'])
})

test('formatMessageTime 同一天顯示 HH:MM（卡片例子）', () => {
  const sentAt = Date.UTC(2026, 9, 29, 5, 55, 0)
  expect(formatMessageTime(sentAt, NOW, 'en', TZ_TAIPEI)).toBe('13:55')
  expect(formatMessageTime(sentAt, NOW, 'zh-TW', TZ_TAIPEI)).toBe('13:55')
})

test('formatMessageTime 昨天顯示 Yesterday 或昨天加時間（卡片例子）', () => {
  const sentAt = Date.UTC(2026, 9, 28, 15, 30, 0)
  expect(formatMessageTime(sentAt, NOW, 'en', TZ_TAIPEI)).toBe('Yesterday 23:30')
  expect(formatMessageTime(sentAt, NOW, 'zh-TW', TZ_TAIPEI)).toBe('昨天 23:30')
})

test('formatMessageTime 在 60 秒內、未來時間、非有限數字都顯示剛剛', () => {
  expect(formatMessageTime(NOW - 59999, NOW, 'en', TZ_TAIPEI)).toBe('Just now')
  expect(formatMessageTime(NOW - 59999, NOW, 'zh-TW', TZ_TAIPEI)).toBe('剛剛')
  expect(formatMessageTime(NOW + 3600000, NOW, 'en', TZ_TAIPEI)).toBe('Just now')
  expect(formatMessageTime(NaN, NOW, 'en', TZ_TAIPEI)).toBe('Just now')
  expect(formatMessageTime(Infinity, NOW, 'zh-TW', TZ_TAIPEI)).toBe('剛剛')
})

test('formatMessageTime 剛好 60 秒就顯示時間，並補零', () => {
  expect(formatMessageTime(NOW - 60000, NOW, 'en', TZ_TAIPEI)).toBe('13:59')
  expect(formatMessageTime(Date.UTC(2026, 9, 29, 1, 3, 0), NOW, 'en', TZ_TAIPEI)).toBe('09:03')
})

test('formatMessageTime 用本地日期判斷昨天，不是看相差 24 小時', () => {
  const afterMidnight = Date.UTC(2026, 9, 28, 16, 30, 0)
  expect(formatMessageTime(Date.UTC(2026, 9, 28, 15, 30, 0), afterMidnight, 'en', TZ_TAIPEI)).toBe('Yesterday 23:30')
  const lateNight = Date.UTC(2026, 9, 29, 15, 30, 0)
  expect(formatMessageTime(Date.UTC(2026, 9, 28, 16, 30, 0), lateNight, 'en', TZ_TAIPEI)).toBe('00:30')
})

test('formatMessageTime 同年更早顯示 MM/DD HH:MM，不同年顯示 YYYY/MM/DD', () => {
  expect(formatMessageTime(Date.UTC(2026, 9, 27, 6, 5, 0), NOW, 'en', TZ_TAIPEI)).toBe('10/27 14:05')
  expect(formatMessageTime(Date.UTC(2025, 11, 31, 10, 0, 0), NOW, 'en', TZ_TAIPEI)).toBe('2025/12/31')
})

test('formatMessageTime 跨年邊界：前一天仍算昨天', () => {
  const newYear = Date.UTC(2026, 11, 31, 16, 30, 0)
  const sentAt = Date.UTC(2026, 11, 31, 15, 30, 0)
  expect(formatMessageTime(sentAt, newYear, 'en', TZ_TAIPEI)).toBe('Yesterday 23:30')
  expect(formatMessageTime(sentAt, newYear, 'zh-TW', TZ_TAIPEI)).toBe('昨天 23:30')
})

test('formatMessageTime 套用負的時區位移判斷日期', () => {
  const tz = -300
  const now = Date.UTC(2026, 9, 29, 12, 0, 0)
  expect(formatMessageTime(Date.UTC(2026, 9, 29, 4, 30, 0), now, 'en', tz)).toBe('Yesterday 23:30')
  expect(formatMessageTime(Date.UTC(2026, 9, 29, 11, 30, 0), now, 'en', tz)).toBe('06:30')
})

test('truncateToCells 照卡片例子截斷與整理空白', () => {
  expect(truncateToCells('hello world', 8)).toBe('hello w…')
  expect(truncateToCells('你好嗎朋友', 7)).toBe('你好嗎…')
  expect(truncateToCells('a\n\n b', 10)).toBe('a b')
})

test('truncateToCells 的 maxCells 邊界：0、負數、非有限數字回空字串，1 回省略號', () => {
  expect(truncateToCells('hello', 0)).toBe('')
  expect(truncateToCells('hello', -5)).toBe('')
  expect(truncateToCells('hello', NaN)).toBe('')
  expect(truncateToCells('hello', Infinity)).toBe('')
  expect(truncateToCells('hello', 1)).toBe('…')
  expect(truncateToCells('hello', 2)).toBe('h…')
  expect(truncateToCells('hello', 4)).toBe('hel…')
  expect(truncateToCells('hello', 5)).toBe('hello')
  expect(truncateToCells('', 5)).toBe('')
})

test('truncateToCells 把連續空白（tab、換行、全形空白）換成一個半形空格並去頭尾', () => {
  expect(truncateToCells('\t a \n b ', 10)).toBe('a b')
  expect(truncateToCells('a　b', 10)).toBe('a b')
  expect(truncateToCells('   ', 10)).toBe('')
})

test('truncateToCells 不切壞表情符號，全形與半形混排照格數算', () => {
  expect(truncateToCells('👍👍👍', 5)).toBe('👍👍…')
  expect(truncateToCells('a👍b', 3)).toBe('a…')
  expect(truncateToCells('👍', 2)).toBe('👍')
  expect(truncateToCells('ab你好', 5)).toBe('ab你…')
})

test('formatMessageLine 組成一行：時間、名字、內文', () => {
  const m = msg('m1', { sentAt: Date.UTC(2026, 9, 29, 5, 55, 0), text: 'hi there' })
  expect(formatMessageLine(m, NOW, 'en', TZ_TAIPEI, 79)).toBe('13:55 Amy: hi there')
})

test('formatMessageLine 自己的訊息名字用 You 或你', () => {
  const mine = msg('m2', { isMe: true, sentAt: Date.UTC(2026, 9, 29, 5, 55, 0), text: 'hi there' })
  expect(formatMessageLine(mine, NOW, 'en', TZ_TAIPEI, 79)).toBe('13:55 You: hi there')
  expect(formatMessageLine(mine, NOW, 'zh-TW', TZ_TAIPEI, 79)).toBe('13:55 你: hi there')
})

test('formatMessageLine 先把名字截到 12 格，再截整行', () => {
  const longName = msg('m3', { senderName: '一二三四五六七八九十甲乙', sentAt: Date.UTC(2026, 9, 29, 5, 55, 0), text: 'hi' })
  expect(formatMessageLine(longName, NOW, 'en', TZ_TAIPEI, 79)).toBe('13:55 一二三四五…: hi')
  const m = msg('m4', { sentAt: Date.UTC(2026, 9, 29, 5, 55, 0), text: 'hello world' })
  expect(formatMessageLine(m, NOW, 'en', TZ_TAIPEI, 10)).toBe('13:55 Amy…')
})

test('formatMessageLine 把內文換行整理成空格，內文裡的名字冒號不影響格式', () => {
  const m = msg('m5', { sentAt: Date.UTC(2026, 9, 29, 5, 55, 0), text: 'a\nb' })
  expect(formatMessageLine(m, NOW, 'en', TZ_TAIPEI, 79)).toBe('13:55 Amy: a b')
  const fake = msg('m6', { sentAt: Date.UTC(2026, 9, 29, 5, 55, 0), text: 'Amy: fake' })
  expect(formatMessageLine(fake, NOW, 'en', TZ_TAIPEI, 79)).toBe('13:55 Amy: Amy: fake')
})

test('tailWindow 只留最新的 maxRows 則，並算出被省略的舊訊息數', () => {
  const list = [msg('a'), msg('b'), msg('c'), msg('d'), msg('e')]
  const out = tailWindow(list, 2)
  expect(out.shown.map((m) => m.id)).toEqual(['d', 'e'])
  expect(out.hiddenOlder).toBe(3)
})

test('tailWindow 的 maxRows 大於等於總數時全部顯示，小數無條件捨去', () => {
  const list = [msg('a'), msg('b'), msg('c')]
  const all = tailWindow(list, 3)
  expect(all.shown.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  expect(all.hiddenOlder).toBe(0)
  expect(all.shown).not.toBe(list)
  expect(tailWindow(list, 99).hiddenOlder).toBe(0)
  expect(tailWindow(list, 2.9).shown).toHaveLength(2)
  expect(tailWindow(list, 2.9).hiddenOlder).toBe(1)
})

test('tailWindow 的 maxRows 不是有限數字或不大於 0 時不顯示任何一則', () => {
  const list = [msg('a'), msg('b'), msg('c')]
  for (const bad of [0, -1, NaN, Infinity]) {
    const out = tailWindow(list, bad)
    expect(out.shown).toEqual([])
    expect(out.hiddenOlder).toBe(3)
  }
})

test('tailWindow 不改傳入陣列', () => {
  const list = Object.freeze([msg('a'), msg('b'), msg('c')])
  const out = tailWindow(list, 1)
  expect(out.shown.map((m) => m.id)).toEqual(['c'])
  expect(list.map((m) => m.id)).toEqual(['a', 'b', 'c'])
})

test('formatMessageTime 遇到非有限的 nowMs、時區位移或超出日期範圍時回剛剛，不印 NaN（實作部補）', () => {
  expect(formatMessageTime(1e12, NaN, 'en', TZ_TAIPEI)).toBe('Just now')
  expect(formatMessageTime(1e12, NOW, 'en', NaN)).toBe('Just now')
  expect(formatMessageTime(-9e15, NOW, 'zh-TW', TZ_TAIPEI)).toBe('剛剛')
})
