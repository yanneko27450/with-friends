import { expect, test } from 'claude-code/testing'
import {
  COLOR_TOKENS, THEME_FILE_MAX_CHARS, THEME_SCHEMA, contrastRatio, parseHex, parseTheme, parseThemeText,
} from '../hooks/chat-theme'

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

function cloneS3(): any {
  return JSON.parse(JSON.stringify(S3_SAMPLE))
}

function withoutKey(obj: any, key: string): any {
  const out: any = {}
  for (const k of Object.keys(obj)) {
    if (k !== key) out[k] = obj[k]
  }
  return out
}

function errorsOf(input: unknown): readonly string[] {
  const r = parseTheme(input)
  if (r.ok) throw new Error('expected parse to fail')
  return r.errors
}

function deepFreeze(v: any): any {
  if (typeof v === 'object' && v !== null) {
    for (const k of Object.keys(v)) deepFreeze(v[k])
    Object.freeze(v)
  }
  return v
}

test('常數：格式版本 1、主題檔上限 8000、顏色 token 23 個', async () => {
  expect(THEME_SCHEMA).toBe(1)
  expect(THEME_FILE_MAX_CHARS).toBe(8000)
  expect(COLOR_TOKENS).toHaveLength(23)
})

test('parseHex 收小寫 #rrggbb 並回 rgb', async () => {
  expect(parseHex('#f7f4ed')).toEqual([247, 244, 237])
  expect(parseHex('#000000')).toEqual([0, 0, 0])
  expect(parseHex('#ffffff')).toEqual([255, 255, 255])
  expect(parseHex('#1ed760')).toEqual([30, 215, 96])
})

test('parseHex 拒收大寫、三碼、沒井號、空白、非字串', async () => {
  expect(parseHex('#F7F4ED')).toBe(null)
  expect(parseHex('#abc')).toBe(null)
  expect(parseHex('f7f4ed')).toBe(null)
  expect(parseHex(' #f7f4ed')).toBe(null)
  expect(parseHex('#f7f4ed ')).toBe(null)
  expect(parseHex('#f7f4e')).toBe(null)
  expect(parseHex('#f7f4edd')).toBe(null)
  expect(parseHex('#gggggg')).toBe(null)
  expect(parseHex(123)).toBe(null)
  expect(parseHex(null)).toBe(null)
  expect(parseHex(undefined)).toBe(null)
})

test('contrastRatio 已知值：黑白 21、同色 1、灰階例子', async () => {
  expect(contrastRatio('#000000', '#ffffff')).toBe(21)
  expect(contrastRatio('#ffffff', '#000000')).toBe(21)
  expect(contrastRatio('#123456', '#123456')).toBe(1)
  expect(contrastRatio('#767676', '#ffffff')).toBe(4.54)
  expect(contrastRatio('#777777', '#ffffff')).toBe(4.48)
})

test('contrastRatio 不合法的顏色回 0', async () => {
  expect(contrastRatio('red', '#ffffff')).toBe(0)
  expect(contrastRatio('#ffffff', '#FFF')).toBe(0)
  expect(contrastRatio('', '')).toBe(0)
})

test('S3 範例主題通過、沒有警告、值照抄', async () => {
  const r = parseTheme(cloneS3())
  if (!r.ok) throw new Error('S3 should parse: ' + r.errors.join(','))
  expect(r.warnings).toHaveLength(0)
  expect(r.theme.id).toBe('s3-warm-notebook')
  expect(r.theme.name['zh-TW']).toBe('溫暖手帳')
  expect(r.theme.colors.acc).toBe('#1c1c1c')
  expect(r.theme.colors.selbar).toBe('none')
  expect(r.theme.terminal.accent).toBe('claude')
  expect(r.theme.shape.avatarRing).toBe(1)
  expect(r.theme.icons.stroke).toBe(2)
})

test('回傳的 theme 是新物件、深凍結、不是傳入的那個', async () => {
  const input = cloneS3()
  const r = parseTheme(input)
  if (!r.ok) throw new Error('S3 should parse')
  expect(r.theme === input).toBe(false)
  expect(Object.isFrozen(r.theme)).toBe(true)
  expect(Object.isFrozen(r.theme.colors)).toBe(true)
  expect(Object.isFrozen(r.theme.name)).toBe(true)
  expect(Object.isFrozen(r.theme.terminal)).toBe(true)
  expect(Object.isFrozen(r.theme.shape)).toBe(true)
  expect(Object.isFrozen(r.theme.background)).toBe(true)
  expect(Object.isFrozen(input)).toBe(false)
})

