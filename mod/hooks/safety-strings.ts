import type { Lang } from './chat-types'
import { truncateToCells } from './chat-list'

export const SAFETY_KEYS = [
  'safetyTitle', 'safetyExplain', 'safetyLimit', 'safetyLocal', 'safetyCodeLabel',
  'safetyVerifyButton', 'safetyVerifiedTag', 'safetyNotVerifiedTag',
  'safetyChangedVerify', 'safetyChangedLater',
  'safetyDifferentButton', 'safetyDifferentExplain',
] as const
export type SafetyKey = (typeof SAFETY_KEYS)[number]

export const SAFETY_STRINGS: Record<Lang, Record<SafetyKey, string>> = {
  en: {
    safetyTitle: 'Match code',
    safetyExplain: 'Your computer and your friend\'s computer each work out this code. If both show the same code, you are using the same keys.',
    safetyLimit: 'A matching code shows the keys were not swapped. It does not show who the other person is, so compare it with them by phone or in person.',
    safetyLocal: 'The code is worked out on your computer.',
    safetyCodeLabel: 'Code for you and this friend',
    safetyVerifyButton: 'Match',
    safetyVerifiedTag: 'Checked',
    safetyNotVerifiedTag: 'Not checked yet',
    safetyChangedVerify: 'Go check',
    safetyChangedLater: 'Check later',
    safetyDifferentButton: 'Different',
    safetyDifferentExplain: 'The match codes are different — someone may be pretending to be them. Don\'t send anything sensitive here; check again in person or by phone.',
  },
  'zh-TW': {
    safetyTitle: '核對碼',
    safetyExplain: '這組碼是你的電腦和朋友的電腦各自算出來的。兩邊顯示的一樣，代表你們用的是同一組金鑰。',
    safetyLimit: '兩邊一樣，代表金鑰沒有被換掉；它不能證明對方是誰，所以請用電話或當面和他核對。',
    safetyLocal: '核對碼是在你的電腦上算出來的。',
    safetyCodeLabel: '你和這位朋友的核對碼',
    safetyVerifyButton: '一樣',
    safetyVerifiedTag: '已核對',
    safetyNotVerifiedTag: '還沒核對',
    safetyChangedVerify: '去核對',
    safetyChangedLater: '稍後核對',
    safetyDifferentButton: '不一樣',
    safetyDifferentExplain: '核對碼不一樣：可能有人冒充。先別在這裡傳敏感內容，改用當面或電話再確認一次。',
  },
}

export function safetyText(key: SafetyKey, lang: Lang): string {
  return SAFETY_STRINGS[lang][key]
}

function shownName(name: string): string {
  const shown = truncateToCells(name, 12)
  return shown === '' ? '?' : shown
}

/** 金鑰變了的警示全文（含名字，名字先 truncateToCells(name, 12)，空名字用 '?'） */
export function safetyChanged(name: string, lang: Lang): string {
  const shown = shownName(name)
  if (lang === 'zh-TW') return shown + ' 的金鑰變了。可能是他換了電腦或重新安裝，也可能有人冒充他。在你和他核對新的碼之前，請不要在這個對話裡傳敏感內容。'
  return shown + '\'s keys changed. They may have a new computer or a fresh install, or someone else may be pretending to be them. Until you check the new code with them, don\'t send anything sensitive in this chat.'
}

/** 對話列表上的一行警示（含名字，同上截斷）；一行 */
export function safetyChangedBanner(name: string, lang: Lang): string {
  const shown = shownName(name)
  if (lang === 'zh-TW') return shown + ' 的金鑰變了：和他核對前，先別傳敏感內容'
  return shown + '\'s keys changed: check with them before sending sensitive info'
}

/** 把「已經算好的核對碼」排成 4 字元一組、4 組一列。不合格 → 空陣列 */
export function formatSafetyCode(code: string): string[] {
  if (typeof code !== 'string') return []
  const flat = code.replace(/\s+/g, '')
  if (!new RegExp('^[0-9a-fA-F]{16,64}$').test(flat)) return []
  const upper = flat.toUpperCase()
  const groups: string[] = []
  for (let i = 0; i < upper.length; i += 4) groups.push(upper.slice(i, i + 4))
  const rows: string[] = []
  for (let i = 0; i < groups.length; i += 4) rows.push(groups.slice(i, i + 4).join(' '))
  return rows
}

