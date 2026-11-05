import { expect, test } from 'claude-code/testing'
import {
  buildDiagnostics,
  diagCopied,
  diagStrings,
  diagToast,
  diagWho,
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
  const keys = ['button', 'buttonName', 'hint', 'copied', 'copiedNextMember', 'copiedNextOther', 'copyFailed', 'contents']
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
  expect(cellWidth(DIAG_STRINGS['zh-TW'].copied)).toBeLessThanOrEqual(70)
  expect(cellWidth(DIAG_STRINGS.en.copiedNextMember)).toBeLessThanOrEqual(70)
  expect(cellWidth(DIAG_STRINGS['zh-TW'].copiedNextMember)).toBeLessThanOrEqual(40)
  expect(cellWidth(DIAG_STRINGS.en.copiedNextOther)).toBeLessThanOrEqual(70)
  expect(cellWidth(DIAG_STRINGS['zh-TW'].copiedNextOther)).toBeLessThanOrEqual(40)
  expect(cellWidth(DIAG_STRINGS.en.hint)).toBeLessThanOrEqual(75)
  expect(cellWidth(DIAG_STRINGS['zh-TW'].hint)).toBeLessThanOrEqual(75)
})

test('繁中按鈕文字是出問題了', () => {
  expect(DIAG_STRINGS['zh-TW'].button).toBe('出問題了')
})

test('contents 與固定承諾句 D1 逐字相等', () => {
  expect(DIAG_STRINGS.en.contents).toBe('It has only the plugin version, your system, a few settings, and error codes. It has no conversation, names, or group name.')
  expect(DIAG_STRINGS['zh-TW'].contents).toBe('只有外掛版本、你的系統、幾項設定狀態和錯誤代碼，沒有對話內容、名字或群組名。')
})

