import { contrastRatio, parseHex, parseTheme } from './chat-theme'
import type { AvatarFrame, BackgroundKind, ColorToken, EmptyArt, Theme } from './chat-theme'

export type Surface = 'desktop' | 'mobile' | 'terminal'
/** svg：這個介面有 Svg 元件；pattern：背景圖樣（點、線、紋理）已在真面板驗證過可以畫。預設兩個都由呼叫端傳，函式不猜 */
export type SurfaceCaps = Readonly<{ svg: boolean; pattern: boolean }>
export type ResolvedTheme = Readonly<{
  id: string
  surface: Surface
  /** 沒有的鍵＝「不設定，用介面預設」。桌面／手機的值是 '#rrggbb'；終端機的值是 TerminalKey（絕不是 hex） */
  colors: Readonly<Partial<Record<ColorToken, string>>>
  /** 'none' 換成 undefined；其餘原樣（Box 的 borderStyle 是字串） */
  borderStyle: string | undefined
  /** 氣泡形狀：面板沒有圓角，pill 一律降成 round */
  bubble: 'round' | 'square'
  /** 列與列之間空幾格、左右內距幾格 */
  rowGap: 0 | 1
  padX: 0 | 1 | 2
  isTitleBold: boolean
  isNameBold: boolean
  /** 圖示的線粗與大小；終端機或沒有 Svg 時 null */
  icon: Readonly<{ stroke: number; size: number }> | null
  /** 頭像框形狀；終端機或沒有 Svg 時 null（外圈也是 0） */
  avatarFrame: 'circle' | 'rounded' | 'square' | null
  avatarRing: 0 | 1 | 2
  background: 'solid' | 'dots' | 'lines' | 'grain'
  /** 背景圖樣的顏色（'#rrggbb'）；只有 background 不是 solid 且 tint 不是 none 時才有 */
  backgroundTint: string | undefined
  emptyArt: 'none' | 'bubbles' | 'plant' | 'moon' | 'sparkle'
  /** 降級紀錄，代碼固定，見規格 4 */
  degraded: readonly string[]
}>

/** 終端機要放進結果的顏色鍵與來源：'literal-text' 是固定用 'text' 這個鍵，其餘是 theme.terminal 的角色名 */
export const TERMINAL_COLOR_MAP: readonly (readonly [ColorToken, 'literal-text' | keyof Theme['terminal']])[] = [
  ['text', 'literal-text'],
  ['dim', 'dim'],
  ['line', 'border'],
  ['acc', 'accent'],
  ['mine', 'mine'],
  ['theirs', 'theirs'],
  ['ok', 'ok'],
  ['warn', 'warn'],
  ['off', 'off'],
  ['selbar', 'accent'],
]

export function fallbackResolved(surface: Surface): ResolvedTheme {
  const out: ResolvedTheme = {
    id: 'fallback',
    surface,
    colors: Object.freeze({}),
    borderStyle: 'round',
    bubble: 'round',
    rowGap: 1,
    padX: 1,
    isTitleBold: false,
    isNameBold: false,
    icon: null,
    avatarFrame: null,
    avatarRing: 0,
    background: 'solid',
    backgroundTint: undefined,
    emptyArt: 'none',
    degraded: Object.freeze(['fallback']),
  }
  return Object.freeze(out)
}