test('傳入物件先凍結也不影響解析（不改輸入）', async () => {
  const input = deepFreeze(cloneS3())
  const r = parseTheme(input)
  if (!r.ok) throw new Error('frozen S3 should parse')
  expect(r.theme.id).toBe('s3-warm-notebook')
})

test('不是普通物件的輸入回 ?:type，不丟例外', async () => {
  expect(parseTheme(null)).toEqual({ ok: false, errors: ['?:type'] })
  expect(parseTheme(undefined)).toEqual({ ok: false, errors: ['?:type'] })
  expect(parseTheme([1, 2])).toEqual({ ok: false, errors: ['?:type'] })
  expect(parseTheme(42)).toEqual({ ok: false, errors: ['?:type'] })
  expect(parseTheme('theme')).toEqual({ ok: false, errors: ['?:type'] })
  expect(parseTheme(new Date())).toEqual({ ok: false, errors: ['?:type'] })
  expect(() => parseTheme(() => 1)).not.toThrow()
})

test('schema 不是 1 拒收；少了 schema 報 missing', async () => {
  const a = cloneS3()
  a.schema = 2
  expect(errorsOf(a)).toContain('schema:not-allowed')
  const b = cloneS3()
  b.schema = '1'
  expect(errorsOf(b)).toContain('schema:not-allowed')
  const c = withoutKey(cloneS3(), 'schema')
  expect(errorsOf(c)).toContain('schema:missing')
})

test('id 格式：大寫、開頭連字號、25 字、非字串', async () => {
  const a = cloneS3()
  a.id = 'S3-Warm'
  expect(errorsOf(a)).toContain('id:not-allowed')
  const b = cloneS3()
  b.id = '-abc'
  expect(errorsOf(b)).toContain('id:not-allowed')
  const c = cloneS3()
  c.id = 'a'.repeat(25)
  expect(errorsOf(c)).toContain('id:not-allowed')
  const d = cloneS3()
  d.id = 'a'.repeat(24)
  expect(parseTheme(d).ok).toBe(true)
  const e = cloneS3()
  e.id = 5
  expect(errorsOf(e)).toContain('id:type')
})

test('多一個鍵拒收：普通鍵、__proto__、constructor，鍵名不印出', async () => {
  const a = cloneS3()
  a.extra = 1
  expect(errorsOf(a)).toContain('?:unknown-key')
  const raw = JSON.stringify(S3_SAMPLE)
  const withProto = JSON.parse(raw.substring(0, raw.length - 1) + ',"__proto__":{"polluted":true}}')
  expect(errorsOf(withProto)).toContain('?:unknown-key')
  const c = cloneS3()
  c['constructor'] = {}
  expect(errorsOf(c)).toContain('?:unknown-key')
  const d = cloneS3()
  d.colors.extra = '#000000'
  expect(errorsOf(d)).toContain('colors.?:unknown-key')
})

test('少鍵：colors 少一個、name 少一種語言、頂層少一欄', async () => {
  const a = cloneS3()
  a.colors = withoutKey(a.colors, 'page')
  expect(errorsOf(a)).toContain('colors.page:missing')
  const b = cloneS3()
  b.name = withoutKey(b.name, 'en')
  expect(errorsOf(b)).toContain('name.en:missing')
  const c = withoutKey(cloneS3(), 'creator')
  expect(errorsOf(c)).toContain('creator:missing')
  const d = cloneS3()
  d.terminal = withoutKey(d.terminal, 'off')
  expect(errorsOf(d)).toContain('terminal.off:missing')
})

test('colors 每個鍵弄壞成非 hex 都報 not-hex', async () => {
  for (const token of COLOR_TOKENS) {
    const c = cloneS3()
    c.colors[token] = 'red'
    expect(errorsOf(c)).toContain('colors.' + token + ':not-hex')
  }
})

test('colors 值變形：大寫、三碼、沒井號、數字', async () => {
  for (const bad of ['#F7F4ED', '#abc', 'f7f4ed', 123, true]) {
    const c = cloneS3()
    c.colors.page = bad
    expect(errorsOf(c)).toContain('colors.page:not-hex')
  }
})

test("colors 不可為 'none' 的欄位放 'none' 報 not-hex", async () => {
  for (const token of ['page', 'text', 'acc', 'mine', 'minetext', 'badgeTx', 'ring', 'grp']) {
    const c = cloneS3()
    c.colors[token] = 'none'
    expect(errorsOf(c)).toContain('colors.' + token + ':not-hex')
  }
})

