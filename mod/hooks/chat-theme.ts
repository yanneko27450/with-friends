import { cleanName } from './text'
import { cellWidth } from './changelog'
import type { Lang } from './taxonomy'

/** 主題檔格式版本。未來格式變了就加一，舊讀法遇到不認得的版本一律拒收 */
export const THEME_SCHEMA = 1 as const

/** 23 個命名顏色。值只能是 '#rrggbb'（小寫）或 'none'（不畫）。
 * page 聊天底 / side 側欄底 / panel 面板底 / text 主要字 / dim 淡字 / line 分隔線 /
 * acc 強調色（按鈕）/ onacc 強調色上的字 / mine 我的氣泡 / minetext 我的氣泡上的字 /
 * theirs 對方氣泡 / theirstext 對方氣泡上的字 / theirsline 對方氣泡的框 /
 * ok 在線 / warn 閒置 / off 離線 / sel 選中那列的底 / selbar 選中那列左邊的條 /
 * badgeBg 未讀數底 / badgeTx 未讀數字 / ring 頭像外圈 / grp 群組頭像底 / grptx 群組頭像上的字 */
export const COLOR_TOKENS = [
  'page', 'side', 'panel', 'text', 'dim', 'line', 'acc', 'onacc', 'mine', 'minetext', 'theirs', 'theirstext',
  'theirsline', 'ok', 'warn', 'off', 'sel', 'selbar', 'badgeBg', 'badgeTx', 'ring', 'grp', 'grptx',
] as const
export type ColorToken = (typeof COLOR_TOKENS)[number]

/** 終端機只能用「跟著使用者 Claude Code 主題」的顏色鍵。這 8 個角色各挑一個鍵 */
export const TERMINAL_ROLES = ['mine', 'theirs', 'accent', 'ok', 'warn', 'off', 'border', 'dim'] as const
export type TerminalRole = (typeof TERMINAL_ROLES)[number]
/** 允許的顏色鍵（Claude Code 的 ThemeKey 子集）；不在這裡的鍵一律拒收 */
export const TERMINAL_KEYS = [
  'text', 'inactive', 'subtle', 'suggestion', 'remember', 'success', 'error', 'warning', 'claude', 'permission', 'promptBorder',
] as const
export type TerminalKey = (typeof TERMINAL_KEYS)[number]

export const BORDER_STYLES = ['none', 'single', 'double', 'round', 'bold', 'classic'] as const
export type BorderStyle = (typeof BORDER_STYLES)[number]
export const BUBBLE_SHAPES = ['pill', 'round', 'square'] as const
export type BubbleShape = (typeof BUBBLE_SHAPES)[number]
export const AVATAR_FRAMES = ['circle', 'rounded', 'square'] as const
export type AvatarFrame = (typeof AVATAR_FRAMES)[number]
export const DENSITIES = ['airy', 'normal', 'tight'] as const
export type Density = (typeof DENSITIES)[number]
export const BACKGROUNDS = ['solid', 'dots', 'lines', 'grain'] as const
export type BackgroundKind = (typeof BACKGROUNDS)[number]
/** 空狀態小插圖的代碼（圖由外掛內建；目前還沒畫，主題只能挑代碼） */
export const EMPTY_ARTS = ['none', 'bubbles', 'plant', 'moon', 'sparkle'] as const
export type EmptyArt = (typeof EMPTY_ARTS)[number]
export const ICON_STROKES = [1, 1.5, 2, 2.5] as const
export const ICON_SIZES = [14, 16, 18, 20] as const

