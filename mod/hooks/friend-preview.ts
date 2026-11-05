import type { Lang } from './taxonomy'
import { activityText, isAction, isAvatar, isSubject } from './taxonomy'

export const PREVIEW_ROW_IDS = ['name', 'group', 'avatar', 'status', 'doing', 'since', 'version', 'owner'] as const
export type PreviewRowId = (typeof PREVIEW_ROW_IDS)[number]

export type PreviewInput = {
  name: unknown
  groupName: unknown
  avatar: unknown
  isOwner: unknown
  version: unknown
  body: unknown
  activityAgoSec: unknown
}

export type PreviewRow = Readonly<{
  id: PreviewRowId
  label: string
  value: string
  kind: 'free-text' | 'code'
}>

export const PREVIEW_STRINGS: Record<Lang, {
  title: string
  button: string
  buttonName: string
  close: string
  intro: string
  freeTextNote: string
  none: string
  yes: string
  no: string
  justNow: string
  minAgo: (n: number) => string
  hourAgo: (n: number) => string
  dayAgo: (n: number) => string
  startedPrefix: string
  startedSuffix: string
  presence: Record<'working' | 'idle' | 'offline', string>
  labels: Record<PreviewRowId, string>
}> = {
  en: {
    title: 'What friends see of me',
    button: 'Preview',
    buttonName: 'Open the preview',
    close: 'Close',
    intro: 'This is everything your friends see about you.',
    freeTextNote: 'Your name and group name are text you chose. Everything else is a code from a fixed list.',
    none: '(none)',
    yes: 'Yes',
    no: 'No',
    justNow: 'just now',
    minAgo: (n: number) => `${n}m ago`,
    hourAgo: (n: number) => `${n}h ago`,
    dayAgo: (n: number) => `${n}d ago`,
    startedPrefix: 'started ',
    startedSuffix: '',
    presence: { working: 'Working', idle: 'Idle', offline: 'Offline' },
    labels: {
      name: 'Name',
      group: 'Group',
      avatar: 'Avatar',
      status: 'Status',
      doing: 'Doing',
      since: 'Started',
      version: 'Version',
      owner: 'Group owner',
    },
  },
  'zh-TW': {
    title: '朋友看到的我',
    button: '預覽',
    buttonName: '打開預覽',
    close: '關閉',
    intro: '你的朋友看到的你，就是下面這幾項，沒有別的。',
    freeTextNote: '名字和群組名是你自己取的字，其餘都是固定清單裡的代碼。',
    none: '（沒有）',
    yes: '是',
    no: '不是',
    justNow: '剛剛',
    minAgo: (n: number) => `${n} 分鐘前`,
    hourAgo: (n: number) => `${n} 小時前`,
    dayAgo: (n: number) => `${n} 天前`,
    startedPrefix: '',
    startedSuffix: '開始',
    presence: { working: '工作中', idle: '閒置', offline: '離線' },
    labels: {
      name: '名字',
      group: '群組',
      avatar: '頭像',
      status: '狀態',
      doing: '在做什麼',
      since: '開始時間',
      version: '版本',
      owner: '建立者',
    },
  },
}

export function previewText(lang: Lang): (typeof PREVIEW_STRINGS)['en'] {
  return PREVIEW_STRINGS[lang]
}

const VERSION_PATTERN = new RegExp('^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$')

const field = (obj: unknown, key: string): unknown => {
  if (typeof obj !== 'object' || obj === null) return undefined
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined
  try {
    return (obj as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

const asRecord = (v: unknown): unknown => (typeof v === 'object' && v !== null ? v : {})

const charCells = (ch: string): number => ((ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1)

const truncateToCells = (text: string, maxCells: number): string => {
  let total = 0
  for (const ch of text) total += charCells(ch)
  if (total <= maxCells) return text
  let width = 0
  let out = ''
  for (const ch of text) {
    const w = charCells(ch)
    if (width + w + 1 > maxCells) break
    out += ch
    width += w
  }
  return out + '…'
}

const cleanFreeText = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  if (trimmed === '') return null
  const oneLine = trimmed.replace(/\s+/g, ' ')
  return [...oneLine].slice(0, 20).join('')
}

type StringsShape = (typeof PREVIEW_STRINGS)['en']

const agoText = (v: unknown, s: StringsShape): string => {
  const sec = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
  if (sec < 60) return s.justNow
  if (sec < 3600) return s.minAgo(Math.floor(sec / 60))
  if (sec < 86400) return s.hourAgo(Math.floor(sec / 3600))
  return s.dayAgo(Math.floor(sec / 86400))
}

export function buildPreviewRows(input: PreviewInput, lang: Lang): PreviewRow[] {
  const s = PREVIEW_STRINGS[lang]
  const src: unknown = input
  const body = asRecord(field(src, 'body'))
  const rows: PreviewRow[] = []
  const push = (id: PreviewRowId, kind: 'free-text' | 'code', value: string): void => {
    rows.push({ id, label: s.labels[id], value: truncateToCells(value, 40), kind })
  }

  const name = cleanFreeText(field(src, 'name'))
  push('name', 'free-text', name ?? s.none)

  const group = cleanFreeText(field(src, 'groupName'))
  push('group', 'free-text', group ?? s.none)

  const avatar = field(src, 'avatar')
  push('avatar', 'code', isAvatar(avatar) ? avatar : s.none)

  const state = field(body, 'state')
  push('status', 'code', state === 'working' || state === 'idle' || state === 'offline' ? s.presence[state] : s.none)

  const paused = field(body, 'paused')
  const action = field(body, 'action')
  const subject = field(body, 'subject')
  const doing = paused !== true && isAction(action) && isSubject(subject) ? activityText(action, subject, lang) : null
  push('doing', 'code', doing ?? s.none)

  if (doing !== null) {
    push('since', 'code', s.startedPrefix + agoText(field(src, 'activityAgoSec'), s) + s.startedSuffix)
  }

  const version = field(src, 'version')
  if (typeof version === 'string' && VERSION_PATTERN.test(version)) {
    push('version', 'code', version)
  }

  const isOwner = field(src, 'isOwner')
  if (isOwner === true) {
    push('owner', 'code', s.yes)
  } else if (isOwner === false) {
    push('owner', 'code', s.no)
  }

  return rows
}
