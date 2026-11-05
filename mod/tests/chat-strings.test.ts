import { expect, test } from 'claude-code/testing'
import { CHAT_STRINGS } from '../hooks/chat-strings'
import { cellWidth } from '../hooks/changelog'
import type { Lang } from '../hooks/chat-types'

const langs: Lang[] = ['en', 'zh-TW']

const EXPECTED_KEYS = [
  'counterLeft',
  'inputName',
  'inputPlaceholder',
  'listName',
  'messageName',
  'mobileUnreadLine',
  'olderHidden',
  'ownMessageName',
  'sendButton',
  'sendButtonName',
  'sending',
  'tabChat',
  'tabChatName',
  'tabFriends',
  'tabFriendsName',
  'unreadBadgeName',
  'youLabel',
]

function samples(lang: Lang): string[] {
  const s = CHAT_STRINGS[lang]
  return [
    s.tabChat,
    s.tabFriends,
    s.tabChatName(0),
    s.tabChatName(1),
    s.tabChatName(5),
    s.tabChatName(150),
    s.tabChatName(-3),
    s.tabChatName(NaN),
    s.tabFriendsName,
    s.inputPlaceholder,
    s.inputName,
    s.sendButton,
    s.sendButtonName,
    s.sending,
    s.counterLeft(2000),
    s.counterLeft(0),
    s.counterLeft(-12),
    s.counterLeft(NaN),
    s.listName,
    s.youLabel,
    s.messageName('Amy', '14:05'),
    s.ownMessageName('14:05'),
    s.olderHidden(0),
    s.olderHidden(1),
    s.olderHidden(150),
    s.unreadBadgeName(0),
    s.unreadBadgeName(1),
    s.unreadBadgeName(150),
    s.mobileUnreadLine(0),
    s.mobileUnreadLine(1),
    s.mobileUnreadLine(5),
    s.mobileUnreadLine(150),
    s.mobileUnreadLine(-3),
    s.mobileUnreadLine(NaN),
  ]
}

test('en 與 zh-TW 的鍵名與卡片清單完全相同', () => {
  expect(Object.keys(CHAT_STRINGS.en).sort()).toEqual(EXPECTED_KEYS)
  expect(Object.keys(CHAT_STRINGS['zh-TW']).sort()).toEqual(EXPECTED_KEYS)
})

test('每個字串與函式輸出都在格數上限內', () => {
  for (const lang of langs) {
    const s = CHAT_STRINGS[lang]
    const cases: Array<[string, number]> = [
      [s.tabChat, 8],
      [s.tabFriends, 8],
      [s.tabChatName(150), 50],
      [s.tabChatName(1), 50],
      [s.tabFriendsName, 40],
      [s.inputPlaceholder, 28],
      [s.inputName, 50],
      [s.sendButton, 8],
      [s.sendButtonName, 40],
      [s.sending, 12],
      [s.counterLeft(2000), 14],
      [s.counterLeft(-998000), 14],
      [s.listName, 40],
      [s.youLabel, 8],
      [s.ownMessageName('2025/12/31'), 40],
      [s.olderHidden(150), 36],
      [s.unreadBadgeName(150), 40],
      [s.mobileUnreadLine(150), lang === 'en' ? 70 : 40],
    ]
    for (const [value, limit] of cases) {
      expect(cellWidth(value)).toBeLessThanOrEqual(limit)
    }
    expect(cellWidth(s.messageName('Amy', 'Yesterday 23:30')) - cellWidth('Amy')).toBeLessThanOrEqual(40)
  }
})

test('所有字串與函式輸出都不含禁字', () => {
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
    for (const value of samples(lang)) {
      const lower = value.toLowerCase()
      for (const word of banned) {
        expect(lower).not.toContain(word.toLowerCase())
      }
    }
  }
})

test('函式遇到 NaN 或負數仍回字串，不丟例外', () => {
  for (const lang of langs) {
    for (const value of samples(lang)) {
      expect(typeof value).toBe('string')
    }
  }
})

test('英文的單複數：1 用單數，2 以上用複數，0 的分頁名不帶數字', () => {
  const en = CHAT_STRINGS.en
  expect(en.tabChatName(0)).toBe('Chat')
  expect(en.tabChatName(1)).toContain('1 unread message')
  expect(en.tabChatName(1)).not.toContain('messages')
  expect(en.tabChatName(2)).toContain('2 unread messages')
  expect(en.unreadBadgeName(1)).toBe('1 unread message')
  expect(en.unreadBadgeName(2)).toBe('2 unread messages')
  expect(en.unreadBadgeName(0)).toBe('No unread messages')
  expect(en.olderHidden(1)).toBe('1 older message not shown')
  expect(en.olderHidden(2)).toBe('2 older messages not shown')
})

test('mobileUnreadLine 只有數字不同，意思固定（卡片例子 0、1、5）', () => {
  const en = CHAT_STRINGS.en
  expect(en.mobileUnreadLine(0)).toContain('0 unread chat messages')
  expect(en.mobileUnreadLine(1)).toContain('1 unread chat message.')
  expect(en.mobileUnreadLine(5)).toContain('5 unread chat messages')
  expect(en.mobileUnreadLine(5)).toContain('computer')
  expect(CHAT_STRINGS['zh-TW'].mobileUnreadLine(5)).toBe('聊天有 5 則未讀，請在電腦的面板查看')
  expect(CHAT_STRINGS['zh-TW'].mobileUnreadLine(1)).toBe('聊天有 1 則未讀，請在電腦的面板查看')
})

test('counterLeft 顯示剩餘或超出（數字與極短單位）', () => {
  expect(CHAT_STRINGS.en.counterLeft(1980)).toBe('1980 left')
  expect(CHAT_STRINGS.en.counterLeft(0)).toBe('0 left')
  expect(CHAT_STRINGS.en.counterLeft(-12)).toBe('over by 12')
  expect(CHAT_STRINGS['zh-TW'].counterLeft(1980)).toBe('還剩 1980')
  expect(CHAT_STRINGS['zh-TW'].counterLeft(-12)).toBe('超出 12')
})

test('messageName 只放一次寄件人名字，並帶時間字樣', () => {
  for (const lang of langs) {
    const name = CHAT_STRINGS[lang].messageName('Amy', '14:05')
    expect(name.split('Amy')).toHaveLength(2)
    expect(name).toContain('14:05')
  }
})
