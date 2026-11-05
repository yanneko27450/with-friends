import { expect, test } from 'claude-code/testing'
import { CHAT_STATE_KINDS, CHAT_STATE_TEXT, chatStateText, chatStateTone } from '../hooks/chat-states'
import { cellWidth } from '../hooks/changelog'
import type { Lang } from '../hooks/chat-types'

const langs: Lang[] = ['en', 'zh-TW']

const EXPECTED_TONES = {
  loading: 'dim',
  empty: 'dim',
  aloneInGroup: 'dim',
  unavailable: 'warning',
  unreachable: 'warning',
  sendFailed: 'error',
  tooLong: 'error',
  notInGroup: 'dim',
} as const

test('CHAT_STATE_KINDS 是卡片固定的八種狀況，順序一致', () => {
  expect([...CHAT_STATE_KINDS]).toEqual(['loading', 'empty', 'aloneInGroup', 'unavailable', 'unreachable', 'sendFailed', 'tooLong', 'notInGroup'])
  for (const lang of langs) {
    expect(Object.keys(CHAT_STATE_TEXT[lang]).sort()).toEqual([...CHAT_STATE_KINDS].sort())
  }
})

test('每種狀況中英都有非空文案，且在 75 格內', () => {
  for (const lang of langs) {
    for (const kind of CHAT_STATE_KINDS) {
      const text = chatStateText(kind, lang, 50)
      expect(typeof text).toBe('string')
      expect(text.length).toBeGreaterThan(0)
      expect(cellWidth(text)).toBeLessThanOrEqual(75)
    }
  }
})

test('chatStateTone 對每種狀況回傳卡片指定的語氣', () => {
  for (const kind of CHAT_STATE_KINDS) {
    expect(chatStateTone(kind)).toBe(EXPECTED_TONES[kind])
  }
})

test('tooLong 的 over 參數：0、負數、NaN、未給都當 1，小數無條件捨去', () => {
  expect(chatStateText('tooLong', 'en', 0)).toContain('about 1 byte over')
  expect(chatStateText('tooLong', 'en', -3)).toContain('about 1 byte over')
  expect(chatStateText('tooLong', 'en', NaN)).toContain('about 1 byte over')
  expect(chatStateText('tooLong', 'en')).toContain('about 1 byte over')
  expect(chatStateText('tooLong', 'en', 1)).toContain('about 1 byte over')
  expect(chatStateText('tooLong', 'en', 50)).toContain('about 50 bytes over')
  expect(chatStateText('tooLong', 'en', 50.9)).toContain('about 50 bytes over')
  expect(chatStateText('tooLong', 'zh-TW', 50)).toContain('超出約 50 個位元組')
  expect(chatStateText('tooLong', 'zh-TW', 0)).toContain('超出約 1 個位元組')
})

test('其他狀況忽略 over 參數', () => {
  for (const lang of langs) {
    expect(chatStateText('empty', lang, 50)).toBe(chatStateText('empty', lang))
    expect(chatStateText('sendFailed', lang, 999)).toBe(chatStateText('sendFailed', lang))
  }
})

test('所有文案都不含禁字', () => {
  const banned = [
    '加密',
    '端對端',
    '安全',
    '保證',
    '絕對',
    '永遠',
    '私密',
    '保密',
    'encrypt',
    'secure',
    'private',
    'safe',
    'never',
    'always',
    'delete',
    '已讀回條',
    '對方已讀',
    '正在輸入',
    '搜尋訊息',
    '推播',
    '語音',
    'read receipt',
  ]
  for (const lang of langs) {
    for (const kind of CHAT_STATE_KINDS) {
      const lower = chatStateText(kind, lang, 50).toLowerCase()
      for (const word of banned) {
        expect(lower).not.toContain(word.toLowerCase())
      }
    }
  }
})