export type Theme = Readonly<{
  schema: typeof THEME_SCHEMA
  /** 小寫英數與連字號，2～24 字，開頭是英數：/^[a-z0-9][a-z0-9-]{1,23}$/ */
  id: string
  name: Readonly<Record<Lang, string>>
  creator: string
  description: Readonly<Record<Lang, string>>
  /** 可以是空字串 */
  copyright: string
  scheme: 'light' | 'dark'
  colors: Readonly<Record<ColorToken, string>>
  terminal: Readonly<Record<TerminalRole, TerminalKey>>
  shape: Readonly<{ border: BorderStyle; bubble: BubbleShape; avatarFrame: AvatarFrame; avatarRing: 0 | 1 | 2 }>
  spacing: Readonly<{ density: Density }>
  weight: Readonly<{ title: 'normal' | 'bold'; names: 'normal' | 'bold' }>
  icons: Readonly<{ set: 'lucide'; stroke: (typeof ICON_STROKES)[number]; size: (typeof ICON_SIZES)[number] }>
  background: Readonly<{ kind: BackgroundKind; tint: 'none' | ColorToken }>
  emptyArt: EmptyArt
}>

export type ThemeParseResult =
  | Readonly<{ ok: true; theme: Theme; warnings: readonly string[] }>
  | Readonly<{ ok: false; errors: readonly string[] }>

/** 主題檔文字最長 8,000 字元 */
export const THEME_FILE_MAX_CHARS = 8000

const TOP_KEYS: readonly string[] = [
  'schema', 'id', 'name', 'creator', 'description', 'copyright', 'scheme', 'colors', 'terminal', 'shape',
  'spacing', 'weight', 'icons', 'background', 'emptyArt',
]
const LANG_KEYS: readonly string[] = ['en', 'zh-TW']
/** 這些 token 不可以是 'none'（沒有它就畫不出字或主要的面） */
const NONE_FORBIDDEN: readonly ColorToken[] = [
  'page', 'side', 'panel', 'text', 'dim', 'acc', 'onacc', 'mine', 'minetext', 'theirstext', 'badgeTx', 'grp', 'grptx', 'ring',
]
const ID_PATTERN = new RegExp('^[a-z0-9][a-z0-9-]{1,23}$')
const HEX_DIGITS = '0123456789abcdef'
/** 要檢查對比的前景／底配對，照這個順序檢查 */
const CONTRAST_PAIRS: readonly (readonly [ColorToken, ColorToken])[] = [
  ['text', 'page'], ['text', 'panel'], ['text', 'side'], ['minetext', 'mine'],
  ['theirstext', 'theirs'], ['onacc', 'acc'], ['badgeTx', 'badgeBg'], ['grptx', 'grp'],
]

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto: unknown = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function hasKey(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function freezeDeep<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    const rec = v as Record<string, unknown>
    for (const k of Object.keys(rec)) freezeDeep(rec[k])
    Object.freeze(v)
  }
  return v
}

function fail(errors: string[]): ThemeParseResult {
  return Object.freeze({ ok: false as const, errors: Object.freeze(errors) })
}

/** 多出來的鍵一律報 unknown-key，鍵名本身也是輸入，不原樣印出 */
function unknownKeyErrors(obj: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(path === '' ? '?:unknown-key' : path + '.?:unknown-key')
  }
}

function checkText(errors: string[], path: string, v: unknown, maxCells: number, allowEmpty: boolean): void {
  if (typeof v !== 'string') {
    errors.push(path + ':type')
    return
  }
  if (cleanName(v, 200) !== v || (!allowEmpty && v === '')) {
    errors.push(path + ':unclean')
    return
  }
  if (cellWidth(v) > maxCells) errors.push(path + ':too-long')
}

function checkLangRecord(errors: string[], path: string, v: unknown, maxCells: number): void {
  if (!isPlainObject(v)) {
    errors.push(path + ':type')
    return
  }
  unknownKeyErrors(v, LANG_KEYS, path, errors)
  for (const lang of LANG_KEYS) {
    const p = path + '.' + lang
    if (!hasKey(v, lang)) errors.push(p + ':missing')
    else checkText(errors, p, v[lang], maxCells, false)
  }
}

function checkEnum(errors: string[], path: string, v: unknown, allowed: readonly string[]): void {
  if (typeof v !== 'string' || !allowed.includes(v)) errors.push(path + ':not-allowed')
}

