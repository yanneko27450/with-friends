import { expect, test } from 'claude-code/testing'
import { SAFETY_KEYS, SAFETY_STRINGS, formatSafetyCode, safetyChanged, safetyChangedBanner, safetyText } from '../hooks/safety-strings'
import { cellWidth } from '../hooks/changelog'
import type { Lang } from '../hooks/chat-types'
import type { SafetyKey } from '../hooks/safety-strings'

const LANGS: Lang[] = ['en', 'zh-TW']

const S1_EN = 'Your computer and your friend\'s computer each work out this code. If both show the same code, you are using the same keys.'
const S1_ZH = '這組碼是你的電腦和朋友的電腦各自算出來的。兩邊顯示的一樣，代表你們用的是同一組金鑰。'
const S2_EN = 'A matching code shows the keys were not swapped. It does not show who the other person is, so compare it with them by phone or in person.'
const S2_ZH = '兩邊一樣，代表金鑰沒有被換掉；它不能證明對方是誰，所以請用電話或當面和他核對。'
const S3_EN = 'The code is worked out on your computer.'
const S3_ZH = '核對碼是在你的電腦上算出來的。'
const S4_EN_TAIL = '\'s keys changed. They may have a new computer or a fresh install, or someone else may be pretending to be them. Until you check the new code with them, don\'t send anything sensitive in this chat.'
const S4_ZH_TAIL = ' 的金鑰變了。可能是他換了電腦或重新安裝，也可能有人冒充他。在你和他核對新的碼之前，請不要在這個對話裡傳敏感內容。'
const DIFF_EN = 'The match codes are different — someone may be pretending to be them. Don\'t send anything sensitive here; check again in person or by phone.'
const DIFF_ZH = '核對碼不一樣：可能有人冒充。先別在這裡傳敏感內容，改用當面或電話再確認一次。'
const BANNER_EN_TAIL = '\'s keys changed: check with them before sending sensitive info'
const BANNER_ZH_TAIL = ' 的金鑰變了：和他核對前，先別傳敏感內容'

function fixedSentences(lang: Lang, name: string): string[] {
  if (lang === 'en') return [S1_EN, S2_EN, S3_EN, name + S4_EN_TAIL, DIFF_EN]
  return [S1_ZH, S2_ZH, S3_ZH, name + S4_ZH_TAIL, DIFF_ZH]
}

function stripFixed(text: string, lang: Lang, name: string): string {
  let out = text
  for (const fixed of fixedSentences(lang, name)) out = out.split(fixed).join('')
  return out
}

// 功能名稱已改成「核對碼／Match code」，不含被掃的字，所以「安全」與 safe 直接列入掃描；
// 固定句（S1～S4 與「不一樣」說明）本身用到的詞先拿掉再比；比對一律先轉小寫。
const FORBIDDEN = [
  '加密', '端對端', '安全保證', '保證', '絕對', '永遠', '私密', '保密', '刪除', '安全',
  '已驗證身分', '保證是本人', '不會被偷看',
  '已讀', '對方正在輸入', '表情', '手機', '檔案', '圖片', '提及', '搜尋', '通知', '推播', '語音',
  'e2e', 'encrypt', 'end-to-end', 'secure', 'private', 'safe', 'never', 'always', 'delete',
  'verified', 'identity', 'claude', 'ai', 'phone', 'file', 'image', 'photo', 'mention',
  'read receipt', 'typing', 'search', 'notification', 'push', 'voice', 'emoji', 'reaction',
]

function findForbidden(text: string, lang: Lang, name: string): string[] {
  const lowered = stripFixed(text, lang, name).toLowerCase()
  return FORBIDDEN.filter((word) => lowered.includes(word))
}

test('鍵名完整且順序固定', async () => {
  expect(SAFETY_KEYS).toEqual([
    'safetyTitle', 'safetyExplain', 'safetyLimit', 'safetyLocal', 'safetyCodeLabel',
    'safetyVerifyButton', 'safetyVerifiedTag', 'safetyNotVerifiedTag',
    'safetyChangedVerify', 'safetyChangedLater',
    'safetyDifferentButton', 'safetyDifferentExplain',
  ])
})