export function resolveTheme(theme: Theme, surface: Surface, caps: SurfaceCaps): ResolvedTheme {
  const checked = parseTheme(theme)
  if (!checked.ok) return fallbackResolved(surface)
  const t = checked.theme
  const isTerminal = surface === 'terminal'
  const capsObj: SurfaceCaps = caps !== null && typeof caps === 'object' ? caps : { svg: false, pattern: false }
  const hasSvg = !isTerminal && capsObj.svg === true
  const hasPattern = !isTerminal && capsObj.pattern === true

  const degraded: string[] = []
  const colors: Partial<Record<ColorToken, string>> = {}
  if (isTerminal) {
    degraded.push('colors:terminal-keys')
    for (const [token, role] of TERMINAL_COLOR_MAP) {
      colors[token] = role === 'literal-text' ? 'text' : t.terminal[role]
    }
  } else {
    for (const token of Object.keys(t.colors) as ColorToken[]) {
      const v = t.colors[token]
      if (v !== 'none') colors[token] = v
    }
  }

  let bubble: 'round' | 'square' = 'round'
  if (t.shape.bubble === 'pill') degraded.push('bubble:pill-to-round')
  else bubble = t.shape.bubble

  const density = t.spacing.density
  const rowGap: 0 | 1 = density === 'tight' ? 0 : 1
  let padX: 0 | 1 | 2 = density === 'airy' ? 2 : 1
  if (isTerminal && padX === 2) {
    padX = 1
    degraded.push('spacing:terminal-pad')
  }

  let icon: ResolvedTheme['icon'] = null
  if (isTerminal) degraded.push('icons:terminal')
  else if (!hasSvg) degraded.push('icons:no-svg')
  else icon = Object.freeze({ stroke: t.icons.stroke, size: t.icons.size })

  let avatarFrame: AvatarFrame | null = null
  let avatarRing: 0 | 1 | 2 = 0
  if (isTerminal) degraded.push('avatarFrame:terminal')
  else if (!hasSvg) degraded.push('avatarFrame:no-svg')
  else {
    avatarFrame = t.shape.avatarFrame
    avatarRing = t.shape.avatarRing
  }

  let background: BackgroundKind = 'solid'
  let backgroundTint: string | undefined = undefined
  if (t.background.kind !== 'solid') {
    if (isTerminal) degraded.push('background:terminal')
    else if (!hasPattern) degraded.push('background:no-pattern')
  }
  if (!isTerminal && hasPattern) {
    background = t.background.kind
    const tint = t.background.tint
    if (background !== 'solid' && tint !== 'none') {
      const tintVal = t.colors[tint]
      if (tintVal !== 'none') backgroundTint = tintVal
    }
  }

  let emptyArt: EmptyArt = 'none'
  if (t.emptyArt !== 'none') {
    if (isTerminal) degraded.push('emptyArt:terminal')
    else if (!hasSvg) degraded.push('emptyArt:no-svg')
  }
  if (!isTerminal && hasSvg) emptyArt = t.emptyArt

  const out: ResolvedTheme = {
    id: t.id,
    surface,
    colors: Object.freeze(colors),
    borderStyle: t.shape.border === 'none' ? undefined : t.shape.border,
    bubble,
    rowGap,
    padX,
    isTitleBold: t.weight.title === 'bold',
    isNameBold: t.weight.names === 'bold',
    icon,
    avatarFrame,
    avatarRing,
    background,
    backgroundTint,
    emptyArt,
    degraded: Object.freeze(degraded),
  }
  return Object.freeze(out)
}

export function withAccent(theme: Theme, accentHex: string): Theme | null {
  if (parseHex(accentHex) === null) return null
  const checked = parseTheme(theme)
  if (!checked.ok) return null
  const base = checked.theme
  const fg = contrastRatio('#000000', accentHex) > contrastRatio('#ffffff', accentHex) ? '#000000' : '#ffffff'
  const colors: Record<ColorToken, string> = { ...base.colors }
  colors.acc = accentHex
  colors.mine = accentHex
  colors.grp = accentHex
  if (base.colors.selbar !== 'none') colors.selbar = accentHex
  const badgeChanged = base.colors.badgeBg !== 'none'
  if (badgeChanged) colors.badgeBg = accentHex
  colors.onacc = fg
  colors.minetext = fg
  colors.grptx = fg
  if (badgeChanged) colors.badgeTx = fg
  const out = parseTheme({ ...base, colors })
  return out.ok ? out.theme : null
}