/** 取出一個物件欄位；少了或不是普通物件時記一個錯並回 null */
function section(errors: string[], input: Record<string, unknown>, key: string): Record<string, unknown> | null {
  if (!hasKey(input, key)) {
    errors.push(key + ':missing')
    return null
  }
  const v = input[key]
  if (!isPlainObject(v)) {
    errors.push(key + ':type')
    return null
  }
  return v
}

/** 檢查 colors，回傳驗證過的值（只放合法的），供對比檢查與組裝 theme 用 */
function checkColors(errors: string[], input: Record<string, unknown>): Record<string, string> {
  const valid: Record<string, string> = {}
  const obj = section(errors, input, 'colors')
  if (obj === null) return valid
  unknownKeyErrors(obj, COLOR_TOKENS, 'colors', errors)
  for (const token of COLOR_TOKENS) {
    const p = 'colors.' + token
    if (!hasKey(obj, token)) {
      errors.push(p + ':missing')
      continue
    }
    const val = obj[token]
    if (val === 'none') {
      if (NONE_FORBIDDEN.includes(token)) errors.push(p + ':not-hex')
      else valid[token] = 'none'
    } else if (typeof val === 'string' && parseHex(val) !== null) {
      valid[token] = val
    } else {
      errors.push(p + ':not-hex')
    }
  }
  return valid
}

function checkTerminal(errors: string[], input: Record<string, unknown>): void {
  const obj = section(errors, input, 'terminal')
  if (obj === null) return
  unknownKeyErrors(obj, TERMINAL_ROLES, 'terminal', errors)
  for (const role of TERMINAL_ROLES) {
    const p = 'terminal.' + role
    if (!hasKey(obj, role)) {
      errors.push(p + ':missing')
      continue
    }
    const val = obj[role]
    if (typeof val !== 'string' || !(TERMINAL_KEYS as readonly string[]).includes(val)) errors.push(p + ':not-allowed')
  }
}

function checkShape(errors: string[], input: Record<string, unknown>): void {
  const obj = section(errors, input, 'shape')
  if (obj === null) return
  unknownKeyErrors(obj, ['border', 'bubble', 'avatarFrame', 'avatarRing'], 'shape', errors)
  if (!hasKey(obj, 'border')) errors.push('shape.border:missing')
  else checkEnum(errors, 'shape.border', obj['border'], BORDER_STYLES)
  if (!hasKey(obj, 'bubble')) errors.push('shape.bubble:missing')
  else checkEnum(errors, 'shape.bubble', obj['bubble'], BUBBLE_SHAPES)
  if (!hasKey(obj, 'avatarFrame')) errors.push('shape.avatarFrame:missing')
  else checkEnum(errors, 'shape.avatarFrame', obj['avatarFrame'], AVATAR_FRAMES)
  if (!hasKey(obj, 'avatarRing')) errors.push('shape.avatarRing:missing')
  else if (obj['avatarRing'] !== 0 && obj['avatarRing'] !== 1 && obj['avatarRing'] !== 2) errors.push('shape.avatarRing:not-allowed')
}

function checkSpacing(errors: string[], input: Record<string, unknown>): void {
  const obj = section(errors, input, 'spacing')
  if (obj === null) return
  unknownKeyErrors(obj, ['density'], 'spacing', errors)
  if (!hasKey(obj, 'density')) errors.push('spacing.density:missing')
  else checkEnum(errors, 'spacing.density', obj['density'], DENSITIES)
}

function checkWeight(errors: string[], input: Record<string, unknown>): void {
  const obj = section(errors, input, 'weight')
  if (obj === null) return
  unknownKeyErrors(obj, ['title', 'names'], 'weight', errors)
  if (!hasKey(obj, 'title')) errors.push('weight.title:missing')
  else checkEnum(errors, 'weight.title', obj['title'], ['normal', 'bold'])
  if (!hasKey(obj, 'names')) errors.push('weight.names:missing')
  else checkEnum(errors, 'weight.names', obj['names'], ['normal', 'bold'])
}

