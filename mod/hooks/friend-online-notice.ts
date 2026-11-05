import { cleanName } from './text'
import type { Lang } from './taxonomy'

export type NoticePresence = 'working' | 'idle' | 'offline'

export type RosterEntry = Readonly<{ id: string; name: string; presence: NoticePresence; isMe: boolean; isDemo: boolean }>

export type NoticeState = Readonly<{
  online: Readonly<Record<string, boolean>>
  lastNoticeAt: Readonly<Record<string, number>>
  lastAnyAt: number
  isPrimed: boolean
}>

export const NOTICE_INITIAL: NoticeState = Object.freeze({
  online: Object.freeze({} as Record<string, boolean>),
  lastNoticeAt: Object.freeze({} as Record<string, number>),
  lastAnyAt: 0,
  isPrimed: false,
})

export type NoticeConfig = Readonly<{
  isEnabled: boolean
  perFriendCooldownMs: number
  minGapMs: number
}>

export const NOTICE_DEFAULTS: NoticeConfig = Object.freeze({
  isEnabled: true,
  perFriendCooldownMs: 600_000,
  minGapMs: 30_000,
})

export type Notice = Readonly<{ names: readonly string[]; total: number }>

const DAY_MS = 86_400_000
const ID_PATTERN = new RegExp('^[A-Za-z0-9_-]{1,64}$')

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}

const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

type CleanEntry = Readonly<{ id: string; name: string; online: boolean }>

const cleanRoster = (roster: unknown[]): CleanEntry[] => {
  const out: CleanEntry[] = []
  const seen = new Set<string>()
  for (const raw of roster.slice(0, 200)) {
    const e = asRecord(raw)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const id = has(e, 'id') ? e.id : undefined
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || id === '__proto__') continue
    if (seen.has(id)) continue
    seen.add(id)
    const presence = has(e, 'presence') ? e.presence : undefined
    if (presence !== 'working' && presence !== 'idle' && presence !== 'offline') continue
    const isMe = has(e, 'isMe') ? e.isMe === true : false
    const isDemo = has(e, 'isDemo') ? e.isDemo === true : false
    if (isMe || isDemo) continue
    const cleaned = cleanName(has(e, 'name') ? e.name : undefined, 20)
    out.push({ id, name: cleaned === '' ? '?' : cleaned, online: presence !== 'offline' })
  }
  return out
}

const buildOnline = (entries: readonly CleanEntry[]): Readonly<Record<string, boolean>> => {
  const acc = Object.create(null) as Record<string, boolean>
  for (const e of entries) acc[e.id] = e.online
  return Object.freeze({ ...acc })
}

