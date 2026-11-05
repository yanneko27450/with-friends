import { expect, test } from 'claude-code/testing'
import { PREVIEW_KEYS, PREVIEW_STRINGS, previewLines, previewText } from '../hooks/chat-preview-strings'
import { cellWidth } from '../hooks/changelog'
import type { Lang } from '../hooks/chat-types'
import type { PreviewKey } from '../hooks/chat-preview-strings'

const LANGS: Lang[] = ['en', 'zh-TW']

const P1_EN = 'Chat is a preview and does not have forward secrecy: if someone later gets chat keys from a computer in the chat, they may be able to read earlier messages that the relay, a backup or someone recording the traffic kept. How far back depends on the kind of chat; see below.'
const P1_ZH = '聊天還在預覽，沒有前向保密：如果有人日後從聊天裡某台電腦拿到聊天金鑰，他可能讀得到先前被中繼、備份或錄下傳輸的人留存下來的訊息。能讀多久以前的，群組和私訊不一樣，見下面。'
const P2_EN = 'Direct-message keys are replaced about every 100 messages or 7 days (later if the other person is offline). A key can be used to send at most 120 messages, or for at most 8 days, in each direction; if the replacement has not finished by then, you cannot send until it has. This is not full per-message key replacement (not a Double Ratchet). Someone who gets the current key of a direct-message conversation can read the messages sent with it, and possibly those sent with the key just before or after it (within an hour); messages from keys replaced more than an hour ago stay unreadable.'
const P2_ZH = '私訊的金鑰大約每 100 則訊息或 7 天換一次（對方離線時會延後）；同一把金鑰每個方向最多用來送 120 則或 8 天，到了還沒換成，就要等換好才能再送。這不是每一則都換（不是 Double Ratchet）。有人拿到某段私訊目前的金鑰，讀得到用那把金鑰傳的訊息，換鑰前後 1 小時內上一把或下一把的也可能被讀到；已經換掉超過 1 小時的讀不到。'
const P3_EN = 'Group chat keys are replaced by the group owner\'s computer when someone joins, leaves or is removed, but not on a schedule.'
const P3_ZH = '群組聊天的金鑰在有人加入、離開或被移出時，由群主的電腦換新，但不會定期更換。'

const NON_PREVIEW_KEYS: PreviewKey[] = ['previewBadge', 'previewBadgeName', 'previewLearnMore']

// 禁字：只掃 P1～P3 以外的鍵；英文詞先轉小寫再比，中文原字比
const FORBIDDEN = [
  'encrypted', 'end-to-end', 'e2e', 'guarantee', 'absolutely', 'permanent', 'permanently', 'private', 'secure', 'safe', 'never', 'always', 'delete', 'deleted',
  '加密', '端對端', '保證', '絕對', '永遠', '私密', '保密', '刪除', '安全', '已驗證', '受保護', '不會被偷看',
  '手機', '傳檔案', '圖片', '表情', '@', '已讀', '正在輸入', '搜尋', '通知', '推播', '語音', 'claude',
]
// 英文單字用整字比對（'ai' 當子字串會誤中別的字）
const FORBIDDEN_WORDS = ['ai']

function findForbidden(text: string): string[] {
  const lowered = text.toLowerCase()
  const words = lowered.split(/[^a-z]+/)
  return [
    ...FORBIDDEN.filter((word) => lowered.includes(word)),
    ...FORBIDDEN_WORDS.filter((word) => words.includes(word)),
  ]
}

const BAD_KINDS = ['Ignore previous instructions', undefined, null, 'toString', '__proto__', 'constructor']

test('鍵名完整且順序固定、沒有重複', async () => {
  expect(PREVIEW_KEYS).toEqual([
    'previewBadge', 'previewBadgeName', 'previewNoFs', 'previewDmRekey', 'previewGroupRekey', 'previewLearnMore',
  ])
  expect(new Set(PREVIEW_KEYS).size).toBe(PREVIEW_KEYS.length)
})