test('中英鍵名一致，每個鍵都有非空字串', async () => {
  for (const lang of LANGS) {
    expect([...Object.keys(SAFETY_STRINGS[lang])].sort()).toEqual([...SAFETY_KEYS].sort())
    for (const key of SAFETY_KEYS) {
      expect(SAFETY_STRINGS[lang][key].length).toBeGreaterThan(0)
      expect(safetyText(key, lang)).toBe(SAFETY_STRINGS[lang][key])
    }
  }
})

test('S1～S3 逐字照固定承諾句（S3 只換名稱）', async () => {
  expect(SAFETY_STRINGS.en.safetyExplain).toBe(S1_EN)
  expect(SAFETY_STRINGS['zh-TW'].safetyExplain).toBe(S1_ZH)
  expect(SAFETY_STRINGS.en.safetyLimit).toBe(S2_EN)
  expect(SAFETY_STRINGS['zh-TW'].safetyLimit).toBe(S2_ZH)
  expect(SAFETY_STRINGS.en.safetyLocal).toBe(S3_EN)
  expect(SAFETY_STRINGS['zh-TW'].safetyLocal).toBe(S3_ZH)
})

test('safetyText(safetyLimit) 在兩種語言都含 S2 原句', async () => {
  expect(safetyText('safetyLimit', 'en')).toContain(S2_EN)
  expect(safetyText('safetyLimit', 'zh-TW')).toContain(S2_ZH)
  expect(safetyText('safetyLimit', 'zh-TW')).toContain('不能證明對方是誰')
})

test('名稱已改：標題與標籤用新名，沒有任何字串含舊名', async () => {
  expect(SAFETY_STRINGS.en.safetyTitle).toBe('Match code')
  expect(SAFETY_STRINGS['zh-TW'].safetyTitle).toBe('核對碼')
  for (const lang of LANGS) {
    for (const key of SAFETY_KEYS) {
      expect(SAFETY_STRINGS[lang][key]).not.toContain('安全碼')
      expect(SAFETY_STRINGS[lang][key].toLowerCase()).not.toContain('safety code')
    }
  }
  expect(safetyChanged('Bob', 'zh-TW')).not.toContain('安全碼')
  expect(safetyChangedBanner('Bob', 'zh-TW')).not.toContain('安全碼')
})

test('safetyCodeLabel 中英同義（兩人共有的碼）', async () => {
  expect(SAFETY_STRINGS.en.safetyCodeLabel).toBe('Code for you and this friend')
  expect(SAFETY_STRINGS['zh-TW'].safetyCodeLabel).toBe('你和這位朋友的核對碼')
})

test('S4 逐字照固定承諾句，只有名字換掉（中文只換名稱）', async () => {
  expect(safetyChanged('Bob', 'en')).toBe('Bob' + S4_EN_TAIL)
  expect(safetyChanged('小明', 'zh-TW')).toBe('小明' + S4_ZH_TAIL)
})

test('safetyChanged 的名字先截到 12 格', async () => {
  const en = safetyChanged('ABCDEFGHIJKLMNOPQRST', 'en')
  expect(en).toContain('ABCDEFGHIJK…')
  expect(en).not.toContain('ABCDEFGHIJKLMNOPQRST')
  const zh = safetyChanged('一二三四五六七八九十', 'zh-TW')
  expect(zh).toContain('一二三四五…')
  expect(zh).not.toContain('一二三四五六七八九十')
})

test('safetyChanged 空名字用 ?', async () => {
  expect(safetyChanged('', 'en')).toBe('?' + S4_EN_TAIL)
  expect(safetyChanged('   ', 'zh-TW')).toBe('?' + S4_ZH_TAIL)
})

test('safetyChanged 含括號的名字不被當模板', async () => {
  expect(safetyChanged('{name}', 'en')).toBe('{name}' + S4_EN_TAIL)
  expect(safetyChanged('{name}', 'zh-TW')).toBe('{name}' + S4_ZH_TAIL)
})

