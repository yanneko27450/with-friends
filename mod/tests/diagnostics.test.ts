import { expect, test } from 'claude-code/testing'
import {
  buildDiagnostics,
  diagStrings,
  DIAG_OS_VALUES,
  DIAG_RELAY_KIND_VALUES,
  DIAG_STRINGS,
  DIAG_SURFACE_VALUES,
  errorCodeFromStatus,
} from '../hooks/diagnostics'
import type { DiagInput } from '../hooks/diagnostics'
import { cellWidth } from '../hooks/changelog'

const baseInput: DiagInput = {
  version: '0.5.8',
  surface: 'desktop',
  os: 'windows',
  lang: 'zh-TW',
  relayKind: 'official',
  isInGroup: true,
  isPaused: false,
  errorCode: 503,
}

const exampleOutput = [
  'Friends with Claude diagnostics',
  'version: 0.5.8',
  'surface: desktop',
  'os: windows',
  'language: zh-TW',
  'server: official',
  'in-group: yes',
  'sharing: on',
  'last-error: 503',
].join('\n')

const withField = (key: string, value: unknown): DiagInput => {
  const copy: Record<string, unknown> = { ...baseInput }
  copy[key] = value
  return copy as DiagInput
}

const lineAt = (output: string, index: number): string | undefined => output.split('\n')[index]

test('範例輸入的輸出與卡片範例逐字相等', () => {
  expect(buildDiagnostics(baseInput)).toBe(exampleOutput)
})

test('輸出固定 9 行、每行不超過 40 字元、全文不超過 400 字元', () => {
  const output = buildDiagnostics(baseInput)
  const lines = output.split('\n')
  expect(lines).toHaveLength(9)
  expect(output.length).toBeLessThanOrEqual(400)
  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(40)
  }
})

test('白名單常數與卡片規格逐字相等', () => {
  expect(DIAG_OS_VALUES).toEqual(['windows', 'mac', 'linux', 'unknown'])
  expect(DIAG_SURFACE_VALUES).toEqual(['desktop', 'terminal', 'mobile', 'vscode', 'unknown'])
  expect(DIAG_RELAY_KIND_VALUES).toEqual(['official', 'self-hosted', 'none', 'unknown'])
})

const versionCases: Array<[unknown, string]> = [
  ['0.5.8', 'version: 0.5.8'],
  ['1.22.333', 'version: 1.22.333'],
  ['0.5', 'version: unknown'],
  ['0.5.8.1', 'version: unknown'],
  ['v0.5.8', 'version: unknown'],
  ['0.5.8 ', 'version: unknown'],
  [123, 'version: unknown'],
  [null, 'version: unknown'],
]

for (const [value, expected] of versionCases) {
  test('version 欄位驗證：' + String(value), () => {
    expect(lineAt(buildDiagnostics(withField('version', value)), 1)).toBe(expected)
  })
}

const whitelistCases: Array<[string, unknown, number, string]> = [
  ['surface', 'desktop', 2, 'surface: desktop'],
  ['surface', 'terminal', 2, 'surface: terminal'],
  ['surface', 'mobile', 2, 'surface: mobile'],
  ['surface', 'vscode', 2, 'surface: vscode'],
  ['surface', 'Desktop', 2, 'surface: unknown'],
  ['surface', '', 2, 'surface: unknown'],
  ['os', 'windows', 3, 'os: windows'],
  ['os', 'mac', 3, 'os: mac'],
  ['os', 'linux', 3, 'os: linux'],
  ['os', 'win', 3, 'os: unknown'],
  ['relayKind', 'official', 5, 'server: official'],
  ['relayKind', 'self-hosted', 5, 'server: self-hosted'],
  ['relayKind', 'none', 5, 'server: none'],
  ['relayKind', 'custom', 5, 'server: unknown'],
  ['lang', 'en', 4, 'language: en'],
  ['lang', 'zh-TW', 4, 'language: zh-TW'],
  ['lang', 'fr', 4, 'language: unknown'],
  ['lang', 'zh', 4, 'language: unknown'],
]

for (const [key, value, lineIndex, expected] of whitelistCases) {
  test(key + ' 欄位白名單驗證：' + String(value), () => {
    expect(lineAt(buildDiagnostics(withField(key, value)), lineIndex)).toBe(expected)
  })
}

