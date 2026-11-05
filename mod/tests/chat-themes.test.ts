import { expect, test } from 'claude-code/testing'
import { COLOR_TOKENS, TERMINAL_KEYS, contrastRatio, parseTheme } from '../hooks/chat-theme'
import type { Theme } from '../hooks/chat-theme'
import { BUILTIN_THEME_FILES, DEFAULT_THEME_ID, builtinThemes, themeById, themeOrDefault } from '../hooks/chat-themes'

const IDS = ['s1-quiet-docs', 's2-dark-player', 's3-warm-notebook', 's4-bright-bold', 's5-midnight-play']

test('builtinThemes 長度 5、順序 S1..S5', async () => {
  const themes = builtinThemes()
  expect(themes).toHaveLength(5)
  expect(themes.map(t => t.id)).toEqual(IDS)
})

test('五份原始資料各自 parseTheme 成功且沒有警告', async () => {
  expect(BUILTIN_THEME_FILES).toHaveLength(5)
  BUILTIN_THEME_FILES.forEach((f, i) => {
    const r = parseTheme(f)
    if (!r.ok) throw new Error('S' + (i + 1) + ' should parse: ' + r.errors.join(','))
    if (r.warnings.length !== 0) throw new Error('S' + (i + 1) + ' warnings: ' + r.warnings.join(','))
  })
})

test('id 五個互不相同，DEFAULT_THEME_ID 在清單裡', async () => {
  const ids = builtinThemes().map(t => t.id)
  expect([...new Set(ids)]).toHaveLength(5)
  expect(DEFAULT_THEME_ID).toBe('s3-warm-notebook')
  expect(ids).toContain(DEFAULT_THEME_ID)
})

test('scheme 有深有淺：S2、S5 是 dark，其餘 light', async () => {
  const themes = builtinThemes()
  expect(themes.map(t => t.scheme)).toEqual(['light', 'dark', 'light', 'light', 'dark'])
})

test('每套抽查顏色與其他欄位', async () => {
  const [s1, s2, s3, s4, s5] = builtinThemes() as unknown as [Theme, Theme, Theme, Theme, Theme]
  expect(s1.colors.line).toBe('#dcd9d9')
  expect(s1.colors.page).toBe('#fdfcfc')
  expect(s1.shape.border).toBe('single')
  expect(s1.shape.bubble).toBe('square')
  expect(s1.emptyArt).toBe('none')
  expect(s2.colors.acc).toBe('#1ed760')
  expect(s2.colors.selbar).toBe('none')
  expect(s2.shape.bubble).toBe('pill')
  expect(s2.emptyArt).toBe('sparkle')
  expect(s2.icons.size).toBe(18)
  expect(s3.colors.sel).toBe('#eae7e0')
  expect(s3.colors.mine).toBe('#1c1c1c')
  expect(s3.terminal.accent).toBe('claude')
  expect(s3.spacing.density).toBe('airy')
  expect(s4.colors.badgeTx).toBe('#9fe870')
  expect(s4.colors.acc).toBe('#9fe870')
  expect(s4.shape.avatarRing).toBe(2)
  expect(s4.icons.stroke).toBe(2.5)
  expect(s5.colors.mine).toBe('#6a5fc1')
  expect(s5.colors.warn).toBe('#fa7faa')
  expect(s5.background.kind).toBe('dots')
  expect(s5.background.tint).toBe('line')
  expect(s5.emptyArt).toBe('moon')
  expect(s5.terminal.border).toBe('promptBorder')
})

test('五套都滿足對比規則（測試裡用 contrastRatio 再算一次）', async () => {
  const pairs: [string, string][] = [
    ['text', 'page'], ['text', 'panel'], ['text', 'side'], ['minetext', 'mine'],
    ['theirstext', 'theirs'], ['onacc', 'acc'], ['badgeTx', 'badgeBg'], ['grptx', 'grp'],
  ]
  for (const t of builtinThemes()) {
    const colors = t.colors as Record<string, string>
    for (const [fg, bg] of pairs) {
      const bgVal = colors[bg] === 'none' ? colors['page']! : colors[bg]!
      const ratio = contrastRatio(colors[fg]!, bgVal)
      if (ratio < 4.5) throw new Error(t.id + ' ' + fg + '/' + bg + ' = ' + ratio)
    }
    const dimRatio = contrastRatio(colors['dim']!, colors['page']!)
    if (dimRatio < 3) throw new Error(t.id + ' dim/page = ' + dimRatio)
  }
})

test('名稱與說明不含品牌名', async () => {
  const brands = ['spotify', 'lovable', 'wise', 'sentry', 'opencode']
  for (const t of builtinThemes()) {
    const text = (t.name.en + ' ' + t.name['zh-TW'] + ' ' + t.description.en + ' ' + t.description['zh-TW']).toLowerCase()
    for (const b of brands) {
      if (text.includes(b)) throw new Error(t.id + ' contains brand ' + b)
    }
  }
})

test('themeById 找得到、中文名正確', async () => {
  expect(themeById('s2-dark-player')?.name['zh-TW']).toBe('深色音樂播放器')
  expect(themeById('s5-midnight-play')?.name.en).toBe('Midnight play')
  expect(themeById(DEFAULT_THEME_ID)?.id).toBe('s3-warm-notebook')
})

test('themeById 未知輸入回 undefined、不丟例外', async () => {
  expect(themeById('nope')).toBe(undefined)
  expect(themeById(null)).toBe(undefined)
  expect(themeById({})).toBe(undefined)
  expect(themeById('__proto__')).toBe(undefined)
  expect(themeById(42)).toBe(undefined)
  expect(themeById(undefined)).toBe(undefined)
})

test('themeOrDefault：找得到就用它，找不到回預設', async () => {
  expect(themeOrDefault(undefined).id).toBe('s3-warm-notebook')
  expect(themeOrDefault(null).id).toBe('s3-warm-notebook')
  expect(themeOrDefault('nope').id).toBe('s3-warm-notebook')
  expect(themeOrDefault('s5-midnight-play').id).toBe('s5-midnight-play')
  expect(themeOrDefault('s1-quiet-docs').id).toBe('s1-quiet-docs')
})

test('builtinThemes 回傳陣列與每個 theme 都凍結；兩次呼叫結果相等', async () => {
  const a = builtinThemes()
  const b = builtinThemes()
  expect(a).toEqual(b)
  expect(Object.isFrozen(a)).toBe(true)
  for (const t of a) {
    expect(Object.isFrozen(t)).toBe(true)
    expect(Object.isFrozen(t.colors)).toBe(true)
  }
})

test('COLOR_TOKENS 每個鍵五套都有；terminal 值都在 TERMINAL_KEYS 裡', async () => {
  for (const t of builtinThemes()) {
    for (const token of COLOR_TOKENS) {
      expect(Object.prototype.hasOwnProperty.call(t.colors, token)).toBe(true)
    }
    for (const key of Object.values(t.terminal)) {
      expect(TERMINAL_KEYS).toContain(key)
    }
  }
})

test('每套的 creator 與 copyright 一致', async () => {
  for (const t of builtinThemes()) {
    expect(t.creator).toBe('with-friends')
    expect(t.copyright).toBe('')
  }
})