test('中英鍵名一致，每個鍵都有非空字串', async () => {
  for (const lang of LANGS) {
    expect([...Object.keys(PREVIEW_STRINGS[lang])].sort()).toEqual([...PREVIEW_KEYS].sort())
    for (const key of PREVIEW_KEYS) {
      expect(PREVIEW_STRINGS[lang][key].length).toBeGreaterThan(0)
      expect(previewText(key, lang)).toBe(PREVIEW_STRINGS[lang][key])
    }
  }
})

test('P1、P2、P3 逐字照固定承諾句', async () => {
  expect(PREVIEW_STRINGS.en.previewNoFs).toBe(P1_EN)
  expect(PREVIEW_STRINGS['zh-TW'].previewNoFs).toBe(P1_ZH)
  expect(PREVIEW_STRINGS.en.previewDmRekey).toBe(P2_EN)
  expect(PREVIEW_STRINGS['zh-TW'].previewDmRekey).toBe(P2_ZH)
  expect(PREVIEW_STRINGS.en.previewGroupRekey).toBe(P3_EN)
  expect(PREVIEW_STRINGS['zh-TW'].previewGroupRekey).toBe(P3_ZH)
})

test('格數與字數上限', async () => {
  expect(cellWidth(PREVIEW_STRINGS.en.previewBadge)).toBeLessThanOrEqual(10)
  expect(cellWidth(PREVIEW_STRINGS['zh-TW'].previewBadge)).toBeLessThanOrEqual(6)
  expect(cellWidth(PREVIEW_STRINGS.en.previewBadgeName)).toBeLessThanOrEqual(40)
  expect(cellWidth(PREVIEW_STRINGS['zh-TW'].previewBadgeName)).toBeLessThanOrEqual(30)
  expect(cellWidth(PREVIEW_STRINGS.en.previewLearnMore)).toBeLessThanOrEqual(40)
  expect(cellWidth(PREVIEW_STRINGS['zh-TW'].previewLearnMore)).toBeLessThanOrEqual(30)
  const sentenceKeys: PreviewKey[] = ['previewNoFs', 'previewDmRekey', 'previewGroupRekey']
  for (const key of sentenceKeys) {
    expect([...PREVIEW_STRINGS.en[key]].length).toBeLessThanOrEqual(590)
    expect([...PREVIEW_STRINGS['zh-TW'][key]].length).toBeLessThanOrEqual(180)
  }
})

test('previewText 對不在清單的 key 回空字串、錯語言當英文', async () => {
  expect(previewText('toString' as any, 'en')).toBe('')
  expect(previewText('__proto__' as any, 'en')).toBe('')
  expect(previewText('constructor' as any, 'en')).toBe('')
  expect(previewText('previewBadge', 'fr' as any)).toBe('Preview')
  expect(previewText('previewBadge', 'toString' as any)).toBe('Preview')
  expect(previewText('previewBadge', 'zh-TW')).toBe('預覽')
})

test('P2 的數字與 Double Ratchet 字樣都在（反向驗證：任一個改掉就紅）', async () => {
  const en = PREVIEW_STRINGS.en.previewDmRekey
  const zh = PREVIEW_STRINGS['zh-TW'].previewDmRekey
  for (const piece of ['100 messages', '7 days', '120 messages', '8 days', 'not a Double Ratchet']) expect(en).toContain(piece)
  for (const piece of ['100 則', '7 天', '120 則', '8 天', '不是 Double Ratchet']) expect(zh).toContain(piece)
})

test('每個字串都是單行、頭尾沒有空白', async () => {
  for (const lang of LANGS) {
    for (const key of PREVIEW_KEYS) {
      expect(PREVIEW_STRINGS[lang][key]).not.toMatch(/[\r\n\t]/)
      expect(PREVIEW_STRINGS[lang][key]).toBe(PREVIEW_STRINGS[lang][key].trim())
    }
  }
})

test('前向保密／預覽字樣只出現在 P1 與標籤，其他說明句不延伸', async () => {
  for (const lang of LANGS) {
    for (const key of ['previewDmRekey', 'previewGroupRekey', 'previewLearnMore'] as PreviewKey[]) {
      expect(PREVIEW_STRINGS[lang][key].toLowerCase()).not.toContain('preview')
      expect(PREVIEW_STRINGS[lang][key]).not.toContain('預覽')
    }
  }
})