const boolCases: Array<[string, unknown, number, string]> = [
  ['isInGroup', true, 6, 'in-group: yes'],
  ['isInGroup', false, 6, 'in-group: no'],
  ['isInGroup', 'yes', 6, 'in-group: unknown'],
  ['isInGroup', 1, 6, 'in-group: unknown'],
  ['isInGroup', null, 6, 'in-group: unknown'],
  ['isPaused', true, 7, 'sharing: paused'],
  ['isPaused', false, 7, 'sharing: on'],
  ['isPaused', 'false', 7, 'sharing: unknown'],
  ['isPaused', 0, 7, 'sharing: unknown'],
]

for (const [key, value, lineIndex, expected] of boolCases) {
  test(key + ' 欄位驗證：' + String(value), () => {
    expect(lineAt(buildDiagnostics(withField(key, value)), lineIndex)).toBe(expected)
  })
}

const errorCases: Array<[unknown, string, number | null]> = [
  [-10, 'last-error: unknown', null],
  [-9, 'last-error: -9', -9],
  [0, 'last-error: 0', 0],
  [1, 'last-error: unknown', null],
  [99, 'last-error: unknown', null],
  [100, 'last-error: 100', 100],
  [599, 'last-error: 599', 599],
  [600, 'last-error: unknown', null],
  [1.5, 'last-error: unknown', null],
  ['503', 'last-error: unknown', null],
  [NaN, 'last-error: unknown', null],
  [Infinity, 'last-error: unknown', null],
  [null, 'last-error: none', null],
  [undefined, 'last-error: none', null],
]

for (const [value, expectedLine, expectedCode] of errorCases) {
  test('errorCode 邊界：' + String(value), () => {
    expect(lineAt(buildDiagnostics(withField('errorCode', value)), 8)).toBe(expectedLine)
    expect(errorCodeFromStatus(value)).toBe(expectedCode)
  })
}

const badValues: unknown[] = [
  'Alice\nsecret',
  'group-name',
  'https://x.invalid/#abc',
  'C:\\Users\\Alice',
]

const allKeys = ['version', 'surface', 'os', 'lang', 'relayKind', 'isInGroup', 'isPaused', 'errorCode']

for (const key of allKeys) {
  test('惡意字串塞進 ' + key + ' 欄位不會出現在輸出裡', () => {
    for (const bad of badValues) {
      const output = buildDiagnostics(withField(key, bad))
      expect(output).not.toContain('Alice')
      expect(output).not.toContain('secret')
      expect(output).not.toContain('group-name')
      expect(output).not.toContain('x.invalid')
      expect(output).not.toContain('Users')
      expect(output.split('\n')).toHaveLength(9)
      expect(new RegExp('[^ -~\n]').test(output)).toBe(false)
    }
  })
}

test('每個欄位塞 Symbol、陣列、物件都不丟例外、輸出仍是固定 9 行', () => {
  const weirdValues: unknown[] = [Symbol('x'), ['a'], { nested: true }]
  for (const key of allKeys) {
    for (const weird of weirdValues) {
      const output = buildDiagnostics(withField(key, weird))
      expect(output.split('\n')).toHaveLength(9)
      expect(new RegExp('[^ -~\n]').test(output)).toBe(false)
    }
  }
})

test('超長字串塞進 version 不丟例外、輸出 unknown', () => {
  const output = buildDiagnostics(withField('version', 'x'.repeat(100000)))
  expect(lineAt(output, 1)).toBe('version: unknown')
  expect(output.length).toBeLessThanOrEqual(400)
})

const allUnknownOutput = [
  'Friends with Claude diagnostics',
  'version: unknown',
  'surface: unknown',
  'os: unknown',
  'language: unknown',
  'server: unknown',
  'in-group: unknown',
  'sharing: unknown',
  'last-error: none',
].join('\n')

test('輸入是 null、字串、數字、陣列或空物件時不丟例外，缺的欄位當 unknown', () => {
  const inputs: unknown[] = [null, 'text', 42, [], {}]
  for (const input of inputs) {
    expect(buildDiagnostics(input as DiagInput)).toBe(allUnknownOutput)
  }
})

test('帶 __proto__ 欄位的物件不會影響其他欄位的讀取', () => {
  const tricky = JSON.parse('{"__proto__": {"polluted": true}, "version": "0.5.8"}') as DiagInput
  const output = buildDiagnostics(tricky)
  expect(lineAt(output, 1)).toBe('version: 0.5.8')
  expect(output.split('\n')).toHaveLength(9)
})

