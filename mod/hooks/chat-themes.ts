import { parseTheme } from './chat-theme'
import type { Theme } from './chat-theme'

export const DEFAULT_THEME_ID = 's3-warm-notebook'

/** 五份內建主題的原始資料（還沒檢查過的普通物件）；順序 S1..S5 */
export const BUILTIN_THEME_FILES: readonly unknown[] = [
  {
    schema: 1,
    id: 's1-quiet-docs',
    name: { en: 'Quiet docs', 'zh-TW': '安靜文件感' },
    creator: 'with-friends',
    description: { en: 'Plain text feel, thin lines, almost no color.', 'zh-TW': '像 README 的等寬文字，細線方框，幾乎沒有顏色。' },
    copyright: '',
    scheme: 'light',
    colors: {
      page: '#fdfcfc', side: '#f8f7f7', panel: '#fdfcfc', text: '#201d1d', dim: '#6e6e73', line: '#dcd9d9',
      acc: '#201d1d', onacc: '#fdfcfc', mine: '#201d1d', minetext: '#fdfcfc', theirs: '#fdfcfc', theirstext: '#201d1d',
      theirsline: '#dcd9d9', ok: '#30d158', warn: '#ff9f0a', off: '#9a9898', sel: '#f1eeee', selbar: '#201d1d',
      badgeBg: 'none', badgeTx: '#201d1d', ring: '#fdfcfc', grp: '#f1eeee', grptx: '#201d1d',
    },
    terminal: { mine: 'text', theirs: 'subtle', accent: 'text', ok: 'success', warn: 'warning', off: 'inactive', border: 'inactive', dim: 'subtle' },
    shape: { border: 'single', bubble: 'square', avatarFrame: 'square', avatarRing: 0 },
    spacing: { density: 'airy' },
    weight: { title: 'normal', names: 'normal' },
    icons: { set: 'lucide', stroke: 1.5, size: 16 },
    background: { kind: 'solid', tint: 'none' },
    emptyArt: 'none',
  },
  {
    schema: 1,
    id: 's2-dark-player',
    name: { en: 'Dark player', 'zh-TW': '深色音樂播放器' },
    creator: 'with-friends',
    description: { en: 'Near-black with one green accent and pill shapes.', 'zh-TW': '近黑底、單一綠色、藥丸形狀。' },
    copyright: '',
    scheme: 'dark',
    colors: {
      page: '#121212', side: '#000000', panel: '#181818', text: '#ffffff', dim: '#b3b3b3', line: '#2a2a2a',
      acc: '#1ed760', onacc: '#000000', mine: '#1ed760', minetext: '#000000', theirs: '#2a2a2a', theirstext: '#ffffff',
      theirsline: 'none', ok: '#1ed760', warn: '#ffa42b', off: '#7c7c7c', sel: '#2a2a2a', selbar: 'none',
      badgeBg: '#1ed760', badgeTx: '#000000', ring: '#000000', grp: '#1ed760', grptx: '#000000',
    },
    terminal: { mine: 'success', theirs: 'subtle', accent: 'success', ok: 'success', warn: 'warning', off: 'inactive', border: 'inactive', dim: 'subtle' },
    shape: { border: 'round', bubble: 'pill', avatarFrame: 'circle', avatarRing: 1 },
    spacing: { density: 'tight' },
    weight: { title: 'bold', names: 'bold' },
    icons: { set: 'lucide', stroke: 2, size: 18 },
    background: { kind: 'solid', tint: 'none' },
    emptyArt: 'sparkle',
  },
  {
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
  },
  {
    schema: 1,
    id: 's4-bright-bold',
    name: { en: 'Bright bold', 'zh-TW': '明亮粗黑體' },
    creator: 'with-friends',
    description: { en: 'White with lime green and heavy, loud titles.', 'zh-TW': '白底萊姆綠，標題超粗。' },
    copyright: '',
    scheme: 'light',
    colors: {
      page: '#ffffff', side: '#ffffff', panel: '#ffffff', text: '#0e0f0c', dim: '#5d5f5b', line: '#e8ebe6',
      acc: '#9fe870', onacc: '#0e0f0c', mine: '#9fe870', minetext: '#0e0f0c', theirs: '#e8ebe6', theirstext: '#0e0f0c',
      theirsline: 'none', ok: '#2ead4b', warn: '#ffd11a', off: '#9a9c98', sel: '#e2f6d5', selbar: 'none',
      badgeBg: '#0e0f0c', badgeTx: '#9fe870', ring: '#ffffff', grp: '#0e0f0c', grptx: '#9fe870',
    },
    terminal: { mine: 'success', theirs: 'text', accent: 'success', ok: 'success', warn: 'warning', off: 'inactive', border: 'inactive', dim: 'subtle' },
    shape: { border: 'round', bubble: 'round', avatarFrame: 'rounded', avatarRing: 2 },
    spacing: { density: 'normal' },
    weight: { title: 'bold', names: 'bold' },
    icons: { set: 'lucide', stroke: 2.5, size: 18 },
    background: { kind: 'solid', tint: 'none' },
    emptyArt: 'bubbles',
  },
  {
    schema: 1,
    id: 's5-midnight-play',
    name: { en: 'Midnight play', 'zh-TW': '午夜紫遊戲感' },
    creator: 'with-friends',
    description: { en: 'Deep purple night with neon lime and pink.', 'zh-TW': '深紫夜色配螢光萊姆與粉紅。' },
    copyright: '',
    scheme: 'dark',
    colors: {
      page: '#1f1633', side: '#150f23', panel: '#1f1633', text: '#ffffff', dim: '#bdb8c0', line: '#362d59',
      acc: '#c2ef4e', onacc: '#150f23', mine: '#6a5fc1', minetext: '#ffffff', theirs: '#2b2147', theirstext: '#ffffff',
      theirsline: '#362d59', ok: '#c2ef4e', warn: '#fa7faa', off: '#7f7790', sel: '#2f2550', selbar: '#c2ef4e',
      badgeBg: '#fa7faa', badgeTx: '#150f23', ring: '#150f23', grp: '#6a5fc1', grptx: '#ffffff',
    },
    terminal: { mine: 'permission', theirs: 'subtle', accent: 'permission', ok: 'success', warn: 'warning', off: 'inactive', border: 'promptBorder', dim: 'subtle' },
    shape: { border: 'round', bubble: 'round', avatarFrame: 'rounded', avatarRing: 1 },
    spacing: { density: 'normal' },
    weight: { title: 'bold', names: 'normal' },
    icons: { set: 'lucide', stroke: 2, size: 16 },
    background: { kind: 'dots', tint: 'line' },
    emptyArt: 'moon',
  },
]

export function builtinThemes(): readonly Theme[] {
  const out: Theme[] = []
  for (const f of BUILTIN_THEME_FILES) {
    const r = parseTheme(f)
    if (r.ok) out.push(r.theme)
  }
  return Object.freeze(out)
}

export function themeById(id: unknown): Theme | undefined {
  if (typeof id !== 'string') return undefined
  for (const t of builtinThemes()) {
    if (t.id === id) return t
  }
  return undefined
}

export function themeOrDefault(id: unknown): Theme {
  const hit = themeById(id)
  if (hit !== undefined) return hit
  const fallback = themeById(DEFAULT_THEME_ID)
  if (fallback === undefined) throw new Error('no default theme')
  return fallback
}
