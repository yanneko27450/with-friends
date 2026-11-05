import { expect, test } from 'claude-code/testing'
import { parseTheme } from '../hooks/chat-theme'
import type { Theme } from '../hooks/chat-theme'
import { TERMINAL_COLOR_MAP, fallbackResolved, resolveTheme, withAccent } from '../hooks/chat-theme-resolve'

const S3_SAMPLE = {
  schema: 1,
  id: 's3-warm-notebook',
  name: { en: 'Warm notebook', 'zh-TW': '溫暖手帳' },
  creator: 'with-friends',
  description: { en: 'Cream paper, charcoal text, soft and roomy.', 'zh-TW': '奶油紙色加炭黑字，圓潤、留白多。' },
  copyright: '',
  scheme: 'light',
  colors: {
    page: '#f7f4ed', side: '#f7f4ed', panel: '#fcfbf8', text: '#1c1c1c', dim: '#5f5f5d', line: '#eceae4',
    acc: '#1c1c1c', onacc: '#fcfbf8', mine: '#1c1c1c', minetext: '#fcfbf8', theirs: '#f7f4ed', theirstext: '#1c1c1c',
    theirsline: '#eceae4', ok: '#3f9a5f', warn: '#c98a1b', off: '#a8a59e', sel: '#eae7e0', selbar: 'none',
    badgeBg: '#1c1c1c', badgeTx: '#fcfbf8', ring: '#f7f4ed', grp: '#1c1c1c', grptx: '#fcfbf8',
  },
  terminal: { mine: 'text', theirs: 'subtle', accent: 'claude', ok: 'success', warn: 'warning', off: 'inactive', border: 'inactive', dim: 'subtle' },
  shape: { border: 'round', bubble: 'round', avatarFrame: 'circle', avatarRing: 1 },
  spacing: { density: 'airy' },
  weight: { title: 'bold', names: 'normal' },
  icons: { set: 'lucide', stroke: 2, size: 16 },
  background: { kind: 'solid', tint: 'none' },
  emptyArt: 'plant',
}

function withoutKey(obj: any, key: string): any {
  const out: any = {}
  for (const k of Object.keys(obj)) {
    if (k !== key) out[k] = obj[k]
  }
  return out
}

function s3Theme(mutate?: (c: any) => void): Theme {
  const c = JSON.parse(JSON.stringify(S3_SAMPLE))
  if (mutate) mutate(c)
  const r = parseTheme(c)
  if (!r.ok) throw new Error('S3 variant should parse: ' + r.errors.join(','))
  return r.theme
}

test('TERMINAL_COLOR_MAP 是規格那 10 列、照順序', async () => {
  expect(TERMINAL_COLOR_MAP).toHaveLength(10)
  expect(TERMINAL_COLOR_MAP[0]).toEqual(['text', 'literal-text'])
  expect(TERMINAL_COLOR_MAP.map(([token, role]) => token + '>' + role)).toEqual([
    'text>literal-text', 'dim>dim', 'line>border', 'acc>accent', 'mine>mine', 'theirs>theirs', 'ok>ok', 'warn>warn', 'off>off', 'selbar>accent',
  ])
})

test('S3 × desktop（svg 有、pattern 沒開）：原色直通、沒有降級', async () => {
  const r = resolveTheme(s3Theme(), 'desktop', { svg: true, pattern: false })
  expect(r.id).toBe('s3-warm-notebook')
  expect(r.surface).toBe('desktop')
  expect(r.colors.page).toBe('#f7f4ed')
  expect(r.colors.acc).toBe('#1c1c1c')
  expect(Object.keys(r.colors)).not.toContain('selbar')
  expect(r.borderStyle).toBe('round')
  expect(r.bubble).toBe('round')
  expect(r.rowGap).toBe(1)
  expect(r.padX).toBe(2)
  expect(r.isTitleBold).toBe(true)
  expect(r.isNameBold).toBe(false)
  expect(r.icon).toEqual({ stroke: 2, size: 16 })
  expect(r.avatarFrame).toBe('circle')
  expect(r.avatarRing).toBe(1)
  expect(r.background).toBe('solid')
  expect(r.backgroundTint).toBe(undefined)
  expect(r.emptyArt).toBe('plant')
  expect(r.degraded).toEqual([])
})

test("桌面版：值是 'none' 的顏色不放進結果", async () => {
  const theme = s3Theme(c => {
    c.colors.line = 'none'
    c.colors.ok = 'none'
  })
  const r = resolveTheme(theme, 'mobile', { svg: true, pattern: true })
  expect(Object.keys(r.colors)).not.toContain('line')
  expect(Object.keys(r.colors)).not.toContain('ok')
  expect(r.colors.page).toBe('#f7f4ed')
})