test('safetyChangedBanner 補強後逐字：一行、含名字、格數不超過 75', async () => {
  expect(safetyChangedBanner('Bob', 'en')).toBe('Bob' + BANNER_EN_TAIL)
  expect(safetyChangedBanner('小明', 'zh-TW')).toBe('小明' + BANNER_ZH_TAIL)
  for (const lang of LANGS) {
    const banner = safetyChangedBanner('一二三四五六七八九十一二三四五六七八九十', lang)
    expect(banner).not.toContain('\n')
    expect(cellWidth(banner)).toBeLessThanOrEqual(75)
  }
  expect(safetyChangedBanner('A\nB', 'en')).not.toContain('\n')
  expect(safetyChangedBanner('', 'zh-TW')).toContain('?')
})

test('核對結果按鈕逐字照追加決定 2', async () => {
  expect(SAFETY_STRINGS.en.safetyVerifyButton).toBe('Match')
  expect(SAFETY_STRINGS['zh-TW'].safetyVerifyButton).toBe('一樣')
  expect(SAFETY_STRINGS.en.safetyDifferentButton).toBe('Different')
  expect(SAFETY_STRINGS['zh-TW'].safetyDifferentButton).toBe('不一樣')
  expect(SAFETY_STRINGS.en.safetyVerifiedTag).toBe('Checked')
  expect(SAFETY_STRINGS['zh-TW'].safetyVerifiedTag).toBe('已核對')
})

test('核對結果按鈕格數在一般按鈕上限內（追加決定 2 縮短後）', async () => {
  expect(cellWidth(SAFETY_STRINGS.en.safetyVerifyButton)).toBeLessThanOrEqual(16)
  expect(cellWidth(SAFETY_STRINGS['zh-TW'].safetyVerifyButton)).toBeLessThanOrEqual(10)
  expect(cellWidth(SAFETY_STRINGS.en.safetyDifferentButton)).toBeLessThanOrEqual(16)
  expect(cellWidth(SAFETY_STRINGS['zh-TW'].safetyDifferentButton)).toBeLessThanOrEqual(10)
})

test('「不一樣」說明逐字照追加決定 2，且在說明句字數上限內', async () => {
  expect(SAFETY_STRINGS.en.safetyDifferentExplain).toBe(DIFF_EN)
  expect(SAFETY_STRINGS['zh-TW'].safetyDifferentExplain).toBe(DIFF_ZH)
  expect([...DIFF_EN].length).toBeLessThanOrEqual(220)
  expect([...DIFF_ZH].length).toBeLessThanOrEqual(110)
})

test('「稍後核對」按鈕逐字', async () => {
  expect(SAFETY_STRINGS.en.safetyChangedLater).toBe('Check later')
  expect(SAFETY_STRINGS['zh-TW'].safetyChangedLater).toBe('稍後核對')
})

test('一行字串格數上限，說明句字數上限', async () => {
  const sentenceKeys: SafetyKey[] = ['safetyExplain', 'safetyLimit', 'safetyLocal', 'safetyDifferentExplain']
  for (const lang of LANGS) {
    for (const key of SAFETY_KEYS) {
      const text = SAFETY_STRINGS[lang][key]
      if (sentenceKeys.includes(key)) {
        if (lang === 'en') expect([...text].length).toBeLessThanOrEqual(220)
        else expect([...text].length).toBeLessThanOrEqual(110)
      } else {
        expect(cellWidth(text)).toBeLessThanOrEqual(75)
      }
    }
  }
})

test('按鈕字格數上限（非固定句的按鈕）', async () => {
  const buttonKeys: SafetyKey[] = ['safetyChangedVerify', 'safetyChangedLater']
  for (const key of buttonKeys) {
    expect(cellWidth(SAFETY_STRINGS.en[key])).toBeLessThanOrEqual(16)
    expect(cellWidth(SAFETY_STRINGS['zh-TW'][key])).toBeLessThanOrEqual(10)
  }
})