test('欄位是 getter 時當作缺欄位，不執行它', () => {
  const tricky: Record<string, unknown> = {}
  Object.defineProperty(tricky, 'version', {
    get: () => {
      throw new Error('boom')
    },
  })
  expect(() => buildDiagnostics(tricky as DiagInput)).not.toThrow()
  expect(lineAt(buildDiagnostics(tricky as DiagInput), 1)).toBe('version: unknown')
})

test('不改傳入物件（先 Object.freeze）', () => {
  const frozen = Object.freeze({ ...baseInput })
  expect(() => buildDiagnostics(frozen)).not.toThrow()
  expect(buildDiagnostics(frozen)).toBe(exampleOutput)
  expect(frozen).toEqual(baseInput)
})

test('DIAG_STRINGS 兩種語言每個鍵都在、非空', () => {
  const keys = ['button', 'buttonName', 'hint', 'copied', 'copyFailed', 'contents']
  for (const lang of ['en', 'zh-TW'] as const) {
    for (const key of keys) {
      const value = DIAG_STRINGS[lang][key as keyof (typeof DIAG_STRINGS)['en']]
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    }
  }
})

test('DIAG_STRINGS 格數在上限內', () => {
  expect(cellWidth(DIAG_STRINGS.en.button)).toBeLessThanOrEqual(17)
  expect(cellWidth(DIAG_STRINGS['zh-TW'].button)).toBeLessThanOrEqual(12)
  expect(cellWidth(DIAG_STRINGS.en.copied)).toBeLessThanOrEqual(90)
  expect(cellWidth(DIAG_STRINGS['zh-TW'].copied)).toBeLessThanOrEqual(75)
  expect(cellWidth(DIAG_STRINGS.en.hint)).toBeLessThanOrEqual(75)
  expect(cellWidth(DIAG_STRINGS['zh-TW'].hint)).toBeLessThanOrEqual(75)
})

test('繁中按鈕文字是出問題了', () => {
  expect(DIAG_STRINGS['zh-TW'].button).toBe('出問題了')
})

test('contents 與固定承諾句 D1 逐字相等', () => {
  expect(DIAG_STRINGS.en.contents).toBe('It has only the plugin version, your system, and an error code. It has no conversation, names, or group name.')
  expect(DIAG_STRINGS['zh-TW'].contents).toBe('只有外掛版本、你的系統和錯誤代碼，沒有對話內容、名字或群組名。')
})

test('copied 同時說到已複製和可以貼給朋友', () => {
  expect(DIAG_STRINGS.en.copied).toContain('copied')
  expect(DIAG_STRINGS.en.copied).toContain('friend')
  expect(DIAG_STRINGS['zh-TW'].copied).toContain('複製')
  expect(DIAG_STRINGS['zh-TW'].copied).toContain('朋友')
})

test('hint 說到貼給邀請你的朋友或貼到問題頁', () => {
  expect(DIAG_STRINGS.en.hint).toContain('paste')
  expect(DIAG_STRINGS.en.hint).toContain('friend')
  expect(DIAG_STRINGS.en.hint).toContain('issue page')
  expect(DIAG_STRINGS['zh-TW'].hint).toContain('貼給')
  expect(DIAG_STRINGS['zh-TW'].hint).toContain('朋友')
  expect(DIAG_STRINGS['zh-TW'].hint).toContain('問題頁')
})

test('DIAG_STRINGS 不含禁字', () => {
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
  ]
  const keys = ['button', 'buttonName', 'hint', 'copied', 'copyFailed', 'contents']
  for (const lang of ['en', 'zh-TW'] as const) {
    for (const key of keys) {
      const value = DIAG_STRINGS[lang][key as keyof (typeof DIAG_STRINGS)['en']]
      for (const word of banned) {
        expect(value).not.toContain(word)
      }
    }
  }
})

test('diagStrings 回傳對應語言的字串組', () => {
  expect(diagStrings('en')).toEqual(DIAG_STRINGS.en)
  expect(diagStrings('zh-TW')).toEqual(DIAG_STRINGS['zh-TW'])
  expect(diagStrings('en').button).toBe("Something's wrong")
})
