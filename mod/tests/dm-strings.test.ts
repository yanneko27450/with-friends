import { expect, test } from 'claude-code/testing'
import { DM_KEYS, DM_STRINGS, dmEmptyConv, dmText, dmUnread, dmWith } from '../hooks/dm-strings'
import type { DmKey } from '../hooks/dm-strings'
import type { Lang } from '../hooks/chat-types'
import { cellWidth } from '../hooks/changelog'

const LANGS: Lang[] = ['en', 'zh-TW']
const BUTTON_KEYS: DmKey[] = ['dmMuteButton', 'dmUnmuteButton', 'dmBlockButton', 'dmUnblockButton']
const TAG_KEYS: DmKey[] = ['dmMutedTag', 'dmBlockedTag']
const CONFIRM_KEYS: DmKey[] = ['dmMuteConfirm', 'dmBlockConfirm']

const M1_EN = 'Muting hides this person\'s messages on your computer only. They are not told.'
const B1_EN = 'After you block someone, you will not receive their direct messages.'
const M1_ZH = '靜音只在你的電腦上藏起這個人的訊息，不會通知對方。'
const B1_ZH = '封鎖之後，你不會再收到這個人的私訊。'

const FORBIDDEN = [
  '加密', '端對端', 'E2E', 'encrypted', '保證', '絕對', '永遠', '私密', '保密',
  'secure', 'private', 'safe', 'never', 'always', 'delete', '刪除', '保留',
  '已讀', '正在輸入', '系統通知', '推播', '語音', '檔案', '圖片', '表情', '提及', '搜尋',
]

test('每個鍵在兩種語言都有非空字串，鍵數一致', async () => {
  expect(DM_KEYS).toHaveLength(19)
  for (const lang of LANGS) {
    expect(Object.keys(DM_STRINGS[lang])).toHaveLength(DM_KEYS.length)
    for (const key of DM_KEYS) {
      expect(DM_STRINGS[lang][key].length).toBeGreaterThan(0)
    }
  }
})

test('dmText 回傳對應語言的字串', async () => {
  expect(dmText('dmListTitle', 'en')).toBe('Direct messages')
  expect(dmText('dmListTitle', 'zh-TW')).toBe('私訊')
  expect(dmText('dmConfirmYes', 'zh-TW')).toBe('確定')
  expect(dmText('dmConfirmNo', 'en')).toBe('Cancel')
})

test('一行字串不超過 75 格，確認句不超過 160 格', async () => {
  for (const lang of LANGS) {
    for (const key of DM_KEYS) {
      const limit = CONFIRM_KEYS.includes(key) ? 160 : 75
      expect(cellWidth(DM_STRINGS[lang][key])).toBeLessThanOrEqual(limit)
    }
  }
})

test('按鈕字英文不超過 14 格、繁中不超過 8 格；標記在上限內', async () => {
  for (const key of BUTTON_KEYS) {
    expect(cellWidth(DM_STRINGS.en[key])).toBeLessThanOrEqual(14)
    expect(cellWidth(DM_STRINGS['zh-TW'][key])).toBeLessThanOrEqual(8)
  }
  for (const key of TAG_KEYS) {
    expect(cellWidth(DM_STRINGS.en[key])).toBeLessThanOrEqual(8)
    expect(cellWidth(DM_STRINGS['zh-TW'][key])).toBeLessThanOrEqual(6)
  }
})

test('固定承諾句 M1、B1 逐字存在', async () => {
  expect(DM_STRINGS.en.dmMuteConfirm).toContain(M1_EN)
  expect(DM_STRINGS.en.dmBlockConfirm).toContain(B1_EN)
  expect(DM_STRINGS['zh-TW'].dmMuteConfirm).toContain(M1_ZH)
  expect(DM_STRINGS['zh-TW'].dmBlockConfirm).toContain(B1_ZH)
})

test('dmUnread 邊界', async () => {
  expect(dmUnread(0)).toBe('')
  expect(dmUnread(1)).toBe('1')
  expect(dmUnread(2)).toBe('2')
  expect(dmUnread(99)).toBe('99')
  expect(dmUnread(100)).toBe('99+')
  expect(dmUnread(250)).toBe('99+')
  expect(dmUnread(2.9)).toBe('2')
  expect(dmUnread(0.5)).toBe('')
  expect(dmUnread(NaN)).toBe('')
  expect(dmUnread(-3)).toBe('')
  expect(dmUnread(Infinity)).toBe('')
  expect(() => dmUnread(NaN)).not.toThrow()
})

test('dmWith 帶名字，長名字截到 12 格', async () => {
  expect(dmWith('Amy', 'en')).toBe('Chat with Amy')
  expect(dmWith('Ben', 'zh-TW')).toBe('和 Ben 的對話')
  const longZh = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸'
  expect(dmWith(longZh, 'zh-TW')).toBe('和 一二三四五… 的對話')
  expect(dmWith(longZh, 'en')).toBe('Chat with 一二三四五…')
  const fullwidth = 'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴ'
  expect(dmWith(fullwidth, 'en')).toBe('Chat with ＡＢＣＤＥ…')
  const emoji = '😀😀😀😀😀😀😀😀'
  expect(dmWith(emoji, 'en')).toBe('Chat with 😀😀😀😀😀…')
  expect(cellWidth(dmWith(longZh, 'zh-TW'))).toBeLessThanOrEqual(75)
})

test('dmWith 空名字與全空白名字用問號', async () => {
  expect(dmWith('', 'en')).toBe('Chat with ?')
  expect(dmWith('   ', 'zh-TW')).toBe('和 ? 的對話')
})

test('dmEmptyConv 帶名字且在 75 格內，空名字用問號', async () => {
  expect(dmEmptyConv('Amy', 'en')).toBe('Nothing here yet. Start the conversation with Amy.')
  expect(dmEmptyConv('Ben', 'zh-TW')).toBe('和 Ben 還沒有訊息，寫第一句吧。')
  const longZh = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸'
  expect(dmEmptyConv(longZh, 'zh-TW')).toContain('…')
  expect(cellWidth(dmEmptyConv(longZh, 'zh-TW'))).toBeLessThanOrEqual(75)
  expect(cellWidth(dmEmptyConv(longZh, 'en'))).toBeLessThanOrEqual(75)
  expect(dmEmptyConv('', 'en')).toContain('?')
  expect(dmEmptyConv('   ', 'zh-TW')).toContain('?')
})

test('禁字清單：拿掉固定承諾句本身後逐一檢查', async () => {
  for (const lang of LANGS) {
    for (const key of DM_KEYS) {
      let s = DM_STRINGS[lang][key]
      if (key === 'dmMuteConfirm') s = s.replace(lang === 'zh-TW' ? M1_ZH : M1_EN, '')
      if (key === 'dmBlockConfirm') s = s.replace(lang === 'zh-TW' ? B1_ZH : B1_EN, '')
      for (const w of FORBIDDEN) {
        expect(s).not.toContain(w)
      }
    }
  }
})

test('沒有字串含樣板殘留字元', async () => {
  const samples: string[] = []
  for (const lang of LANGS) {
    for (const key of DM_KEYS) samples.push(DM_STRINGS[lang][key])
    samples.push(dmWith('Amy', lang))
    samples.push(dmEmptyConv('Ben', lang))
  }
  samples.push(dmUnread(5))
  samples.push(dmUnread(100))
  for (const s of samples) {
    expect(s).not.toContain('{')
    expect(s).not.toContain('}')
    expect(s).not.toContain('undefined')
    expect(s).not.toContain('[object')
  }
})