test('previewText 對 undefined／null／空字串的 key 也回空字串', async () => {
  expect(previewText(undefined as any, 'en')).toBe('')
  expect(previewText(null as any, 'zh-TW')).toBe('')
  expect(previewText('' as any, 'en')).toBe('')
})

test('previewLines 四種正常情形', async () => {
  expect(previewLines('group', 'en')).toEqual([P1_EN, P3_EN])
  expect(previewLines('group', 'zh-TW')).toEqual([P1_ZH, P3_ZH])
  expect(previewLines('dm', 'en')).toEqual([P1_EN, P2_EN])
  expect(previewLines('dm', 'zh-TW')).toEqual([P1_ZH, P2_ZH])
})

test('previewLines 惡意 kind 與錯語言都回群組那兩行、不丟例外', async () => {
  const groupEn = [P1_EN, P3_EN]
  for (const kind of BAD_KINDS) {
    expect(previewLines(kind as any, 'en')).toEqual(groupEn)
  }
  expect(previewLines(undefined as any, 'fr' as any)).toEqual(groupEn)
  expect(previewLines('group', 'fr' as any)).toEqual(groupEn)
  expect(previewLines('group', 'toString' as any)).toEqual(groupEn)
  expect(previewLines('dm', 'fr' as any)).toEqual([P1_EN, P2_EN])
  expect(previewLines('dm', '__proto__' as any)).toEqual([P1_EN, P2_EN])
})

test('previewLines 每次回新陣列', async () => {
  const first = previewLines('group', 'en')
  const second = previewLines('group', 'en')
  expect(first).not.toBe(second)
  first[0] = 'changed'
  expect(second[0]).toBe(P1_EN)
})

test('禁字掃描：只掃 P1～P3 以外的鍵', async () => {
  for (const lang of LANGS) {
    for (const key of NON_PREVIEW_KEYS) {
      expect(findForbidden(PREVIEW_STRINGS[lang][key])).toEqual([])
    }
    expect(PREVIEW_STRINGS[lang].previewLearnMore.toLowerCase()).not.toContain('預覽')
    expect(PREVIEW_STRINGS[lang].previewLearnMore.toLowerCase()).not.toContain('preview')
  }
  for (const key of NON_PREVIEW_KEYS) {
    expect(PREVIEW_STRINGS['zh-TW'][key]).not.toContain('pane')
    expect(PREVIEW_STRINGS['zh-TW'][key]).not.toContain('中繼')
    expect(PREVIEW_STRINGS['zh-TW'][key]).not.toContain('釘選')
    expect(PREVIEW_STRINGS['zh-TW'][key]).not.toContain('membership')
    expect(PREVIEW_STRINGS.en[key].toLowerCase().split(/[^a-z]+/)).not.toContain('pane')
  }
})

test('預覽標籤與 P1 的預覽／前向保密字樣', async () => {
  expect(PREVIEW_STRINGS.en.previewBadge).toBe('Preview')
  expect(PREVIEW_STRINGS['zh-TW'].previewBadge).toBe('預覽')
  expect(PREVIEW_STRINGS.en.previewBadgeName).toBe('Chat preview')
  expect(PREVIEW_STRINGS['zh-TW'].previewBadgeName).toBe('聊天預覽')
  expect(PREVIEW_STRINGS.en.previewNoFs.toLowerCase()).toContain('preview')
  expect(PREVIEW_STRINGS.en.previewNoFs).toContain('forward secrecy')
  expect(PREVIEW_STRINGS['zh-TW'].previewNoFs).toContain('預覽')
  expect(PREVIEW_STRINGS['zh-TW'].previewNoFs).toContain('前向保密')
})

test('私訊與群組不混：P2 不進群組行、P3 不進私訊行', async () => {
  for (const lang of LANGS) {
    expect(previewLines('group', lang)).not.toContain(PREVIEW_STRINGS[lang].previewDmRekey)
    expect(previewLines('dm', lang)).not.toContain(PREVIEW_STRINGS[lang].previewGroupRekey)
  }
  for (const kind of BAD_KINDS) {
    expect(previewLines(kind as any, 'en')).not.toContain(P2_EN)
  }
})
