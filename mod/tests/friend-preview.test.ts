import { expect, test } from 'claude-code/testing'
import { cellWidth } from '../hooks/changelog'
import { buildPreviewRows, PREVIEW_ROW_IDS, PREVIEW_STRINGS, previewText } from '../hooks/friend-preview'
import type { PreviewInput, PreviewRow } from '../hooks/friend-preview'
import { activityText } from '../hooks/taxonomy'

const asInput = (v: unknown): PreviewInput => v as PreviewInput

const base = (): PreviewInput => ({
  name: 'Alice',
  groupName: 'Weekend',
  avatar: 'cat',
  isOwner: true,
  version: '0.6.4',
  body: { state: 'working', action: 'designing', subject: 'website' },
  activityAgoSec: 300,
})

const byId = (rows: PreviewRow[], id: string): PreviewRow | undefined => rows.find((r) => r.id === id)
const ids = (rows: PreviewRow[]): string[] => rows.map((r) => r.id)

test('完整輸入（英文）：8 列照 PREVIEW_ROW_IDS 順序，值與 kind 正確', async () => {
  const rows = buildPreviewRows(base(), 'en')
  expect(ids(rows)).toEqual([...PREVIEW_ROW_IDS])
  expect(byId(rows, 'name')?.value).toBe('Alice')
  expect(byId(rows, 'group')?.value).toBe('Weekend')
  expect(byId(rows, 'avatar')?.value).toBe('cat')
  expect(byId(rows, 'status')?.value).toBe('Working')
  expect(byId(rows, 'doing')?.value).toBe(activityText('designing', 'website', 'en'))
  expect(byId(rows, 'since')?.value).toBe('started 5m ago')
  expect(byId(rows, 'version')?.value).toBe('0.6.4')
  expect(byId(rows, 'owner')?.value).toBe('Yes')
  expect(byId(rows, 'name')?.kind).toBe('free-text')
  expect(byId(rows, 'group')?.kind).toBe('free-text')
  expect(byId(rows, 'avatar')?.kind).toBe('code')
  expect(byId(rows, 'since')?.kind).toBe('code')
})

test('完整輸入（繁中）：狀態、since、owner 用繁中字串，label 來自字串表', async () => {
  const rows = buildPreviewRows(base(), 'zh-TW')
  expect(byId(rows, 'status')?.value).toBe('工作中')
  expect(byId(rows, 'doing')?.value).toBe(activityText('designing', 'website', 'zh-TW'))
  expect(byId(rows, 'since')?.value).toBe('5 分鐘前開始')
  expect(byId(rows, 'owner')?.value).toBe('是')
  for (const row of rows) {
    expect(row.label).toBe(PREVIEW_STRINGS['zh-TW'].labels[row.id])
  }
})

test('name 與 group：缺值、空字串、純空白、非字串都顯示 none', async () => {
  for (const bad of [undefined, '', '   ', 123, null, {}, []]) {
    const rows = buildPreviewRows(asInput({ ...base(), name: bad, groupName: bad }), 'en')
    expect(byId(rows, 'name')?.value).toBe(PREVIEW_STRINGS.en.none)
    expect(byId(rows, 'group')?.value).toBe(PREVIEW_STRINGS.en.none)
  }
  const rowsZh = buildPreviewRows(asInput({ ...base(), name: '' }), 'zh-TW')
  expect(byId(rowsZh, 'name')?.value).toBe('（沒有）')
})

test('avatar：清單內代碼原樣，清單外字串不原樣印出', async () => {
  expect(byId(buildPreviewRows({ ...base(), avatar: 'robot' }, 'en'), 'avatar')?.value).toBe('robot')
  expect(byId(buildPreviewRows({ ...base(), avatar: 'Alice' }, 'en'), 'avatar')?.value).toBe(PREVIEW_STRINGS.en.none)
  expect(byId(buildPreviewRows({ ...base(), avatar: '' }, 'en'), 'avatar')?.value).toBe(PREVIEW_STRINGS.en.none)
  expect(byId(buildPreviewRows({ ...base(), avatar: 42 }, 'en'), 'avatar')?.value).toBe(PREVIEW_STRINGS.en.none)
})

test('status：三種 state 對應字串，其他值顯示 none', async () => {
  const cases: Array<[unknown, string, string]> = [
    ['working', 'Working', '工作中'],
    ['idle', 'Idle', '閒置'],
    ['offline', 'Offline', '離線'],
    ['busy', PREVIEW_STRINGS.en.none, PREVIEW_STRINGS['zh-TW'].none],
    [undefined, PREVIEW_STRINGS.en.none, PREVIEW_STRINGS['zh-TW'].none],
    [7, PREVIEW_STRINGS.en.none, PREVIEW_STRINGS['zh-TW'].none],
  ]
  for (const [state, en, zh] of cases) {
    const input = asInput({ ...base(), body: { state } })
    expect(byId(buildPreviewRows(input, 'en'), 'status')?.value).toBe(en)
    expect(byId(buildPreviewRows(input, 'zh-TW'), 'status')?.value).toBe(zh)
  }
})

