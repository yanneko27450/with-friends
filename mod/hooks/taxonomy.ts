// 封閉詞彙：好友看到的「在做什麼」只能是 動作 × 對象 兩個代碼。
// 這份是唯一來源：mod 用它分類與顯示，中繼（relay/server.mjs）直接 import 它做白名單。
// 只能用 Node 可直接剝除的 TS 語法（不要 enum、namespace），中繼才讀得進來。

/** 每個代碼本身就是給分類模型看的英文標籤，所以要寫得一看就懂。 */
export const ACTIONS = [
  'building-features',
  'fixing-bugs',
  'refactoring',
  'writing-tests',
  'researching',
  'learning',
  'writing-docs',
  'designing',
  'planning',
  'analyzing-data',
  'setting-up',
  'reviewing',
  'other',
] as const

export const SUBJECTS = [
  'website',
  'app',
  'backend',
  'game',
  'ai-agent',
  'automation',
  'data',
  'document',
  'coursework',
  'dev-environment',
  'creative-media',
  'other',
] as const

export type Action = (typeof ACTIONS)[number]
export type Subject = (typeof SUBJECTS)[number]
export type Lang = 'en' | 'zh-TW'
export const LANGS: readonly Lang[] = ['en', 'zh-TW']

export const isAction = (v: unknown): v is Action => typeof v === 'string' && (ACTIONS as readonly string[]).includes(v)
export const isSubject = (v: unknown): v is Subject => typeof v === 'string' && (SUBJECTS as readonly string[]).includes(v)

/** 看的人用自己的語言讀代碼；代碼不在表裡（舊版中繼、別人的新版）就當 other。 */
export const ACTION_LABEL: Record<Lang, Record<Action, string>> = {
  en: {
    'building-features': 'Building features',
    'fixing-bugs': 'Fixing bugs',
    refactoring: 'Refactoring',
    'writing-tests': 'Writing tests',
    researching: 'Researching',
    learning: 'Learning',
    'writing-docs': 'Writing',
    designing: 'Designing',
    planning: 'Planning',
    'analyzing-data': 'Analyzing data',
    'setting-up': 'Setting up',
    reviewing: 'Reviewing',
    other: 'Working',
  },
  'zh-TW': {
    'building-features': '寫功能',
    'fixing-bugs': '修錯誤',
    refactoring: '整理程式',
    'writing-tests': '寫測試',
    researching: '查資料',
    learning: '學新東西',
    'writing-docs': '寫文件',
    designing: '做設計',
    planning: '規劃',
    'analyzing-data': '分析資料',
    'setting-up': '安裝設定',
    reviewing: '審查',
    other: '在忙',
  },
}

export const SUBJECT_LABEL: Record<Lang, Record<Subject, string>> = {
  en: {
    website: 'a website',
    app: 'an app',
    backend: 'a backend',
    game: 'a game',
    'ai-agent': 'an AI agent',
    automation: 'automation',
    data: 'data',
    document: 'a document',
    coursework: 'coursework',
    'dev-environment': 'dev environment',
    'creative-media': 'creative work',
    other: '',
  },
  'zh-TW': {
    website: '網站',
    app: 'App',
    backend: '後端',
    game: '遊戲',
    'ai-agent': 'AI 代理',
    automation: '自動化',
    data: '資料',
    document: '文件',
    coursework: '課業',
    'dev-environment': '開發環境',
    'creative-media': '創作',
    other: '',
  },
}

/** 「修錯誤 · 網站」／「Fixing bugs · a website」；對象是 other 就只顯示動作。 */
export function activityText(action: unknown, subject: unknown, lang: Lang): string {
  const a = isAction(action) ? action : 'other'
  const s = isSubject(subject) ? subject : 'other'
  const left = ACTION_LABEL[lang][a]
  const right = SUBJECT_LABEL[lang][s]
  return right ? `${left} · ${right}` : left
}
