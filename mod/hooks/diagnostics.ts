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
  copiedNextMember: string
  copiedNextOther: string
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
    copied: 'Diagnostics copied (version, system, settings and error codes; no conversation or names).',
    /** 複製成功後的下一句：已加入的成員（有邀請人） */
    copiedNextMember: 'Paste it to the friend who invited you, or on the issue page.',
    /** 複製成功後的下一句：群主與沒加入的人（沒有邀請人可貼） */
    copiedNextOther: 'Paste it on the issue page, or give it to Claude to look at.',
    /** 複製失敗時顯示的提示，只說再按一次、不說原因 */
    copyFailed: 'Not copied. Please press the button again.',
    /** 診斷文字裡有什麼（固定承諾句 D1） */
    contents: 'It has only the plugin version, your system, a few settings, and error codes. It has no conversation, names, or group name.',
  },
  'zh-TW': {
    /** 「出問題了」按鈕的文字 */
    button: '出問題了',
    /** 螢幕閱讀器唸的完整名稱 */
    buttonName: '出問題了：複製診斷資訊',
    /** 按鈕旁的小字：會複製一小段資訊、可以貼去哪裡 */
    hint: '會複製一小段診斷資訊，你可以貼給邀請你的朋友，或貼到問題頁。',
    /** 複製成功時顯示的提示 */
    copied: '診斷資訊已複製（版本、系統、設定狀態和錯誤代碼，沒有對話和名字）。',
    /** 複製成功後的下一句：已加入的成員（有邀請人） */
    copiedNextMember: '貼給邀請你的朋友，或貼到問題頁。',
    /** 複製成功後的下一句：群主與沒加入的人（沒有邀請人可貼） */
    copiedNextOther: '貼到問題頁，或貼給 Claude 幫你看。',
    /** 複製失敗時顯示的提示，只說再按一次、不說原因 */
    copyFailed: '沒複製成功，請再按一次。',
    /** 診斷文字裡有什麼（固定承諾句 D1） */
    contents: '只有外掛版本、你的系統、幾項設定狀態和錯誤代碼，沒有對話內容、名字或群組名。',
  },
}

export function diagStrings(lang: Lang): (typeof DIAG_STRINGS)['en'] {
  return DIAG_STRINGS[lang]
}

export type DiagWho = 'member' | 'other'

/** 誰按的按鈕：已加入群組而且不是群主＝'member'（有邀請人）；群主、沒加入、值讀不到或型別不對，一律 'other'（沒加入也歸 other：沒有邀請人可貼）。參數是 unknown，什麼值都不能丟例外 */
export function diagWho(isInGroup: unknown, isOwner: unknown): DiagWho {
  return isInGroup === true && isOwner === false ? 'member' : 'other'
}

/** 複製成功時整段提示：copied ＋（英文一個空白／繁中不加）＋ 依身分的下一句；who 不是 'member' 一律當 'other'；lang 只認 'zh-TW'，其他當 'en'（不用索引取值，免得原型屬性漏進來） */
export function diagCopied(lang: Lang, who: DiagWho): string {
  const zh = lang === 'zh-TW'
  const strings = zh ? DIAG_STRINGS['zh-TW'] : DIAG_STRINGS.en
  const next = who === 'member' ? strings.copiedNextMember : strings.copiedNextOther
  return zh ? strings.copied + next : strings.copied + ' ' + next
}

/** 複製按鈕按完之後要顯示的整段提示：isCopied 嚴格等於 true 才是成功句，其他任何值都是 copyFailed */
export function diagToast(lang: Lang, who: DiagWho, isCopied: unknown): string {
  if (isCopied === true) return diagCopied(lang, who)
  return (lang === 'zh-TW' ? DIAG_STRINGS['zh-TW'] : DIAG_STRINGS.en).copyFailed
}
