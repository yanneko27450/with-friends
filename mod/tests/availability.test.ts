import { expect, test } from 'claude-code/testing'
import { cellWidth } from '../hooks/changelog'
import {
  AVAILABILITY_CODES,
  AVAILABILITY_ICONS,
  AVAILABILITY_STRINGS,
  AVAILABILITY_TONES,
  availabilityChoices,
  availabilityLabel,
  availabilityStrings,
  availabilityToast,
  effectiveAvailability,
  isAvailability,
} from '../hooks/availability'
import type { Availability } from '../hooks/availability'
import type { Lang } from '../hooks/taxonomy'

const LANGS: Lang[] = ['en', 'zh-TW']
const asCode = (v: unknown): Availability | null => v as Availability | null

const allStrings = (): string[] => {
  const out: string[] = []
  for (const lang of LANGS) {
    const s = availabilityStrings(lang)
    out.push(...Object.values(s.labels), ...Object.values(s.hints))
    out.push(s.clear, s.clearHint, s.button, s.buttonName, s.askHeader, s.askQuestion, s.intro, s.pausedNote, s.selfPickedNote, s.currentPrefix)
    for (const c of availabilityChoices('focus', lang)) out.push(c.label, c.hint)
    for (const code of AVAILABILITY_CODES) out.push(availabilityToast(code, lang))
    out.push(availabilityToast(null, lang))
  }
  return out
}

test('AVAILABILITY_CODES 固定四個、順序固定', async () => {
  expect([...AVAILABILITY_CODES]).toEqual(['focus', 'open', 'need-help', 'standby'])
  expect(AVAILABILITY_CODES).toHaveLength(4)
})

test('isAvailability：四個代碼為真（直接寫與經 AVAILABILITY_CODES 取用各一輪）', async () => {
  for (const code of ['focus', 'open', 'need-help', 'standby']) expect(isAvailability(code)).toBe(true)
  for (const code of AVAILABILITY_CODES) expect(isAvailability(code)).toBe(true)
})

test('isAvailability：大小寫不同、空白、自由文字、非字串都為假', async () => {
  const falsy: unknown[] = [
    'Focus',
    'FOCUS',
    'focus ',
    ' focus',
    'please help',
    '',
    'need_help',
    '__proto__',
    null,
    undefined,
    1,
    0,
    true,
    Number.NaN,
    ['focus'],
    { code: 'focus' },
  ]
  expect(falsy.length).toBeGreaterThanOrEqual(8)
  for (const v of falsy) expect(isAvailability(v)).toBe(false)
})

test('isAvailability：10 萬字元字串為假、不丟例外', async () => {
  const big = 'x'.repeat(100000)
  expect(() => isAvailability(big)).not.toThrow()
  expect(isAvailability(big)).toBe(false)
})

test('availabilityLabel：四個代碼兩種語言照代碼表', async () => {
  expect(availabilityLabel('focus', 'zh-TW')).toBe('專心')
  expect(availabilityLabel('open', 'zh-TW')).toBe('歡迎找我')
  expect(availabilityLabel('need-help', 'zh-TW')).toBe('需要幫看')
  expect(availabilityLabel('standby', 'zh-TW')).toBe('待命')
  expect(availabilityLabel('focus', 'en')).toBe('Focused')
  expect(availabilityLabel('open', 'en')).toBe('Happy to chat')
  expect(availabilityLabel('need-help', 'en')).toBe('Need a hand')
  expect(availabilityLabel('standby', 'en')).toBe('On standby')
  expect(availabilityLabel('open', 'zh-TW')).toBe(availabilityStrings('zh-TW').labels.open)
})

test('availabilityLabel：不合法輸入回空字串，絕不把輸入原樣回傳', async () => {
  const bad: unknown[] = ['nope', 'Focus', 'focus ', '', '__proto__', null, undefined, 7, ['open'], { toString: () => 'open' }]
  for (const v of bad) {
    for (const lang of LANGS) {
      expect(availabilityLabel(v, lang)).toBe('')
    }
  }
  expect(availabilityLabel('x'.repeat(100000), 'en')).toBe('')
})

test('labels 與 hints：四個代碼兩種語言都非空、不顯示內部代碼', async () => {
  for (const lang of LANGS) {
    const s = availabilityStrings(lang)
    for (const code of AVAILABILITY_CODES) {
      const label = s.labels[code]
      const hint = s.hints[code]
      expect(label.length).toBeGreaterThan(0)
      expect(hint.length).toBeGreaterThan(0)
      expect(label).not.toBe(code)
      expect(hint).not.toBe(code)
      expect(label).not.toContain('need-help')
      expect(hint).not.toContain('need-help')
    }
  }
})