test('S3 × terminal：只有顏色鍵、padX 壓成 1、降級照固定順序', async () => {
  const r = resolveTheme(s3Theme(), 'terminal', { svg: true, pattern: true })
  expect(r.colors.text).toBe('text')
  expect(r.colors.mine).toBe('text')
  expect(r.colors.acc).toBe('claude')
  expect(r.colors.line).toBe('inactive')
  expect(r.colors.dim).toBe('subtle')
  expect(r.colors.selbar).toBe('claude')
  expect(Object.keys(r.colors)).not.toContain('page')
  expect(Object.keys(r.colors)).not.toContain('panel')
  expect(Object.values(r.colors).every(v => typeof v === 'string' && !v.startsWith('#'))).toBe(true)
  expect(r.padX).toBe(1)
  expect(r.rowGap).toBe(1)
  expect(r.icon).toBe(null)
  expect(r.avatarFrame).toBe(null)
  expect(r.avatarRing).toBe(0)
  expect(r.background).toBe('solid')
  expect(r.emptyArt).toBe('none')
  expect(r.degraded).toEqual(['colors:terminal-keys', 'spacing:terminal-pad', 'icons:terminal', 'avatarFrame:terminal', 'emptyArt:terminal'])
})

test('S3 × mobile × 沒有 Svg：圖示、頭像框、插圖降級', async () => {
  const r = resolveTheme(s3Theme(), 'mobile', { svg: false, pattern: false })
  expect(r.degraded).toEqual(['icons:no-svg', 'avatarFrame:no-svg', 'emptyArt:no-svg'])
  expect(r.icon).toBe(null)
  expect(r.avatarFrame).toBe(null)
  expect(r.avatarRing).toBe(0)
  expect(r.emptyArt).toBe('none')
  expect(r.padX).toBe(2)
  expect(r.colors.page).toBe('#f7f4ed')
})

test('pill 降成 round 並記錄；背景圖樣照 pattern 開關', async () => {
  const theme = s3Theme(c => {
    c.shape.bubble = 'pill'
    c.background = { kind: 'dots', tint: 'line' }
  })
  const withPattern = resolveTheme(theme, 'desktop', { svg: true, pattern: true })
  expect(withPattern.bubble).toBe('round')
  expect(withPattern.background).toBe('dots')
  expect(withPattern.backgroundTint).toBe('#eceae4')
  expect(withPattern.degraded).toEqual(['bubble:pill-to-round'])
  const noPattern = resolveTheme(theme, 'desktop', { svg: true, pattern: false })
  expect(noPattern.background).toBe('solid')
  expect(noPattern.backgroundTint).toBe(undefined)
  expect(noPattern.degraded).toEqual(['bubble:pill-to-round', 'background:no-pattern'])
  const term = resolveTheme(theme, 'terminal', { svg: true, pattern: true })
  expect(term.background).toBe('solid')
  expect(term.degraded).toEqual([
    'colors:terminal-keys', 'bubble:pill-to-round', 'spacing:terminal-pad', 'icons:terminal',
    'avatarFrame:terminal', 'background:terminal', 'emptyArt:terminal',
  ])
})

test("背景 tint 指到的顏色是 'none' 時 backgroundTint 不給", async () => {
  const theme = s3Theme(c => {
    c.colors.line = 'none'
    c.background = { kind: 'lines', tint: 'line' }
  })
  const r = resolveTheme(theme, 'desktop', { svg: true, pattern: true })
  expect(r.background).toBe('lines')
  expect(r.backgroundTint).toBe(undefined)
})

test("border 'none' 換成 undefined；square 氣泡原樣", async () => {
  const theme = s3Theme(c => {
    c.shape.border = 'none'
    c.shape.bubble = 'square'
  })
  const r = resolveTheme(theme, 'desktop', { svg: true, pattern: true })
  expect(r.borderStyle).toBe(undefined)
  expect(r.bubble).toBe('square')
  expect(r.degraded).toEqual([])
})

test('疏密換算：tight 是 rowGap 0、padX 1；終端機 tight 不記 spacing 降級', async () => {
  const theme = s3Theme(c => { c.spacing.density = 'tight' })
  const desk = resolveTheme(theme, 'desktop', { svg: true, pattern: true })
  expect(desk.rowGap).toBe(0)
  expect(desk.padX).toBe(1)
  const term = resolveTheme(theme, 'terminal', { svg: false, pattern: false })
  expect(term.padX).toBe(1)
  expect(term.degraded).not.toContain('spacing:terminal-pad')
})

test('emptyArt 本來就是 none 時，終端機不記 emptyArt 降級', async () => {
  const theme = s3Theme(c => { c.emptyArt = 'none' })
  const r = resolveTheme(theme, 'terminal', { svg: true, pattern: true })
  expect(r.emptyArt).toBe('none')
  expect(r.degraded).not.toContain('emptyArt:terminal')
})