test('paused 為 true：doing 顯示 none、since 不出現，但 status 照 state 顯示', async () => {
  const input = asInput({ ...base(), body: { state: 'working', paused: true, action: 'designing', subject: 'website' } })
  const rows = buildPreviewRows(input, 'en')
  expect(byId(rows, 'status')?.value).toBe('Working')
  expect(byId(rows, 'doing')?.value).toBe(PREVIEW_STRINGS.en.none)
  expect(ids(rows)).not.toContain('since')
})

test('paused 不是 true（字串、數字、缺值）時 doing 照常顯示', async () => {
  for (const paused of ['yes', 1, undefined, false]) {
    const input = asInput({ ...base(), body: { state: 'idle', paused, action: 'planning', subject: 'app' } })
    const rows = buildPreviewRows(input, 'en')
    expect(byId(rows, 'doing')?.value).toBe(activityText('planning', 'app', 'en'))
    expect(ids(rows)).toContain('since')
  }
})

test('doing：action 或 subject 不在清單就顯示 none，since 跟著不出現', async () => {
  for (const body of [
    { state: 'working', action: 'designing' },
    { state: 'working', subject: 'website' },
    { state: 'working', action: 'typing-fast', subject: 'website' },
    { state: 'working', action: 'designing', subject: 'my-folder' },
  ]) {
    const rows = buildPreviewRows(asInput({ ...base(), body }), 'en')
    expect(byId(rows, 'doing')?.value).toBe(PREVIEW_STRINGS.en.none)
    expect(ids(rows)).not.toContain('since')
  }
})

test('action 與 subject 都是 other：doing 就是 activityText(other, other)，不特判', async () => {
  const input = asInput({ ...base(), body: { state: 'working', action: 'other', subject: 'other' } })
  expect(byId(buildPreviewRows(input, 'en'), 'doing')?.value).toBe(activityText('other', 'other', 'en'))
  expect(byId(buildPreviewRows(input, 'zh-TW'), 'doing')?.value).toBe(activityText('other', 'other', 'zh-TW'))
  expect(ids(buildPreviewRows(input, 'en'))).toContain('since')
})

test('since 邊界：59／60／3599／3600／86399／86400／NaN／-5／Infinity／非數字', async () => {
  const cases: Array<[unknown, string]> = [
    [59, 'started just now'],
    [60, 'started 1m ago'],
    [3599, 'started 59m ago'],
    [3600, 'started 1h ago'],
    [86399, 'started 23h ago'],
    [86400, 'started 1d ago'],
    [NaN, 'started just now'],
    [-5, 'started just now'],
    [Infinity, 'started just now'],
    ['300', 'started just now'],
    [undefined, 'started just now'],
  ]
  for (const [ago, expected] of cases) {
    const rows = buildPreviewRows({ ...base(), activityAgoSec: ago }, 'en')
    expect(byId(rows, 'since')?.value).toBe(expected)
  }
})

test('since 繁中：剛剛開始／分鐘前開始／小時前開始／天前開始', async () => {
  const cases: Array<[number, string]> = [
    [0, '剛剛開始'],
    [300, '5 分鐘前開始'],
    [7200, '2 小時前開始'],
    [259200, '3 天前開始'],
  ]
  for (const [ago, expected] of cases) {
    const rows = buildPreviewRows({ ...base(), activityAgoSec: ago }, 'zh-TW')
    expect(byId(rows, 'since')?.value).toBe(expected)
  }
})

test('version：符合格式才出現這一列', async () => {
  for (const ok of ['0.6.4', '1.22.333', '0.0.1']) {
    const rows = buildPreviewRows({ ...base(), version: ok }, 'en')
    expect(byId(rows, 'version')?.value).toBe(ok)
  }
  for (const bad of ['0.6', 'v0.6.4', '0.6.4.1', '', '0000.1.2', '0.6.x', 64, null, {}]) {
    const rows = buildPreviewRows(asInput({ ...base(), version: bad }), 'en')
    expect(ids(rows)).not.toContain('version')
  }
})