export function nextNotice(
  prev: NoticeState,
  roster: unknown,
  nowMs: number,
  cfg: NoticeConfig,
): Readonly<{ state: NoticeState; notice: Notice | null }> {
  if (!Array.isArray(roster)) return Object.freeze({ state: prev, notice: null })
  if (!isFiniteNumber(nowMs)) return Object.freeze({ state: prev, notice: null })

  const p = asRecord(prev)
  const prevOnline = asRecord(has(p, 'online') ? p.online : undefined)
  const prevLast = asRecord(has(p, 'lastNoticeAt') ? p.lastNoticeAt : undefined)
  const prevLastAnyRaw = has(p, 'lastAnyAt') ? p.lastAnyAt : undefined
  const prevLastAnyAt = isFiniteNumber(prevLastAnyRaw) ? prevLastAnyRaw : 0
  const primed = has(p, 'isPrimed') ? p.isPrimed === true : false

  const entries = cleanRoster(roster)
  const online = buildOnline(entries)

  if (!primed) {
    const state: NoticeState = Object.freeze({
      online,
      lastNoticeAt: Object.freeze({} as Record<string, number>),
      lastAnyAt: 0,
      isPrimed: true,
    })
    return Object.freeze({ state, notice: null })
  }

  const cfgObj = asRecord(cfg)
  const isEnabled = has(cfgObj, 'isEnabled') ? cfgObj.isEnabled === true : false

  if (!isEnabled) {
    const acc = Object.create(null) as Record<string, number>
    for (const k of Object.keys(prevLast)) {
      const t = prevLast[k]
      if (isFiniteNumber(t)) acc[k] = t
    }
    const state: NoticeState = Object.freeze({
      online,
      lastNoticeAt: Object.freeze({ ...acc }),
      lastAnyAt: prevLastAnyAt,
      isPrimed: true,
    })
    return Object.freeze({ state, notice: null })
  }

  const cooldownRaw = has(cfgObj, 'perFriendCooldownMs') ? cfgObj.perFriendCooldownMs : undefined
  const perFriendCooldownMs =
    isFiniteNumber(cooldownRaw) && cooldownRaw >= 0 ? cooldownRaw : NOTICE_DEFAULTS.perFriendCooldownMs
  const gapRaw = has(cfgObj, 'minGapMs') ? cfgObj.minGapMs : undefined
  const minGapMs = isFiniteNumber(gapRaw) && gapRaw >= 0 ? gapRaw : NOTICE_DEFAULTS.minGapMs

  const rosterIds = new Set(entries.map((e) => e.id))
  const trimLast = (extra: readonly (readonly [string, number])[]): Readonly<Record<string, number>> => {
    const acc = Object.create(null) as Record<string, number>
    const put = (k: string, t: unknown): void => {
      if (!rosterIds.has(k)) return
      if (!isFiniteNumber(t)) return
      const age = nowMs - t
      if (age < 0 || age > DAY_MS) return
      acc[k] = t
    }
    for (const k of Object.keys(prevLast)) put(k, prevLast[k])
    for (const [k, t] of extra) put(k, t)
    return Object.freeze({ ...acc })
  }

  const candidates = entries.filter((e) => e.online && has(prevOnline, e.id) && prevOnline[e.id] === false)
  const gapDiff = nowMs - prevLastAnyAt
  const gapBlocked = prevLastAnyAt > 0 && gapDiff >= 0 && gapDiff < minGapMs

  let notice: Notice | null = null
  let noticed: CleanEntry[] = []
  if (!gapBlocked) {
    noticed = candidates.filter((e) => {
      if (!has(prevLast, e.id)) return true
      const last = prevLast[e.id]
      if (!isFiniteNumber(last)) return true
      const diff = nowMs - last
      return !(diff >= 0 && diff < perFriendCooldownMs)
    })
    if (noticed.length > 0) {
      notice = Object.freeze({
        names: Object.freeze(noticed.slice(0, 3).map((e) => e.name)),
        total: noticed.length,
      })
    }
  }

  const state: NoticeState = Object.freeze({
    online,
    lastNoticeAt: notice ? trimLast(noticed.map((e) => [e.id, nowMs] as const)) : trimLast([]),
    lastAnyAt: notice ? nowMs : prevLastAnyAt,
    isPrimed: true,
  })
  return Object.freeze({ state, notice })
}

const charCell = (ch: string): number => ((ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1)

const truncateName = (name: string): string => {
  let total = 0
  for (const ch of name) total += charCell(ch)
  if (total <= 10) return name
  let w = 0
  let out = ''
  for (const ch of name) {
    const cw = charCell(ch)
    if (w + cw > 9) break
    w += cw
    out += ch
  }
  return out + '…'
}

export function noticeText(n: Notice, lang: Lang): string {
  if (typeof n !== 'object' || n === null) return ''
  const rawNames = Array.isArray(n.names) ? n.names : []
  const names = rawNames.filter((v): v is string => typeof v === 'string').map(truncateName)
  const totalRaw = isFiniteNumber(n.total) ? Math.floor(n.total) : 0
  const total = Math.max(totalRaw, names.length)
  if (names.length === 0 || total < 1) return ''
  const shown = names.slice(0, 3)
  const a = shown[0] as string
  if (shown.length === 1) return lang === 'en' ? `${a} is online` : `${a} 上線了`
  const b = shown[1] as string
  if (shown.length === 2) return lang === 'en' ? `${a} and ${b} are online` : `${a}、${b} 上線了`
  const c = shown[2] as string
  const extra = total - 3
  if (extra > 0) {
    return lang === 'en'
      ? `${a}, ${b}, ${c} and ${extra} more are online`
      : `${a}、${b}、${c} 和另外 ${extra} 位上線了`
  }
  return lang === 'en' ? `${a}, ${b} and ${c} are online` : `${a}、${b}、${c} 上線了`
}

export type NoticeStrings = Readonly<{ label: string; buttonName: string; hint: string; on: string; off: string; privacyNote: string }>

export const NOTICE_STRINGS: Readonly<Record<Lang, NoticeStrings>> = Object.freeze({
  en: Object.freeze({
    label: 'Tell me when friends come online',
    buttonName: 'Turn the friend-online reminder on or off',
    hint: 'A short line appears here when a friend comes online.',
    on: 'On',
    off: 'Off',
    privacyNote: 'This uses the online status you already see. Nothing extra is sent.',
  }),
  'zh-TW': Object.freeze({
    label: '朋友上線時提醒我',
    buttonName: '開啟或關閉朋友上線提醒',
    hint: '朋友上線時，這裡會跳出一小行提示。',
    on: '開',
    off: '關',
    privacyNote: '這只用你本來就看得到的在線狀態，不會多送任何東西。',
  }),
})

export function noticeStrings(lang: Lang): NoticeStrings {
  return NOTICE_STRINGS[lang]
}