function checkIcons(errors: string[], input: Record<string, unknown>): void {
  const obj = section(errors, input, 'icons')
  if (obj === null) return
  unknownKeyErrors(obj, ['set', 'stroke', 'size'], 'icons', errors)
  if (!hasKey(obj, 'set')) errors.push('icons.set:missing')
  else if (obj['set'] !== 'lucide') errors.push('icons.set:not-allowed')
  if (!hasKey(obj, 'stroke')) errors.push('icons.stroke:missing')
  else if (!(ICON_STROKES as readonly number[]).includes(obj['stroke'] as number)) errors.push('icons.stroke:not-allowed')
  if (!hasKey(obj, 'size')) errors.push('icons.size:missing')
  else if (!(ICON_SIZES as readonly number[]).includes(obj['size'] as number)) errors.push('icons.size:not-allowed')
}

function checkBackground(errors: string[], input: Record<string, unknown>): void {
  const obj = section(errors, input, 'background')
  if (obj === null) return
  unknownKeyErrors(obj, ['kind', 'tint'], 'background', errors)
  if (!hasKey(obj, 'kind')) errors.push('background.kind:missing')
  else checkEnum(errors, 'background.kind', obj['kind'], BACKGROUNDS)
  if (!hasKey(obj, 'tint')) errors.push('background.tint:missing')
  else {
    const tint = obj['tint']
    if (tint !== 'none' && (typeof tint !== 'string' || !(COLOR_TOKENS as readonly string[]).includes(tint))) {
      errors.push('background.tint:not-allowed')
    }
  }
}

export function parseHex(s: unknown): readonly [number, number, number] | null {
  if (typeof s !== 'string' || s.length !== 7 || s.charAt(0) !== '#') return null
  for (let i = 1; i < 7; i++) {
    if (!HEX_DIGITS.includes(s.charAt(i))) return null
  }
  const rgb: readonly [number, number, number] = [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]
  return Object.freeze(rgb)
}