test('fallbackResolved 的固定內容', async () => {
  const f = fallbackResolved('terminal')
  expect(f.id).toBe('fallback')
  expect(f.surface).toBe('terminal')
  expect(f.colors).toEqual({})
  expect(f.borderStyle).toBe('round')
  expect(f.bubble).toBe('round')
  expect(f.rowGap).toBe(1)
  expect(f.padX).toBe(1)
  expect(f.isTitleBold).toBe(false)
  expect(f.isNameBold).toBe(false)
  expect(f.icon).toBe(null)
  expect(f.avatarFrame).toBe(null)
  expect(f.avatarRing).toBe(0)
  expect(f.background).toBe('solid')
  expect(f.backgroundTint).toBe(undefined)
  expect(f.emptyArt).toBe('none')
  expect(f.degraded).toEqual(['fallback'])
  expect(Object.isFrozen(f)).toBe(true)
})

test('傳進壞主題回 fallback、不丟例外', async () => {
  const caps = { svg: true, pattern: true }
  expect(resolveTheme({} as any, 'desktop', caps)).toEqual(fallbackResolved('desktop'))
  expect(resolveTheme(null as any, 'mobile', caps)).toEqual(fallbackResolved('mobile'))
  expect(resolveTheme('nope' as any, 'terminal', caps)).toEqual(fallbackResolved('terminal'))
  const missing = JSON.parse(JSON.stringify(S3_SAMPLE))
  missing.colors = withoutKey(missing.colors, 'page')
  expect(resolveTheme(missing as any, 'desktop', caps)).toEqual(fallbackResolved('desktop'))
  const extra = JSON.parse(JSON.stringify(S3_SAMPLE))
  extra.colors.bogus = '#000000'
  expect(resolveTheme(extra as any, 'desktop', caps).id).toBe('fallback')
})

test('resolveTheme 回傳深凍結；同樣輸入同樣輸出', async () => {
  const theme = s3Theme()
  const a = resolveTheme(theme, 'desktop', { svg: true, pattern: false })
  const b = resolveTheme(theme, 'desktop', { svg: true, pattern: false })
  expect(a).toEqual(b)
  expect(Object.isFrozen(a)).toBe(true)
  expect(Object.isFrozen(a.colors)).toBe(true)
  expect(Object.isFrozen(a.degraded)).toBe(true)
  expect(Object.isFrozen(a.icon)).toBe(true)
})

test('withAccent 手算例：紅用黑字、藍用白字、中灰用黑字', async () => {
  const theme = s3Theme()
  const red = withAccent(theme, '#ff0000')
  if (red === null) throw new Error('red accent should work')
  expect(red.colors.acc).toBe('#ff0000')
  expect(red.colors.mine).toBe('#ff0000')
  expect(red.colors.grp).toBe('#ff0000')
  expect(red.colors.minetext).toBe('#000000')
  expect(red.colors.onacc).toBe('#000000')
  expect(red.colors.grptx).toBe('#000000')
  const blue = withAccent(theme, '#0000ff')
  if (blue === null) throw new Error('blue accent should work')
  expect(blue.colors.minetext).toBe('#ffffff')
  const gray = withAccent(theme, '#777777')
  if (gray === null) throw new Error('gray accent should work')
  expect(gray.colors.minetext).toBe('#000000')
})

test("withAccent：selbar 與 badgeBg 原本是 'none' 就不動，badgeTx 跟著不動", async () => {
  const theme = s3Theme(c => {
    c.colors.badgeBg = 'none'
    c.colors.badgeTx = '#1c1c1c'
  })
  const out = withAccent(theme, '#ff0000')
  if (out === null) throw new Error('accent should work')
  expect(out.colors.selbar).toBe('none')
  expect(out.colors.badgeBg).toBe('none')
  expect(out.colors.badgeTx).toBe('#1c1c1c')
  const theme2 = s3Theme()
  const out2 = withAccent(theme2, '#ff0000')
  if (out2 === null) throw new Error('accent should work')
  expect(out2.colors.badgeBg).toBe('#ff0000')
  expect(out2.colors.badgeTx).toBe('#000000')
})

test('withAccent 不合法的顏色回 null', async () => {
  const theme = s3Theme()
  expect(withAccent(theme, '#FF0000')).toBe(null)
  expect(withAccent(theme, 'red')).toBe(null)
  expect(withAccent(theme, '')).toBe(null)
  expect(withAccent(theme, null as any)).toBe(null)
  expect(withAccent(theme, 'x'.repeat(100000))).toBe(null)
})

test('withAccent 不改原主題、結果通過 parseTheme、id 不變', async () => {
  const theme = s3Theme()
  const out = withAccent(theme, '#00ff00')
  if (out === null) throw new Error('accent should work')
  expect(theme.colors.acc).toBe('#1c1c1c')
  expect(theme.colors.mine).toBe('#1c1c1c')
  expect(out.id).toBe('s3-warm-notebook')
  expect(out.name).toEqual(theme.name)
  expect(parseTheme(out).ok).toBe(true)
  expect(Object.isFrozen(out)).toBe(true)
  expect(Object.isFrozen(out.colors)).toBe(true)
})

test('withAccent 傳進壞主題回 null、不丟例外', async () => {
  expect(withAccent({} as any, '#ff0000')).toBe(null)
  expect(withAccent(null as any, '#ff0000')).toBe(null)
})
