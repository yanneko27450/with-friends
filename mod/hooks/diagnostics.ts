import type { Lang } from './taxonomy'

/** 作業系統的白名單值；os 欄位只會輸出這幾個值，驗證不過就輸出 unknown */
export const DIAG_OS_VALUES = ['windows', 'mac', 'linux', 'unknown'] as const

/** 外掛畫面所在介面的白名單值；surface 欄位只會輸出這幾個值 */
export const DIAG_SURFACE_VALUES = ['desktop', 'terminal', 'mobile', 'vscode', 'unknown'] as const

/** 中繼種類的白名單值；server 欄位只會輸出這幾個值，只記種類 */
export const DIAG_RELAY_KIND_VALUES = ['official', 'self-hosted', 'none', 'unknown'] as const

/** 全部是 unknown：呼叫端不用先驗證，函式自己驗 */
export type DiagInput = {
  /** 外掛版本，例如 '0.5.8' */
  version: unknown
  /** 外掛畫面所在的介面 */
  surface: unknown
  /** 作業系統 */
  os: unknown
  /** 介面語言，只接受 'en' 或 'zh-TW' */
  lang: unknown
  /** 中繼種類，只接受白名單值 */
  relayKind: unknown
  /** 是否已加入群組，只接受 true 或 false */
  isInGroup: unknown
  /** 是否已暫停分享，只接受 true 或 false */
  isPaused: unknown
  /** 最近一次連線錯誤的代碼（整數），沒有錯誤是 null */
  errorCode: unknown
}

const readField = (input: unknown, key: string): unknown => {
  if (typeof input !== 'object' || input === null) return undefined
  if (!Object.prototype.hasOwnProperty.call(input, key)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(input, key)
  if (descriptor === undefined || !('value' in descriptor)) return undefined
  return descriptor.value
}

const VERSION_PATTERN = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/

const versionText = (value: unknown): string => {
  if (typeof value !== 'string') return 'unknown'
  return VERSION_PATTERN.test(value) ? value : 'unknown'
}

const whitelistText = (value: unknown, values: readonly string[]): string => {
  if (typeof value !== 'string') return 'unknown'
  return values.includes(value) ? value : 'unknown'
}

const languageText = (value: unknown): string => {
  if (value === 'en' || value === 'zh-TW') return value
  return 'unknown'
}

const yesNoText = (value: unknown): string => {
  if (value === true) return 'yes'
  if (value === false) return 'no'
  return 'unknown'
}

const sharingText = (value: unknown): string => {
  if (value === true) return 'paused'
  if (value === false) return 'on'
  return 'unknown'
}

export function errorCodeFromStatus(status: unknown): number | null {
  if (typeof status !== 'number') return null
  if (!Number.isInteger(status)) return null
  if (status >= -9 && status <= 0) return status
  if (status >= 100 && status <= 599) return status
  return null
}

const errorText = (value: unknown): string => {
  if (value === null || value === undefined) return 'none'
  const code = errorCodeFromStatus(value)
  if (code === null) return 'unknown'
  return String(code)
}

export function buildDiagnostics(input: DiagInput): string {
  const lines = [
    'Friends with Claude diagnostics',
    'version: ' + versionText(readField(input, 'version')),
    'surface: ' + whitelistText(readField(input, 'surface'), DIAG_SURFACE_VALUES),
    'os: ' + whitelistText(readField(input, 'os'), DIAG_OS_VALUES),
    'language: ' + languageText(readField(input, 'lang')),
    'server: ' + whitelistText(readField(input, 'relayKind'), DIAG_RELAY_KIND_VALUES),
    'in-group: ' + yesNoText(readField(input, 'isInGroup')),
    'sharing: ' + sharingText(readField(input, 'isPaused')),
    'last-error: ' + errorText(readField(input, 'errorCode')),
  ]
  return lines.join('\n')
}

export const DIAG_STRINGS: Record<Lang, {
  button: string
  buttonName: string
  hint: string
  copied: string
  copyFailed: string
  contents: string
}> = {
  en: {
    /** 「出問題了」按鈕的文字 */
    button: "Something's wrong",
    /** 螢幕閱讀器唸的完整名稱 */
    buttonName: 'Something is wrong: copy diagnostic information',
    /** 按鈕旁的小字：會複製一小段資訊、可以貼去哪裡 */
    hint: 'Copies a short text to paste to your inviting friend or the issue page.',
    /** 複製成功時顯示的提示 */
    copied: 'Diagnostics copied. Paste it to the friend who invited you.',
    /** 複製失敗時顯示的提示，只說再按一次、不說原因 */
    copyFailed: 'Not copied. Please press the button again.',
    /** 診斷文字裡有什麼（固定承諾句 D1） */
    contents: 'It has only the plugin version, your system, and an error code. It has no conversation, names, or group name.',
  },
  'zh-TW': {
    /** 「出問題了」按鈕的文字 */
    button: '出問題了',
    /** 螢幕閱讀器唸的完整名稱 */
    buttonName: '出問題了：複製診斷資訊',
    /** 按鈕旁的小字：會複製一小段資訊、可以貼去哪裡 */
    hint: '會複製一小段診斷資訊，你可以貼給邀請你的朋友，或貼到問題頁。',
    /** 複製成功時顯示的提示 */
    copied: '已複製，你可以貼給邀請你的朋友。',
    /** 複製失敗時顯示的提示，只說再按一次、不說原因 */
    copyFailed: '沒複製成功，請再按一次。',
    /** 診斷文字裡有什麼（固定承諾句 D1） */
    contents: '只有外掛版本、你的系統和錯誤代碼，沒有對話內容、名字或群組名。',
  },
}

export function diagStrings(lang: Lang): (typeof DIAG_STRINGS)['en'] {
  return DIAG_STRINGS[lang]
}