function channelLuminance(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function contrastRatio(fg: string, bg: string): number {
  const f = parseHex(fg)
  const b = parseHex(bg)
  if (f === null || b === null) return 0
  const [fr, fg2, fb] = f
  const [br, bg2, bb] = b
  const lf = 0.2126 * channelLuminance(fr) + 0.7152 * channelLuminance(fg2) + 0.0722 * channelLuminance(fb)
  const lb = 0.2126 * channelLuminance(br) + 0.7152 * channelLuminance(bg2) + 0.0722 * channelLuminance(bb)
  const hi = Math.max(lf, lb)
  const lo = Math.min(lf, lb)
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

export function parseTheme(input: unknown): ThemeParseResult {
  if (!isPlainObject(input)) return fail(['?:type'])
  const errors: string[] = []
  const warnings: string[] = []
  unknownKeyErrors(input, TOP_KEYS, '', errors)

  if (!hasKey(input, 'schema')) errors.push('schema:missing')
  else if (input['schema'] !== THEME_SCHEMA) errors.push('schema:not-allowed')

  if (!hasKey(input, 'id')) errors.push('id:missing')
  else if (typeof input['id'] !== 'string') errors.push('id:type')
  else if (!ID_PATTERN.test(input['id'])) errors.push('id:not-allowed')

  if (!hasKey(input, 'name')) errors.push('name:missing')
  else checkLangRecord(errors, 'name', input['name'], 24)

  if (!hasKey(input, 'creator')) errors.push('creator:missing')
  else checkText(errors, 'creator', input['creator'], 24, false)

  if (!hasKey(input, 'description')) errors.push('description:missing')
  else checkLangRecord(errors, 'description', input['description'], 80)

  if (!hasKey(input, 'copyright')) errors.push('copyright:missing')
  else checkText(errors, 'copyright', input['copyright'], 40, true)

  if (!hasKey(input, 'scheme')) errors.push('scheme:missing')
  else checkEnum(errors, 'scheme', input['scheme'], ['light', 'dark'])

  const validColors = checkColors(errors, input)
  checkTerminal(errors, input)
  checkShape(errors, input)
  checkSpacing(errors, input)
  checkWeight(errors, input)
  checkIcons(errors, input)
  checkBackground(errors, input)

  if (!hasKey(input, 'emptyArt')) errors.push('emptyArt:missing')
  else checkEnum(errors, 'emptyArt', input['emptyArt'], EMPTY_ARTS)

  for (const [fgToken, bgToken] of CONTRAST_PAIRS) {
    const fg = validColors[fgToken]
    let bg = validColors[bgToken]
    if (fg === undefined || bg === undefined) continue
    if (bg === 'none') bg = validColors['page']
    if (bg === undefined || bg === 'none') continue
    if (contrastRatio(fg, bg) < 4.5) errors.push('colors.' + fgToken + ':contrast')
  }
  const dimVal = validColors['dim']
  const pageVal = validColors['page']
  if (dimVal !== undefined && pageVal !== undefined && contrastRatio(dimVal, pageVal) < 3) {
    warnings.push('colors.dim:low-contrast')
  }

  if (errors.length > 0) return fail(errors)

  const nameObj = input['name'] as Record<string, unknown>
  const descObj = input['description'] as Record<string, unknown>
  const termObj = input['terminal'] as Record<string, unknown>
  const shapeObj = input['shape'] as Record<string, unknown>
  const spacingObj = input['spacing'] as Record<string, unknown>
  const weightObj = input['weight'] as Record<string, unknown>
  const iconsObj = input['icons'] as Record<string, unknown>
  const bgObj = input['background'] as Record<string, unknown>

  const colors = {} as Record<ColorToken, string>
  for (const token of COLOR_TOKENS) colors[token] = validColors[token] as string
  const terminal = {} as Record<TerminalRole, TerminalKey>
  for (const role of TERMINAL_ROLES) terminal[role] = termObj[role] as TerminalKey

  const theme: Theme = {
    schema: THEME_SCHEMA,
    id: input['id'] as string,
    name: { en: nameObj['en'] as string, 'zh-TW': nameObj['zh-TW'] as string },
    creator: input['creator'] as string,
    description: { en: descObj['en'] as string, 'zh-TW': descObj['zh-TW'] as string },
    copyright: input['copyright'] as string,
    scheme: input['scheme'] as Theme['scheme'],
    colors,
    terminal,
    shape: {
      border: shapeObj['border'] as BorderStyle,
      bubble: shapeObj['bubble'] as BubbleShape,
      avatarFrame: shapeObj['avatarFrame'] as AvatarFrame,
      avatarRing: shapeObj['avatarRing'] as 0 | 1 | 2,
    },
    spacing: { density: spacingObj['density'] as Density },
    weight: { title: weightObj['title'] as 'normal' | 'bold', names: weightObj['names'] as 'normal' | 'bold' },
    icons: {
      set: 'lucide',
      stroke: iconsObj['stroke'] as (typeof ICON_STROKES)[number],
      size: iconsObj['size'] as (typeof ICON_SIZES)[number],
    },
    background: { kind: bgObj['kind'] as BackgroundKind, tint: bgObj['tint'] as 'none' | ColorToken },
    emptyArt: input['emptyArt'] as EmptyArt,
  }
  freezeDeep(theme)
  return Object.freeze({ ok: true as const, theme, warnings: Object.freeze(warnings) })
}

export function parseThemeText(text: unknown): ThemeParseResult {
  if (typeof text !== 'string' || text.length > THEME_FILE_MAX_CHARS) return fail(['file:size'])
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return fail(['file:json'])
  }
  return parseTheme(parsed)
}