test('AVAILABILITY_ICONS 與 AVAILABILITY_TONES 照表且凍結', async () => {
  expect(AVAILABILITY_ICONS.focus).toBe('headphones')
  expect(AVAILABILITY_ICONS.open).toBe('door-open')
  expect(AVAILABILITY_ICONS['need-help']).toBe('life-buoy')
  expect(AVAILABILITY_ICONS.standby).toBe('coffee')
  expect(AVAILABILITY_TONES.focus).toBe('warn')
  expect(AVAILABILITY_TONES.open).toBe('good')
  expect(AVAILABILITY_TONES['need-help']).toBe('accent')
  expect(AVAILABILITY_TONES.standby).toBe('muted')
  expect(Object.isFrozen(AVAILABILITY_ICONS)).toBe(true)
  expect(Object.isFrozen(AVAILABILITY_TONES)).toBe(true)
})

test('字串定版：clear、clearHint、button、buttonName、askHeader、currentPrefix', async () => {
  const en = availabilityStrings('en')
  const zh = availabilityStrings('zh-TW')
  expect(en.clear).toBe('Not set')
  expect(zh.clear).toBe('不設定')
  expect(en.clearHint).toBe('Show nothing next to my name.')
  expect(zh.clearHint).toBe('名字旁邊不顯示標示。')
  expect(en.button).toBe('Availability')
  expect(zh.button).toBe('可打擾程度')
  expect(en.buttonName).toBe('Choose how available you are')
  expect(zh.buttonName).toBe('選擇你現在方不方便被找')
  expect(en.askHeader).toBe('Availability')
  expect(zh.askHeader).toBe('可打擾程度')
  expect(en.currentPrefix).toBe('Now: ')
  expect(zh.currentPrefix).toBe('目前：')
})

test('固定承諾句 A1、A2、A3 逐字相等，且 askQuestion 就是 A1', async () => {
  const en = availabilityStrings('en')
  const zh = availabilityStrings('zh-TW')
  expect(en.intro).toBe('Friends see this label next to your name.')
  expect(zh.intro).toBe('朋友會在你的名字旁邊看到這個標示。')
  expect(en.pausedNote).toBe("While sharing is paused, friends don't see it.")
  expect(zh.pausedNote).toBe('暫停分享時，朋友看不到這個標示。')
  expect(en.selfPickedNote).toBe('You pick it yourself. It is not worked out from what you do.')
  expect(zh.selfPickedNote).toBe('這是你自己選的，不是從你做的事推測出來的。')
  expect(en.askQuestion).toBe(en.intro)
  expect(zh.askQuestion).toBe(zh.intro)
  expect(AVAILABILITY_STRINGS.en.intro).toBe(en.intro)
  expect(AVAILABILITY_STRINGS['zh-TW'].pausedNote).toBe(zh.pausedNote)
})

test('格數與字數上限：label ≤ 14、hint ≤ 40、A1～A3 ≤ 60、askHeader ≤ 12 個字、toast ≤ 50', async () => {
  for (const lang of LANGS) {
    const s = availabilityStrings(lang)
    for (const code of AVAILABILITY_CODES) {
      expect(cellWidth(s.labels[code])).toBeLessThanOrEqual(14)
      expect(cellWidth(s.hints[code])).toBeLessThanOrEqual(40)
    }
    expect(cellWidth(s.clearHint)).toBeLessThanOrEqual(40)
    expect(cellWidth(s.intro)).toBeLessThanOrEqual(60)
    expect(cellWidth(s.pausedNote)).toBeLessThanOrEqual(60)
    expect(cellWidth(s.selfPickedNote)).toBeLessThanOrEqual(60)
    expect([...s.askHeader].length).toBeLessThanOrEqual(12)
    for (const code of AVAILABILITY_CODES) expect(cellWidth(availabilityToast(code, lang))).toBeLessThanOrEqual(50)
    expect(cellWidth(availabilityToast(null, lang))).toBeLessThanOrEqual(50)
  }
})

test('availabilityChoices：固定五個、順序是四個代碼再接不設定', async () => {
  for (const lang of LANGS) {
    const choices = availabilityChoices(null, lang)
    expect(choices).toHaveLength(5)
    expect(choices.map((c) => c.code)).toEqual(['focus', 'open', 'need-help', 'standby', null])
    const s = availabilityStrings(lang)
    expect(choices[4]?.label).toBe(s.clear)
    expect(choices[4]?.hint).toBe(s.clearHint)
    for (let i = 0; i < 4; i++) {
      const code = AVAILABILITY_CODES[i] as Availability
      expect(choices[i]?.label).toBe(s.labels[code])
      expect(choices[i]?.hint).toBe(s.hints[code])
    }
  }
})