test('owner：true 顯示 yes、false 顯示 no、其他值整列不出現', async () => {
  expect(byId(buildPreviewRows({ ...base(), isOwner: true }, 'zh-TW'), 'owner')?.value).toBe('是')
  expect(byId(buildPreviewRows({ ...base(), isOwner: false }, 'en'), 'owner')?.value).toBe('No')
  expect(byId(buildPreviewRows({ ...base(), isOwner: false }, 'zh-TW'), 'owner')?.value).toBe('不是')
  for (const bad of ['true', 1, 0, null, undefined, {}]) {
    const rows = buildPreviewRows(asInput({ ...base(), isOwner: bad }), 'en')
    expect(ids(rows)).not.toContain('owner')
  }
})

test('name 截 20 個 code point：全形字與表情符號都不切壞', async () => {
  const longZh = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'
  const rowsZh = buildPreviewRows({ ...base(), name: longZh }, 'zh-TW')
  expect([...(byId(rowsZh, 'name')?.value ?? '')]).toHaveLength(20)
  expect(byId(rowsZh, 'name')?.value).toBe('一二三四五六七八九十一二三四五六七八九十')
  const emojiName = '😀'.repeat(25)
  const rowsEmoji = buildPreviewRows({ ...base(), name: emojiName }, 'en')
  expect(byId(rowsEmoji, 'name')?.value).toBe('😀'.repeat(20))
  expect([...(byId(rowsEmoji, 'name')?.value ?? '')]).toHaveLength(20)
})

test('多行名字與群組名：連續空白（含換行）換成一個半形空格', async () => {
  const rows = buildPreviewRows({ ...base(), name: '小美\n\n  的\t新名字', groupName: '週末\n團' }, 'zh-TW')
  expect(byId(rows, 'name')?.value).toBe('小美 的 新名字')
  expect(byId(rows, 'group')?.value).toBe('週末 團')
  expect(byId(rows, 'name')?.value).not.toContain('\n')
})

test('值的格數上限：極端輸入下每一列都不超過 40 格，剛好 40 格不截', async () => {
  const extremes = [
    { ...base(), activityAgoSec: 1e40 },
    { ...base(), activityAgoSec: 1e20 },
    { ...base(), name: '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十', groupName: '😀'.repeat(30) },
    asInput({ ...base(), name: 'x'.repeat(100000) }),
  ]
  for (const input of extremes) {
    for (const lang of ['en', 'zh-TW'] as const) {
      for (const row of buildPreviewRows(input, lang)) {
        expect(cellWidth(row.value)).toBeLessThanOrEqual(40)
      }
    }
  }
  const exact = buildPreviewRows({ ...base(), name: '一二三四五六七八九十一二三四五六七八九十' }, 'zh-TW')
  expect(cellWidth(byId(exact, 'name')?.value ?? '')).toBe(40)
  expect(byId(exact, 'name')?.value).not.toContain('…')
})

test('輸入多出未知欄位：列的 id 集合不變，未知欄位不出現', async () => {
  const input = asInput({ ...base(), senderId: 'someone-else', relay: 'middle', folder: '/some/path' })
  const rows = buildPreviewRows(input, 'en')
  expect(ids(rows)).toEqual([...PREVIEW_ROW_IDS])
  const all = rows.map((r) => `${r.label}:${r.value}`).join('|')
  expect(all).not.toContain('someone-else')
  expect(all).not.toContain('middle')
  expect(all).not.toContain('/some/path')
})

test('惡意輸入：各種怪值不丟例外，code 列只出現清單代碼或 none', async () => {
  const nasty = asInput({
    name: 'a'.repeat(100000),
    groupName: ['x'],
    avatar: {},
    isOwner: [],
    version: NaN,
    body: { state: Infinity, paused: {}, action: [], subject: 'website' },
    activityAgoSec: {},
  })
  let rows: PreviewRow[] = []
  expect(() => {
    rows = buildPreviewRows(nasty, 'en')
  }).not.toThrow()
  expect(byId(rows, 'name')?.value).toBe('a'.repeat(20))
  expect(byId(rows, 'group')?.value).toBe(PREVIEW_STRINGS.en.none)
  expect(byId(rows, 'avatar')?.value).toBe(PREVIEW_STRINGS.en.none)
  expect(byId(rows, 'status')?.value).toBe(PREVIEW_STRINGS.en.none)
  expect(byId(rows, 'doing')?.value).toBe(PREVIEW_STRINGS.en.none)
  expect(ids(rows)).toEqual(['name', 'group', 'avatar', 'status', 'doing'])
  const bodyString = buildPreviewRows(asInput({ ...base(), body: 'working' }), 'en')
  expect(byId(bodyString, 'status')?.value).toBe(PREVIEW_STRINGS.en.none)
  const bodyArray = buildPreviewRows(asInput({ ...base(), body: [] }), 'en')
  expect(byId(bodyArray, 'doing')?.value).toBe(PREVIEW_STRINGS.en.none)
})

