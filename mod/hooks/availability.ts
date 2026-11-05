import type { Lang } from './taxonomy'

export const AVAILABILITY_CODES = ['focus', 'open', 'need-help', 'standby'] as const
export type Availability = (typeof AVAILABILITY_CODES)[number]

export const isAvailability: (v: unknown) => v is Availability = (v) =>
  v === 'focus' || v === 'open' || v === 'need-help' || v === 'standby'

export type AvailabilityStrings = Readonly<{
  labels: Readonly<Record<Availability, string>>
  hints: Readonly<Record<Availability, string>>
  clear: string
  clearHint: string
  button: string
  buttonName: string
  askHeader: string
  askQuestion: string
  intro: string
  pausedNote: string
  selfPickedNote: string
  currentPrefix: string
}>

const ZH_STRINGS: AvailabilityStrings = Object.freeze({
  labels: Object.freeze({
    focus: '專心',
    open: '歡迎找我',
    'need-help': '需要幫看',
    standby: '待命',
  }),
  hints: Object.freeze({
    focus: '正在專心做事，回覆可能比較慢',
    open: '有事可以直接找我',
    'need-help': '想請朋友幫忙看一下',
    standby: '人在，但沒有在忙什麼',
  }),
  clear: '不設定',
  clearHint: '名字旁邊不顯示標示。',
  button: '可打擾程度',
  buttonName: '選擇你現在方不方便被找',
  askHeader: '可打擾程度',
  askQuestion: '朋友會在你的名字旁邊看到這個標示。',
  intro: '朋友會在你的名字旁邊看到這個標示。',
  pausedNote: '暫停分享時，朋友看不到這個標示。',
  selfPickedNote: '這是你自己選的，不是從你做的事推測出來的。',
  currentPrefix: '目前：',
})

const EN_STRINGS: AvailabilityStrings = Object.freeze({
  labels: Object.freeze({
    focus: 'Focused',
    open: 'Happy to chat',
    'need-help': 'Need a hand',
    standby: 'On standby',
  }),
  hints: Object.freeze({
    focus: 'Focused right now, replies may be slower',
    open: 'Feel free to reach out any time',
    'need-help': 'Would like a friend to take a look',
    standby: 'Around, but not busy with anything',
  }),
  clear: 'Not set',
  clearHint: 'Show nothing next to my name.',
  button: 'Availability',
  buttonName: 'Choose how available you are',
  askHeader: 'Availability',
  askQuestion: 'Friends see this label next to your name.',
  intro: 'Friends see this label next to your name.',
  pausedNote: "While sharing is paused, friends don't see it.",
  selfPickedNote: 'You pick it yourself. It is not worked out from what you do.',
  currentPrefix: 'Now: ',
})

export const AVAILABILITY_STRINGS: Readonly<Record<Lang, AvailabilityStrings>> = Object.freeze({
  en: EN_STRINGS,
  'zh-TW': ZH_STRINGS,
})

export function availabilityStrings(lang: Lang): AvailabilityStrings {
  return AVAILABILITY_STRINGS[lang]
}

export function availabilityLabel(v: unknown, lang: Lang): string {
  if (!isAvailability(v)) return ''
  return availabilityStrings(lang).labels[v]
}

export const AVAILABILITY_ICONS: Readonly<Record<Availability, string>> = Object.freeze({
  focus: 'headphones',
  open: 'door-open',
  'need-help': 'life-buoy',
  standby: 'coffee',
})

export const AVAILABILITY_TONES: Readonly<Record<Availability, 'accent' | 'good' | 'warn' | 'muted'>> = Object.freeze({
  focus: 'warn',
  open: 'good',
  'need-help': 'accent',
  standby: 'muted',
})

export type AvailabilityChoice = Readonly<{ code: Availability | null; label: string; hint: string; isSelected: boolean }>

export function availabilityChoices(current: unknown, lang: Lang): readonly AvailabilityChoice[] {
  const strings = availabilityStrings(lang)
  const selected: Availability | null = isAvailability(current) ? current : null
  const choices: AvailabilityChoice[] = AVAILABILITY_CODES.map((code) =>
    Object.freeze({
      code,
      label: strings.labels[code],
      hint: strings.hints[code],
      isSelected: selected === code,
    }),
  )
  choices.push(
    Object.freeze({
      code: null,
      label: strings.clear,
      hint: strings.clearHint,
      isSelected: selected === null,
    }),
  )
  return Object.freeze(choices)
}

export function effectiveAvailability(stored: unknown, isPaused: unknown): Availability | null {
  if (isPaused === true) return null
  if (isAvailability(stored)) return stored
  return null
}

export function availabilityToast(code: Availability | null, lang: Lang): string {
  const strings = availabilityStrings(lang)
  if (isAvailability(code)) {
    const label = strings.labels[code]
    return lang === 'en' ? `Availability set to ${label}.` : `可打擾程度已設為「${label}」。`
  }
  return lang === 'en' ? 'Availability cleared.' : '已清除可打擾程度。'
}