test('S4 帶最長名字時仍在說明句字數上限內', async () => {
  expect([...safetyChanged('ABCDEFGHIJKL', 'en')].length).toBeLessThanOrEqual(220)
  expect([...safetyChanged('一二三四五六', 'zh-TW')].length).toBeLessThanOrEqual(110)
})

test('禁字掃描（小寫比對；先拿掉固定句再比；含帶名字的結果）', async () => {
  for (const lang of LANGS) {
    for (const key of SAFETY_KEYS) {
      expect(findForbidden(SAFETY_STRINGS[lang][key], lang, 'Bob')).toEqual([])
    }
    expect(findForbidden(safetyChanged('Bob', lang), lang, 'Bob')).toEqual([])
    expect(findForbidden(safetyChangedBanner('Bob', lang), lang, 'Bob')).toEqual([])
    expect(findForbidden(formatSafetyCode('0123456789abcdef').join(' '), lang, 'Bob')).toEqual([])
  }
})

test('禁字掃描器自測：大寫開頭與新增禁字都抓得到', async () => {
  expect(findForbidden('Never share this', 'en', 'Bob')).toContain('never')
  expect(findForbidden('This is Secure and Private', 'en', 'Bob')).toContain('secure')
  expect(findForbidden('ENCRYPTED end-to-end', 'en', 'Bob')).toContain('encrypt')
  expect(findForbidden('Verified identity', 'en', 'Bob')).toContain('verified')
  expect(findForbidden('請注意安全', 'zh-TW', 'Bob')).toContain('安全')
  expect(findForbidden('用手機發話', 'zh-TW', 'Bob')).toContain('手機')
  expect(findForbidden('AI 摘要', 'zh-TW', 'Bob')).toContain('ai')
})

test('formatSafetyCode 卡片例子', async () => {
  expect(formatSafetyCode('0123456789abcdef0123456789abcdef')).toEqual(['0123 4567 89AB CDEF', '0123 4567 89AB CDEF'])
  expect(formatSafetyCode('0123 4567 89ab cdef 01')).toEqual(['0123 4567 89AB CDEF', '01'])
  expect(formatSafetyCode('xyz')).toEqual([])
  expect(formatSafetyCode('0123456789abcde')).toEqual([])
})

test('formatSafetyCode 大小寫、夾空白、長度邊界', async () => {
  expect(formatSafetyCode('aBcDeF0123456789')).toEqual(['ABCD EF01 2345 6789'])
  expect(formatSafetyCode('0123 4567\n89ab cdef')).toEqual(['0123 4567 89AB CDEF'])
  expect(formatSafetyCode('0123456789abcdef0')).toEqual(['0123 4567 89AB CDEF', '0'])
  const rows = formatSafetyCode('ab'.repeat(32))
  expect(rows).toHaveLength(4)
  for (const row of rows) expect(cellWidth(row)).toBeLessThanOrEqual(19)
  expect(formatSafetyCode('ab'.repeat(32) + 'c')).toEqual([])
  expect(formatSafetyCode('')).toEqual([])
})

test('formatSafetyCode 非十六進位字元（長度合格）回空陣列', async () => {
  expect(formatSafetyCode('0123456789abcdeg')).toEqual([])
  expect(formatSafetyCode('zzzzzzzzzzzzzzzzzzzz')).toEqual([])
  expect(formatSafetyCode('0123 4567 89ab cdefg')).toEqual([])
})

test('formatSafetyCode 非字串與超長輸入回空陣列', async () => {
  expect(formatSafetyCode(123 as unknown as string)).toEqual([])
  expect(formatSafetyCode(NaN as unknown as string)).toEqual([])
  expect(formatSafetyCode(null as unknown as string)).toEqual([])
  expect(formatSafetyCode(undefined as unknown as string)).toEqual([])
  expect(formatSafetyCode({} as unknown as string)).toEqual([])
  expect(formatSafetyCode('a'.repeat(100000))).toEqual([])
})