test('input 是 null 或非物件：不丟例外，每個欄位當缺', async () => {
  for (const bad of [null, 42, 'x', undefined, true]) {
    let rows: PreviewRow[] = []
    expect(() => {
      rows = buildPreviewRows(asInput(bad), 'zh-TW')
    }).not.toThrow()
    expect(ids(rows)).toEqual(['name', 'group', 'avatar', 'status', 'doing'])
    expect(byId(rows, 'name')?.value).toBe('（沒有）')
  }
})

test('固定承諾句 V1、V2：兩種語言逐字存在', async () => {
  expect(PREVIEW_STRINGS.en.intro).toBe('This is everything your friends see about you.')
  expect(PREVIEW_STRINGS['zh-TW'].intro).toBe('你的朋友看到的你，就是下面這幾項，沒有別的。')
  expect(PREVIEW_STRINGS.en.freeTextNote).toBe('Your name and group name are text you chose. Everything else is a code from a fixed list.')
  expect(PREVIEW_STRINGS['zh-TW'].freeTextNote).toBe('名字和群組名是你自己取的字，其餘都是固定清單裡的代碼。')
})

test('previewText 回傳對應語言的字串表', async () => {
  expect(previewText('en')).toBe(PREVIEW_STRINGS.en)
  expect(previewText('zh-TW')).toBe(PREVIEW_STRINGS['zh-TW'])
})

test('字串格數上限：標題、按鈕、標籤都在卡片上限內', async () => {
  const en = PREVIEW_STRINGS.en
  const zh = PREVIEW_STRINGS['zh-TW']
  expect(cellWidth(en.title)).toBeLessThanOrEqual(24)
  expect(cellWidth(zh.title)).toBeLessThanOrEqual(16)
  expect(cellWidth(en.button)).toBeLessThanOrEqual(20)
  expect(cellWidth(zh.button)).toBeLessThanOrEqual(12)
  expect(cellWidth(en.buttonName)).toBeLessThanOrEqual(20)
  expect(cellWidth(zh.buttonName)).toBeLessThanOrEqual(12)
  expect(en.intro.length).toBeLessThanOrEqual(120)
  expect(zh.intro.length).toBeLessThanOrEqual(60)
  expect(en.freeTextNote.length).toBeLessThanOrEqual(120)
  expect(zh.freeTextNote.length).toBeLessThanOrEqual(60)
  for (const id of PREVIEW_ROW_IDS) {
    expect(cellWidth(en.labels[id])).toBeLessThanOrEqual(16)
    expect(cellWidth(zh.labels[id])).toBeLessThanOrEqual(10)
  }
})

test('字串與列值不含禁字', async () => {
  const banned = [
    ['保', '證'], ['絕', '對'], ['永', '遠'], ['私', '密'], ['保', '密'], ['刪', '除'],
    ['加', '密'], ['端', '對', '端'], ['語', '音'], ['推', '播'],
    ['sec', 'ure'], ['pri', 'vate'], ['sa', 'fe'], ['nev', 'er'], ['alw', 'ays'],
    ['del', 'ete'], ['enc', 'rypted'], ['E', '2', 'E'],
  ].map((parts) => parts.join(''))
  const pieces: string[] = []
  for (const lang of ['en', 'zh-TW'] as const) {
    const s = PREVIEW_STRINGS[lang]
    pieces.push(s.title, s.button, s.buttonName, s.close, s.intro, s.freeTextNote, s.none, s.yes, s.no, s.justNow)
    pieces.push(s.minAgo(3), s.hourAgo(3), s.dayAgo(3), s.startedPrefix, s.startedSuffix)
    pieces.push(s.presence.working, s.presence.idle, s.presence.offline)
    for (const id of PREVIEW_ROW_IDS) pieces.push(s.labels[id])
    for (const row of buildPreviewRows(base(), lang)) pieces.push(row.label, row.value)
  }
  const all = pieces.join('|')
  for (const word of banned) {
    expect(all).not.toContain(word)
  }
})

test('不改傳入物件：凍結的輸入也能跑，內容不變', async () => {
  const input = base()
  const snapshot = JSON.parse(JSON.stringify(input)) as unknown
  Object.freeze(input.body)
  Object.freeze(input)
  let rows: PreviewRow[] = []
  expect(() => {
    rows = buildPreviewRows(input, 'en')
  }).not.toThrow()
  expect(rows.length).toBeGreaterThan(0)
  expect(JSON.parse(JSON.stringify(input)) as unknown).toEqual(snapshot)
})
