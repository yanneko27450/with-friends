import { expect, test } from 'claude-code/testing'
import { BUSY_STRINGS, busyDuration, busyLine } from '../hooks/friend-busy'
import { cellWidth } from '../hooks/changelog'

test('busyDuration 邊界', () => {
  expect(busyDuration(0, 'en')).toBe('under 1 min')
  expect(busyDuration(0, 'zh-TW')).toBe('不到 1 分鐘')
  expect(busyDuration(59, 'en')).toBe('under 1 min')
  expect(busyDuration(59, 'zh-TW')).toBe('不到 1 分鐘')
  expect(busyDuration(60, 'en')).toBe('1 min')
  expect(busyDuration(60, 'zh-TW')).toBe('1 分鐘')
  expect(busyDuration(3179, 'en')).toBe('52 min')
  expect(busyDuration(3180, 'en')).toBe('53 min')
  expect(busyDuration(3180, 'zh-TW')).toBe('53 分鐘')
  expect(busyDuration(3599, 'en')).toBe('59 min')
  expect(busyDuration(3600, 'en')).toBe('1 h')
  expect(busyDuration(3600, 'zh-TW')).toBe('1 小時')
  expect(busyDuration(7199, 'en')).toBe('1 h')
  expect(busyDuration(172799, 'en')).toBe('47 h')
  expect(busyDuration(172800, 'en')).toBe('2 d')
  expect(busyDuration(172800, 'zh-TW')).toBe('2 天')
  expect(busyDuration(59.9, 'en')).toBe('under 1 min')
  expect(busyDuration(8639999, 'en')).toBe('99 d')
  expect(busyDuration(8639999, 'zh-TW')).toBe('99 天')
  expect(busyDuration(8640000, 'en')).toBe('')
  expect(busyDuration(8640000, 'zh-TW')).toBe('')
  expect(busyDuration(1e300, 'en')).toBe('')
  expect(busyDuration(1e300, 'zh-TW')).toBe('')
})

test('busyDuration 壞輸入回空字串', () => {
  const bad: unknown[] = [-1, NaN, Infinity, '60', null, undefined, {}, [], true]
  for (const lang of ['en', 'zh-TW'] as const) {
    for (const value of bad) {
      expect(busyDuration(value, lang)).toBe('')
    }
  }
})

test('busyLine 成立情形逐字相等', () => {
  expect(busyLine('working', true, 3180, 'en')).toBe('Busy · 53 min')
  expect(busyLine('working', true, 3180, 'zh-TW')).toBe('在忙 · 53 分鐘')
  expect(busyLine('working', true, 0, 'en')).toBe('Busy · under 1 min')
  expect(busyLine('working', true, 7200, 'zh-TW')).toBe('在忙 · 2 小時')
})

test('busyLine 不成立情形回 null', () => {
  for (const lang of ['en', 'zh-TW'] as const) {
    for (const presence of ['idle', 'offline', 'Working', 'working ', undefined, 1] as const) {
      expect(busyLine(presence, true, 3180, lang)).toBe(null)
    }
    for (const hasAction of [false, 'true', 1, undefined] as const) {
      expect(busyLine('working', hasAction, 3180, lang)).toBe(null)
    }
    for (const sec of [null, undefined, -5, NaN, '53'] as const) {
      expect(busyLine('working', true, sec, lang)).toBe(null)
    }
  }
})

test('busyLine 與 busyDuration 傳怪值不丟例外、語言不是預期值時當英文', () => {
  const weird: unknown[] = [{}, [], Symbol('x'), () => 0]
  for (const value of weird) {
    expect(() => busyLine(value, value, value, 'en')).not.toThrow()
    expect(() => busyDuration(value, 'en')).not.toThrow()
  }
  for (const lang of ['fr', 'toString', '__proto__'] as const) {
    expect(busyDuration(3180, lang as any)).toBe('53 min')
    expect(busyLine('working', true, 3180, lang as any)).toBe('Busy · 53 min')
  }
})

test('BUSY_STRINGS 鍵名一致、格數在上限內、整句在上限內', () => {
  expect(Object.keys(BUSY_STRINGS.en).sort()).toEqual(Object.keys(BUSY_STRINGS['zh-TW']).sort())
  for (const lang of ['en', 'zh-TW'] as const) {
    const strings = BUSY_STRINGS[lang]
    expect(cellWidth(strings.busy)).toBeLessThanOrEqual(16)
    expect(cellWidth(strings.underMinute)).toBeLessThanOrEqual(16)
    expect(cellWidth(strings.min(59))).toBeLessThanOrEqual(16)
    expect(cellWidth(strings.hour(47))).toBeLessThanOrEqual(16)
    expect(cellWidth(strings.day(99))).toBeLessThanOrEqual(16)
  }
  expect(cellWidth(busyLine('working', true, 3180, 'en') as string)).toBeLessThanOrEqual(28)
  expect(cellWidth(busyLine('working', true, 3180, 'zh-TW') as string)).toBeLessThanOrEqual(28)
  expect(cellWidth(busyLine('working', true, 0, 'en') as string)).toBeLessThanOrEqual(28)
  expect(cellWidth(busyLine('working', true, 0, 'zh-TW') as string)).toBeLessThanOrEqual(28)
})

test('BUSY_STRINGS 與 busyLine 結果不含禁字', () => {
  const banned = [
    '加密',
    '端對端',
    'E2E',
    'encrypted',
    '保證',
    '絕對',
    '永遠',
    '私密',
    '保密',
    'secure',
    'private',
    'safe',
    'never',
    'always',
    'delete',
    '刪除',
    'end-to-end',
    'guarantee',
    'absolutely',
    'permanent',
    'permanently',
    'deleted',
    '安全',
  ]
  const texts: string[] = []
  for (const lang of ['en', 'zh-TW'] as const) {
    const strings = BUSY_STRINGS[lang]
    texts.push(strings.busy, strings.underMinute, strings.min(59), strings.hour(47), strings.day(99))
    const line = busyLine('working', true, 3180, lang)
    if (line !== null) texts.push(line)
  }
  for (const text of texts) {
    for (const word of banned) {
      expect(text).not.toContain(word)
    }
  }
})

test('busyLine 結果不含介面禁字', () => {
  expect(/\bpane\b/.test(busyLine('working', true, 3180, 'en') as string)).toBe(false)
  const zh = busyLine('working', true, 3180, 'zh-TW') as string
  expect(zh).not.toContain('pane')
  expect(zh).not.toContain('中繼')
  expect(zh).not.toContain('釘選')
  expect(zh).not.toContain('membership')
})