test("colors 可為 'none' 的欄位放 'none' 通過", async () => {
  for (const token of ['line', 'theirs', 'theirsline', 'ok', 'warn', 'off', 'sel', 'selbar']) {
    const c = cloneS3()
    c.colors[token] = 'none'
    expect(parseTheme(c).ok).toBe(true)
  }
  const c = cloneS3()
  c.colors.badgeBg = 'none'
  c.colors.badgeTx = '#1c1c1c'
  expect(parseTheme(c).ok).toBe(true)
})

test('terminal 值要在清單裡', async () => {
  const a = cloneS3()
  a.terminal.mine = 'bogus'
  expect(errorsOf(a)).toContain('terminal.mine:not-allowed')
  const b = cloneS3()
  b.terminal.accent = '#ffffff'
  expect(errorsOf(b)).toContain('terminal.accent:not-allowed')
})

test('清單欄位放清單外的值', async () => {
  const cases: [string, (c: any) => void][] = [
    ['scheme:not-allowed', c => { c.scheme = 'auto' }],
    ['shape.border:not-allowed', c => { c.shape.border = 'wavy' }],
    ['shape.bubble:not-allowed', c => { c.shape.bubble = 'oval' }],
    ['shape.avatarFrame:not-allowed', c => { c.shape.avatarFrame = 'oval' }],
    ['shape.avatarRing:not-allowed', c => { c.shape.avatarRing = 3 }],
    ['shape.avatarRing:not-allowed', c => { c.shape.avatarRing = '1' }],
    ['spacing.density:not-allowed', c => { c.spacing.density = 'wide' }],
    ['weight.title:not-allowed', c => { c.weight.title = 'heavy' }],
    ['weight.names:not-allowed', c => { c.weight.names = 'heavy' }],
    ['icons.set:not-allowed', c => { c.icons.set = 'feather' }],
    ['icons.stroke:not-allowed', c => { c.icons.stroke = '2' }],
    ['icons.stroke:not-allowed', c => { c.icons.stroke = 2.0000001 }],
    ['icons.size:not-allowed', c => { c.icons.size = 15 }],
    ['background.kind:not-allowed', c => { c.background.kind = 'image' }],
    ['background.tint:not-allowed', c => { c.background.tint = 'bogus' }],
    ['emptyArt:not-allowed', c => { c.emptyArt = 'cat' }],
  ]
  for (const [want, mutate] of cases) {
    const c = cloneS3()
    mutate(c)
    expect(errorsOf(c)).toContain(want)
  }
})

test('文字格數邊界：name 24 格過、25 格 too-long；寬字算 2 格', async () => {
  const a = cloneS3()
  a.name.en = 'a'.repeat(24)
  expect(parseTheme(a).ok).toBe(true)
  const b = cloneS3()
  b.name.en = 'a'.repeat(25)
  expect(errorsOf(b)).toContain('name.en:too-long')
  const c = cloneS3()
  c.name['zh-TW'] = 'あ'.repeat(12)
  expect(parseTheme(c).ok).toBe(true)
  const d = cloneS3()
  d.name['zh-TW'] = 'あ'.repeat(13)
  expect(errorsOf(d)).toContain('name.zh-TW:too-long')
  const e = cloneS3()
  e.description.en = 'a'.repeat(80)
  expect(parseTheme(e).ok).toBe(true)
  const f = cloneS3()
  f.description.en = 'a'.repeat(81)
  expect(errorsOf(f)).toContain('description.en:too-long')
  const g = cloneS3()
  g.copyright = 'a'.repeat(41)
  expect(errorsOf(g)).toContain('copyright:too-long')
})

test('文字不乾淨：零寬字、頭尾空白、空字串（copyright 除外）', async () => {
  const a = cloneS3()
  a.name.en = 'Warm' + String.fromCharCode(0x200b) + ' notebook'
  expect(errorsOf(a)).toContain('name.en:unclean')
  const b = cloneS3()
  b.name.en = 'Warm notebook '
  expect(errorsOf(b)).toContain('name.en:unclean')
  const c = cloneS3()
  c.creator = ''
  expect(errorsOf(c)).toContain('creator:unclean')
  const d = cloneS3()
  d.description['zh-TW'] = ''
  expect(errorsOf(d)).toContain('description.zh-TW:unclean')
  const e = cloneS3()
  e.copyright = ''
  expect(parseTheme(e).ok).toBe(true)
  const f = cloneS3()
  f.name = 'Warm notebook'
  expect(errorsOf(f)).toContain('name:type')
})