test('copied 說的是診斷資訊已複製，而且不含「邀請」', () => {
  expect(DIAG_STRINGS.en.copied).toContain('Diagnostics copied')
  expect(DIAG_STRINGS.en.copied.toLowerCase()).not.toContain('invit')
  expect(DIAG_STRINGS['zh-TW'].copied).toContain('診斷資訊已複製')
  expect(DIAG_STRINGS['zh-TW'].copied).not.toContain('邀請')
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
    'end-to-end',
    'guarantee',
    'absolutely',
    'permanent',
    'permanently',
    'deleted',
    '安全',
  ]
  const keys = ['button', 'buttonName', 'hint', 'copied', 'copiedNextMember', 'copiedNextOther', 'copyFailed', 'contents']
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

test('D1、D2、D3、D4 與卡片逐字相等', () => {
  expect(DIAG_STRINGS.en.contents).toBe('It has only the plugin version, your system, a few settings, and error codes. It has no conversation, names, or group name.')
  expect(DIAG_STRINGS['zh-TW'].contents).toBe('只有外掛版本、你的系統、幾項設定狀態和錯誤代碼，沒有對話內容、名字或群組名。')
  expect(DIAG_STRINGS.en.copied).toBe('Diagnostics copied (version, system, settings and error codes; no conversation or names).')
  expect(DIAG_STRINGS['zh-TW'].copied).toBe('診斷資訊已複製（版本、系統、設定狀態和錯誤代碼，沒有對話和名字）。')
  expect(DIAG_STRINGS.en.copiedNextMember).toBe('Paste it to the friend who invited you, or on the issue page.')
  expect(DIAG_STRINGS['zh-TW'].copiedNextMember).toBe('貼給邀請你的朋友，或貼到問題頁。')
  expect(DIAG_STRINGS.en.copiedNextOther).toBe('Paste it on the issue page, or give it to Claude to look at.')
  expect(DIAG_STRINGS['zh-TW'].copiedNextOther).toBe('貼到問題頁，或貼給 Claude 幫你看。')
})

test('diagWho 只在已加入且不是群主時回 member', () => {
  expect(diagWho(true, false)).toBe('member')
  expect(diagWho(true, true)).toBe('other')
  expect(diagWho(false, false)).toBe('other')
  expect(diagWho(false, true)).toBe('other')
  expect(diagWho(false, undefined)).toBe('other')
  expect(diagWho(undefined, undefined)).toBe('other')
  expect(diagWho(null, null)).toBe('other')
  expect(diagWho('true', 'false')).toBe('other')
  expect(diagWho(1, 0)).toBe('other')
  expect(diagWho({}, [])).toBe('other')
})

test('diagWho 傳物件、陣列、函式、Symbol 也不丟例外', () => {
  const weird: unknown[] = [{}, [], () => 0, Symbol('x')]
  for (const value of weird) {
    expect(() => diagWho(value, value)).not.toThrow()
    expect(diagWho(value, value)).toBe('other')
  }
})

test('diagCopied 成員用 D3、其他身分用 D4，英文加空白、繁中不加', () => {
  for (const lang of ['en', 'zh-TW'] as const) {
    const strings = DIAG_STRINGS[lang]
    const join = lang === 'zh-TW' ? '' : ' '
    expect(diagCopied(lang, 'member')).toBe(strings.copied + join + strings.copiedNextMember)
    expect(diagCopied(lang, 'other')).toBe(strings.copied + join + strings.copiedNextOther)
  }
})

test('diagCopied 不是 member 的身分一律當 other', () => {
  expect(diagCopied('en', 'x' as any)).toBe(DIAG_STRINGS.en.copied + ' ' + DIAG_STRINGS.en.copiedNextOther)
  expect(diagCopied('zh-TW', undefined as any)).toBe(DIAG_STRINGS['zh-TW'].copied + DIAG_STRINGS['zh-TW'].copiedNextOther)
})

test('diagCopied 不是 en 或 zh-TW 的語言一律當英文', () => {
  for (const lang of ['fr', 'toString', '__proto__', 'constructor'] as const) {
    expect(diagCopied(lang as any, 'member')).toBe(DIAG_STRINGS.en.copied + ' ' + DIAG_STRINGS.en.copiedNextMember)
    expect(diagCopied(lang as any, 'other')).toBe(DIAG_STRINGS.en.copied + ' ' + DIAG_STRINGS.en.copiedNextOther)
  }
})

test('diagToast 複製成功回整段提示、其他值回 copyFailed', () => {
  for (const lang of ['en', 'zh-TW'] as const) {
    for (const who of ['member', 'other'] as const) {
      expect(diagToast(lang, who, true)).toBe(diagCopied(lang, who))
      for (const bad of [false, undefined, 'true', 1] as const) {
        expect(diagToast(lang, who, bad)).toBe(DIAG_STRINGS[lang].copyFailed)
      }
    }
  }
})

test('diagToast 語言不是 en 或 zh-TW 時當英文', () => {
  for (const lang of ['fr', 'toString'] as const) {
    expect(diagToast(lang as any, 'member', true)).toBe(diagCopied('en', 'member'))
    expect(diagToast(lang as any, 'other', false)).toBe(DIAG_STRINGS.en.copyFailed)
  }
})

test('身分差異：成員那句說邀請你的朋友，群主那句不說邀請但說問題頁與 Claude', () => {
  expect(diagCopied('en', 'member')).toContain('invited you')
  expect(diagCopied('zh-TW', 'member')).toContain('邀請你的朋友')
  expect(diagCopied('en', 'other').toLowerCase()).not.toContain('invit')
  expect(diagCopied('zh-TW', 'other')).not.toContain('邀請')
  expect(diagCopied('en', 'other')).toContain('issue page')
  expect(diagCopied('en', 'other')).toContain('Claude')
  expect(diagCopied('zh-TW', 'other')).toContain('問題頁')
  expect(diagCopied('zh-TW', 'other')).toContain('Claude')
})

test('diagCopied 整段格數在上限內、且不含介面禁字', () => {
  for (const lang of ['en', 'zh-TW'] as const) {
    for (const who of ['member', 'other'] as const) {
      const text = diagCopied(lang, who)
      const limit = lang === 'zh-TW' ? 100 : 155
      expect(cellWidth(text)).toBeLessThanOrEqual(limit)
    }
  }
  for (const who of ['member', 'other'] as const) {
    expect(/\bpane\b/.test(diagCopied('en', who))).toBe(false)
    expect(diagCopied('zh-TW', who)).not.toContain('pane')
    expect(diagCopied('zh-TW', who)).not.toContain('中繼')
    expect(diagCopied('zh-TW', who)).not.toContain('釘選')
    expect(diagCopied('zh-TW', who)).not.toContain('membership')
  }
})