test('availabilityChoices：isSelected 只標目前選的那個；不合法時只有不設定被選', async () => {
  for (const code of AVAILABILITY_CODES) {
    const choices = availabilityChoices(code, 'en')
    const picked = choices.filter((c) => c.isSelected)
    expect(picked).toHaveLength(1)
    expect(picked[0]?.code).toBe(code)
  }
  for (const current of [null, 'x', undefined, 'Focus', 3] as unknown[]) {
    const choices = availabilityChoices(current, 'zh-TW')
    const picked = choices.filter((c) => c.isSelected)
    expect(picked).toHaveLength(1)
    expect(picked[0]?.code).toBe(null)
  }
})

test('availabilityChoices：回傳陣列與物件都凍結、同樣輸入同樣輸出、凍結的輸入不被改', async () => {
  const a = availabilityChoices('open', 'en')
  const b = availabilityChoices('open', 'en')
  expect(a).toEqual(b)
  expect(Object.isFrozen(a)).toBe(true)
  for (const c of a) expect(Object.isFrozen(c)).toBe(true)
  const frozenInput = Object.freeze(['focus'])
  expect(() => availabilityChoices(frozenInput, 'en')).not.toThrow()
  expect(frozenInput).toEqual(['focus'])
  expect(availabilityChoices(frozenInput, 'en')[4]?.isSelected).toBe(true)
})

test('effectiveAvailability：暫停（嚴格 true）時一律 null；沒暫停時合法代碼原樣', async () => {
  for (const code of AVAILABILITY_CODES) {
    expect(effectiveAvailability(code, true)).toBe(null)
    expect(effectiveAvailability(code, false)).toBe(code)
  }
})

test('effectiveAvailability：isPaused 只有嚴格 true 算暫停；stored 不合法回 null', async () => {
  expect(effectiveAvailability('focus', 'yes')).toBe('focus')
  expect(effectiveAvailability('focus', 1)).toBe('focus')
  expect(effectiveAvailability('focus', undefined)).toBe('focus')
  expect(effectiveAvailability('focus', null)).toBe('focus')
  expect(effectiveAvailability(null, false)).toBe(null)
  expect(effectiveAvailability(undefined, false)).toBe(null)
  expect(effectiveAvailability('Focus', false)).toBe(null)
  expect(effectiveAvailability('', false)).toBe(null)
  expect(effectiveAvailability(null, true)).toBe(null)
})

test('availabilityToast：四種輸出照規格', async () => {
  expect(availabilityToast('open', 'en')).toBe('Availability set to Happy to chat.')
  expect(availabilityToast('need-help', 'zh-TW')).toBe('可打擾程度已設為「需要幫看」。')
  expect(availabilityToast('focus', 'zh-TW')).toBe('可打擾程度已設為「專心」。')
  expect(availabilityToast('standby', 'en')).toBe('Availability set to On standby.')
  expect(availabilityToast(null, 'en')).toBe('Availability cleared.')
  expect(availabilityToast(null, 'zh-TW')).toBe('已清除可打擾程度。')
})

test('availabilityToast：不合法代碼當成清除', async () => {
  expect(availabilityToast(asCode('nope'), 'en')).toBe('Availability cleared.')
  expect(availabilityToast(asCode('Focus'), 'zh-TW')).toBe('已清除可打擾程度。')
  expect(availabilityToast(asCode(3), 'en')).toBe('Availability cleared.')
})

test('全部函式對 NaN、Infinity、物件、陣列不丟例外', async () => {
  const weird: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, {}, [], null, undefined]
  for (const v of weird) {
    expect(() => isAvailability(v)).not.toThrow()
    expect(() => availabilityLabel(v, 'en')).not.toThrow()
    expect(() => availabilityChoices(v, 'zh-TW')).not.toThrow()
    expect(() => effectiveAvailability(v, v)).not.toThrow()
    expect(() => availabilityToast(asCode(v), 'en')).not.toThrow()
  }
})

test('禁字掃描：所有產出字串（中英）不含禁字清單的字', async () => {
  const banned = [
    'encrypt',
    'end-to-end',
    'e2e',
    'secure',
    'private',
    'safe',
    'never',
    'always',
    'delete',
    '刪除',
    '保證',
    '絕對',
    '永遠',
    '私密',
    '保密',
    '安全',
    '推播',
    '系統通知',
    '已讀',
    '語音',
    '震動',
    '偵測',
    '請勿打擾',
    '封鎖',
  ]
  for (const s of allStrings()) {
    const lower = s.toLowerCase()
    for (const w of banned) expect(lower).not.toContain(w.toLowerCase())
  }
  expect(allStrings().length).toBeGreaterThan(0)
})