// 對比邊界（對 #ffffff）：
// #647a85 亮度 L≈0.18322，未捨入比值 1.05/0.23322≈4.5022 → 四捨五入 4.50，通過
// #647a87 亮度 L≈0.18378，未捨入比值 1.05/0.23378≈4.4915 → 四捨五入 4.49，不通過
test('對比邊界：剛好 4.50 通過、4.49 報 contrast', async () => {
  expect(contrastRatio('#647a85', '#ffffff')).toBe(4.5)
  expect(contrastRatio('#647a87', '#ffffff')).toBe(4.49)
  const a = cloneS3()
  a.colors.page = '#ffffff'
  a.colors.panel = '#ffffff'
  a.colors.side = '#ffffff'
  a.colors.text = '#647a85'
  expect(parseTheme(a).ok).toBe(true)
  const b = cloneS3()
  b.colors.page = '#ffffff'
  b.colors.panel = '#ffffff'
  b.colors.side = '#ffffff'
  b.colors.text = '#647a87'
  expect(errorsOf(b)).toContain('colors.text:contrast')
})

test("theirs 是 'none' 時 theirstext 改比 page", async () => {
  const a = cloneS3()
  a.colors.theirs = 'none'
  expect(parseTheme(a).ok).toBe(true)
  const b = cloneS3()
  b.colors.theirs = 'none'
  b.colors.theirstext = '#a8a59e'
  expect(errorsOf(b)).toContain('colors.theirstext:contrast')
})

test("badgeBg 是 'none' 時 badgeTx 改比 page", async () => {
  const a = cloneS3()
  a.colors.badgeBg = 'none'
  a.colors.badgeTx = '#a8a59e'
  expect(errorsOf(a)).toContain('colors.badgeTx:contrast')
})

test('dim 對比低於 3 只給警告、不報錯', async () => {
  const c = cloneS3()
  c.colors.dim = '#a8a59e'
  const r = parseTheme(c)
  if (!r.ok) throw new Error('dim-low should still parse')
  expect(r.warnings).toEqual(['colors.dim:low-contrast'])
})

test('errors 一次列出多個問題', async () => {
  const c = cloneS3()
  c.schema = 2
  c.colors.page = 'red'
  c.shape.border = 'wavy'
  c.extra = true
  const errs = errorsOf(c)
  expect(errs.length).toBeGreaterThanOrEqual(4)
  expect(errs).toContain('schema:not-allowed')
  expect(errs).toContain('colors.page:not-hex')
  expect(errs).toContain('shape.border:not-allowed')
  expect(errs).toContain('?:unknown-key')
})

test('錯誤字串不含輸入的值與鍵名', async () => {
  const c = cloneS3()
  c.colors.page = 'xqzmarker9'
  c['xqzmarkerkey'] = 'xqzmarkerval'
  const joined = errorsOf(c).join('|')
  expect(joined).not.toContain('xqzmarker9')
  expect(joined).not.toContain('xqzmarkerkey')
  expect(joined).not.toContain('xqzmarkerval')
})

test('parseThemeText：成功、json 壞掉、超過長度先擋', async () => {
  const text = JSON.stringify(S3_SAMPLE)
  const r = parseThemeText(text)
  if (!r.ok) throw new Error('text S3 should parse')
  expect(r.theme.id).toBe('s3-warm-notebook')
  expect(parseThemeText('{oops')).toEqual({ ok: false, errors: ['file:json'] })
  expect(parseThemeText('x'.repeat(8001))).toEqual({ ok: false, errors: ['file:size'] })
  expect(parseThemeText(123)).toEqual({ ok: false, errors: ['file:size'] })
  expect(parseThemeText(null)).toEqual({ ok: false, errors: ['file:size'] })
  const padded = text + ' '.repeat(8000 - text.length)
  expect(padded.length).toBe(8000)
  expect(parseThemeText(padded).ok).toBe(true)
  const tooLong = text + ' '.repeat(8001 - text.length)
  expect(parseThemeText(tooLong)).toEqual({ ok: false, errors: ['file:size'] })
  const badTheme = parseThemeText('{"schema":2}')
  if (badTheme.ok) throw new Error('schema 2 text should fail')
  expect(badTheme.errors).toContain('schema:not-allowed')
})

test('巢狀物件給錯型別報 type，不丟例外', async () => {
  const a = cloneS3()
  a.colors = []
  expect(errorsOf(a)).toContain('colors:type')
  const b = cloneS3()
  b.shape = 'round'
  expect(errorsOf(b)).toContain('shape:type')
  const c = cloneS3()
  c.name = null
  expect(errorsOf(c)).toContain('name:type')
})
