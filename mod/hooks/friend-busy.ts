import type { Lang } from './taxonomy'

export const BUSY_STRINGS: Record<Lang, {
  busy: string
  underMinute: string
  min: (n: number) => string
  hour: (n: number) => string
  day: (n: number) => string
}> = {
  en: {
    busy: 'Busy',
    underMinute: 'under 1 min',
    min: (n: number) => n + ' min',
    hour: (n: number) => n + ' h',
    day: (n: number) => n + ' d',
  },
  'zh-TW': {
    busy: '在忙',
    underMinute: '不到 1 分鐘',
    min: (n: number) => n + ' 分鐘',
    hour: (n: number) => n + ' 小時',
    day: (n: number) => n + ' 天',
  },
}

const busyLang = (lang: Lang): 'en' | 'zh-TW' => lang === 'zh-TW' ? 'zh-TW' : 'en'

/** 把「這件事開始多久了」（秒）寫成短字串：sec 不是有限的數字、或小於 0 → ''（呼叫端當成不顯示）；0～59 秒 → underMinute；60 秒～59 分 → min(整數分鐘)；1 小時～47 小時 → hour(整數小時)；48 小時以上 → day(整數天)；滿 100 天（8,640,000 秒）以上 → ''（不顯示，防止中繼送來超大的數字）。一律無條件捨去。lang 只認 'en'／'zh-TW'，其他當 'en' */
export function busyDuration(sec: unknown, lang: Lang): string {
  const strings = BUSY_STRINGS[busyLang(lang)]
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return ''
  const whole = Math.floor(sec)
  if (whole < 60) return strings.underMinute
  if (whole < 3600) return strings.min(Math.floor(whole / 60))
  if (whole < 172800) return strings.hour(Math.floor(whole / 3600))
  if (whole >= 8640000) return ''
  return strings.day(Math.floor(whole / 86400))
}

/** 好友列狀態那段要顯示的字：presence 嚴格等於 'working'、hasAction 嚴格等於 true、busyDuration 的結果不是 '' → `${BUSY_STRINGS[lang].busy} · ${duration}`；其他任何情形一律回 null（呼叫端改用原本的狀態字）。參數都是 unknown，什麼值都不能丟例外；lang 只認 'en'／'zh-TW'，其他當 'en' */
export function busyLine(presence: unknown, hasAction: unknown, activityAgoSec: unknown, lang: Lang): string | null {
  if (presence !== 'working' || hasAction !== true) return null
  const duration = busyDuration(activityAgoSec, lang)
  if (duration === '') return null
  return BUSY_STRINGS[busyLang(lang)].busy + ' · ' + duration
}
