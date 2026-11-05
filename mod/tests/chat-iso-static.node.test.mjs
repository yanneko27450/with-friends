// CHAT4-ISO：靜態那一層的測試，用 Node 跑（不經過外掛引擎；`claude plugin test` 不會跑它，要另外執行）：
//   node mod/tests/chat-iso-static.node.test.mjs        （需要 Node 22.18 以上或 24：直接載入 .ts）
// ①引擎的每個 op 都在 exits.ts 歸過類（引擎升級冒出新出口就紅）②靜態掃描器自己準不準（每條規則一個反向例、一批繞過手法）
// ③現有處理聊天文字的純函式檔真的乾淨、新增的 chat-*.ts 沒被漏掉 ④之後 CHAT-3／CHAT-4 的檔案掛上來（CLIENT_FILES／PANE_FILES）
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

import { classifyOp, EXIT_OPS, NON_EXIT_OPS } from './fixtures/chat-iso/exits.ts'
import { importsOf, localValueImports, scanSource, stripComments, STATIC_RULE_IDS } from './fixtures/chat-iso/static-scan.ts'

const hooksDir = new URL('../hooks/', import.meta.url)
const hooks = name => new URL(name, hooksDir)

/** 處理聊天文字的純函式檔：現在就有，必須一直乾淨。CHAT-3／CHAT-4 新增的純函式檔也加在這裡 */
const PURE_FILES = [
  'chat-types.ts', 'chat-list.ts', 'chat-unread.ts', 'chat-input.ts', 'chat-strings.ts', 'chat-states.ts', 'dm-strings.ts', 'chat-preview-strings.ts',
  'chat-envelope.ts', 'chat-theme.ts', 'chat-themes.ts', 'chat-theme-resolve.ts',
  // INT060d：release 這邊的加密與用戶端模組（sec/060-chat、060-client、060-client2、060-gate 帶進來）。都不碰 $，照最嚴的 pure 規則掃
  'chat-capability.ts', 'chat-client.ts', 'chat-codec.ts', 'chat-frame.ts', 'chat-keys.ts', 'chat-rekey.ts', 'chat-replay.ts', 'chat-roster.ts', 'chat-sync.ts',
  // CHAT-4W：控制器、畫面狀態、保管庫形狀、回應對照、暫定字串、聊天分頁的畫面。全部沒有 $、沒有 import 引擎：碰 $ 的只有下面的 WIRING_FILES
  // CHAT-6：成員身分清單（加入證明、wf1 邀請、簽章與驗證）與保管庫的第一次產生。都是純函式，沒有 $
  'chat-members.ts', 'chat-provision.ts',
  'chat-controller.ts', 'chat-view.ts', 'chat-vault.ts', 'chat-http-map.ts', 'chat-wire-strings.ts', 'chat-pane.tsx',
]
/** 例外：名字像聊天、但不處理聊天文字，也不是純函式檔（目前沒有）。要放進來必須寫理由 */
const NOT_CHAT_TEXT = {}
/** CHAT3-CLIENT 的收件／送出模組（最先碰到明文）。檔名定案後加在這裡；現在還沒有 */
const CLIENT_FILES = []
/** CHAT-4 的聊天分頁畫面檔（讀記憶體 atom、畫出來）。CHAT-4W 的畫面檔 chat-pane.tsx 根本不碰 $（元件由接線層傳進來），所以照更嚴的 pure 規則掃，列在 PURE_FILES */
const PANE_FILES = []
/** CHAT-4W 的接線檔：外掛只准一個 hooks 模組、$ 不能傳進別的模組，所以所有碰 $ 的聊天程式都在這一個檔案裡（逐條放行的出口見 static-scan.ts 的 WIRING_ALLOWED） */
const WIRING_FILES = ['chat-register.tsx']

test('引擎的每個 op 都在 exits.ts 歸過類（引擎升級冒出新出口就紅）', async () => {
  const dts = new URL('../.claude-plugin/types/claude-code/index.d.ts', import.meta.url)
  assert.ok(existsSync(dts), '沒有 .claude-plugin/types（它不在 git；從別的 worktree 整個複製過來，見 docs/PITFALLS.md）。缺了這個檢查就等於沒做，所以直接當失敗')
  const text = await readFile(dts, 'utf8')
  const ops = new Set([...text.matchAll(/^ {6}'([a-z]+\.[A-Za-z.]+)'\??:/gm)].map(m => m[1]))
  assert.ok(ops.size > 80, `只抓到 ${ops.size} 個 op 名字，型別檔格式可能變了，這個檢查要跟著改`)
  const unclassified = [...ops].filter(op => classifyOp(op) === undefined)
  assert.deepEqual(unclassified, [], `這些引擎 op 沒在 exits.ts 歸類（是出口還是只讀取？聊天文字能不能出現在它的參數裡？）：${unclassified.join(', ')}`)
})

test('exits.ts 自己一致：出口與非出口不重疊，每個出口都有種類與說明；classic.* 算出口（外掛的回答會進模型）', () => {
  for (const op of Object.keys(EXIT_OPS)) {
    assert.ok(!Object.hasOwn(NON_EXIT_OPS, op), `${op} 同時在出口和非出口`)
    assert.ok(EXIT_OPS[op].channel && EXIT_OPS[op].note.length > 0, `${op} 缺種類或說明`)
  }
  assert.equal(classifyOp('classic.PreToolUse'), 'exit')
  assert.equal(classifyOp('totally.new'), undefined)
  assert.equal(classifyOp('fs.exists'), 'exit', '檔案路徑可以是網路位置')
})

test('靜態掃描器：每條規則都有反向例（拿掉規則就抓不到）', () => {
  const bad = {
    'ui-toast': 'await $.ui.toast(m.text)',
    'ui-log': '$.ui.log(m.text)',
    'console': 'console.error(m.text)',
    'ui-copy': 'await $.ui.copy({ text: m.text })',
    'ui-pane-meta': 'await $.ui.open({ id: "chat", title: m.senderName })',
    'persist': 'await $.store.set("k", m.text)',
    'session': 'await $.session.append({ message: m })',
    'hook-answer': "on('prompt.section', async () => ({ text: last }))",
    'model': 'await $.model.classify(m.text, ["a"])',
    'network': 'await fetch(url)',
    'process': 'await $.process.run(["echo", m.text])',
    'mcp': 'await $.mcp.call(tool, { text })',
    'command-out': 'await $.command.run({ command: "x" })',
    'fs-path': 'await $.fs.exists(p)',
    'dynamic-code': 'const f = new Function("return 1")',
    'global-object': 'globalThis.fetch(u)',
    'browser-storage': 'localStorage.setItem("k", m.text)',
    'audio': 'await $.audio.speak(m.text)',
    'engine-import': "import { atom } from 'claude-code'",
    'dollar': 'const a = $.state.get(ref)',
  }
  const ruleSet = new Set(STATIC_RULE_IDS)
  for (const [rule, code] of Object.entries(bad)) {
    assert.ok(ruleSet.has(rule), `規則 ${rule} 不在 STATIC_RULE_IDS`)
    const got = scanSource(code, 'pure').map(f => f.rule)
    assert.ok(got.includes(rule), `規則 ${rule} 沒抓到：${code}（抓到 ${JSON.stringify(got)}）`)
  }
  assert.ok(scanSource("import { update } from 'claude-code'", 'pane').some(f => f.rule === 'pane-import'))
  assert.ok(scanSource('await update($, chatAtom, v => v)', 'pane').some(f => f.rule === 'pane-writes-atom'))
  assert.ok(scanSource('await $.store.get("x")', 'pane').some(f => f.rule === 'pane-dollar'))
})

test('靜態掃描器：常見的繞過手法都抓得到（多行 import、別名、解構、?.、[\'x\']、全域物件、字串裡的註解符號）', () => {
  const cases = [
    ['多行 import 夾帶 update', "import {\n  atom,\n  read,\n  update as u,\n} from 'claude-code'", 'pane', 'pane-import'],
    ['把 $ 傳給別的函式', 'leak($, m.text)', 'pane', 'pane-dollar'],
    ['解構 $', 'const { store } = $\nstore.set("k", t)', 'pane', 'pane-dollar'],
    ['別名', 'const t = $.ui\nt.toast(x)', 'pane', 'pane-dollar'],
    ['optional chaining', '$?.ui?.toast(x)', 'pane', 'ui-toast'],
    ['括號取屬性', "$['ui']['toast'](x)", 'pane', 'ui-toast'],
    ['globalThis.fetch', 'globalThis.fetch(u)', 'pane', 'global-object'],
    ['window.fetch', 'window.fetch(u)', 'client', 'global-object'],
    ['new Image', 'new Image().src = u', 'pane', 'network'],
    ['字串裡的 /* 不能吞掉後面的程式碼', 'const s = "/*"\n$.ui.toast(t)\nconst e = "*/"', 'client', 'ui-toast'],
    ['樣板字面值裡的 //', 'const s = `http://x`\n$.ui.toast(t)', 'client', 'ui-toast'],
    ['用 hook 回答 classic 事件', "on('classic.UserPromptSubmit', async () => ({ additionalContext: [t] }))", 'client', 'hook-answer'],
    ['純函式檔用別名', 'const { ui } = $\nui.toast(x)', 'pure', 'dollar'],
  ]
  for (const [name, code, kind, rule] of cases) {
    const got = scanSource(code, kind).map(f => f.rule)
    assert.ok(got.includes(rule), `${name}：該抓到 ${rule}，實際 ${JSON.stringify(got)}`)
  }
})

test('靜態掃描器：client 只放行 $.http.fetch／update／$.store.get/set，其餘 NETWORK／PERSIST 照擋', () => {
  const bad = [
    ['await $.fs.write(p, t)', 'persist'],
    ['await $.state.set(a, t)', 'persist'],
    ['await $.env.set("A", t)', 'persist'],
    ['await $.config.set("A", t)', 'persist'],
    ['await fetch(url, { body: t })', 'network'],
    ['new WebSocket(u)', 'network'],
    ['await $.store.delete(t)', 'persist'],
  ]
  for (const [code, rule] of bad) {
    const got = scanSource(code, 'client').map(f => f.rule)
    assert.ok(got.includes(rule), `client 該抓到 ${rule}：${code}（實際 ${JSON.stringify(got)}）`)
  }
  assert.deepEqual(scanSource('const r = await $.http.fetch(u)\nawait $.store.get("k")\nawait $.store.set("k", v)\nawait update($, a, f)', 'client'), [])
})

test('靜態掃描器：client 也追蹤 $ 別名，呼叫鏈跨行也比對', () => {
  const cases = [
    ['別名', 'const u = $.ui\nu.toast(t)'],
    ['解構', 'const { ui } = $\nui.toast(t)'],
    ['別名 session', 'const s = $.session\nawait s.append(m)'],
    ['傳遞', 'leak($, t)'],
    ['鏈跨行', 'await $.ui\n  .toast(t)'],
    ['$ 與鏈分行', 'await $\n .session\n .append(t)'],
    ['動態屬性', '$[k].toast(t)'],
  ]
  for (const [name, code] of cases) assert.ok(scanSource(code, 'client').length > 0, `client 該抓到：${name}`)
  assert.ok(scanSource('await $.ui\n  .toast(t)', 'client').some(f => f.rule === 'ui-toast' && f.line === 1), '跨行鏈報第一行')
  assert.ok(scanSource('await $\n .session\n .append(t)', 'client').some(f => f.rule === 'session'))
  assert.ok(scanSource('x\nawait $.store\n  .delete(t)', 'client').some(f => f.rule === 'persist' && f.line === 2))
})

test('靜態掃描器：聊天模組一律不准 on(（換行、萬用、變數事件名、別名）', () => {
  const cases = [
    "on('*', async ($, e, next) => ({ text: last }))",
    "on(\n 'prompt.section', async () => ({ text: last }))",
    'on(EVT, async () => ({ text: last }))',
    "const h = on; h('prompt.section', async () => 1)",
    "const h = on\nh('x', f)",
    'reg(on, f)',
  ]
  for (const kind of ['pure', 'pane', 'client']) {
    for (const code of cases) assert.ok(scanSource(code, kind).some(f => f.rule === 'hook-answer'), `${kind} 該抓到 hook-answer：${code}`)
  }
})

test('靜態掃描器：聊天分頁檔和用戶端檔可以做的事不誤報；用戶端能輪詢中繼、寫 atom、存非文字紀錄', () => {
  const okPane = [
    "import { atom, read } from 'claude-code'",
    "import type { EngineInterface } from 'claude-code'",
    "import { chatList } from './chat-list'",
    'export async function view($: EngineInterface, e: any) {',
    '  const st = await read($, chatAtom)',
    '  const { Box, Text } = $.ui.resolve(e)',
    '}',
    'const f = async ($) => { await read($, a) }',
  ].join('\n')
  assert.deepEqual(scanSource(okPane, 'pane'), [])
  assert.deepEqual(localValueImports(okPane), ['./chat-list'])
  const okClient = [
    "import { atom, read, update } from 'claude-code'",
    'async function poll($) {',
    '  const r = await $.http.fetch(url, { method: "POST" })',
    '  await update($, chatAtom, v => v)',
    '  await $.store.set("replay", seen)',
    '}',
  ].join('\n')
  assert.deepEqual(scanSource(okClient, 'client'), [])
  assert.ok(scanSource('$.ui.toast(x)', 'client').some(f => f.rule === 'ui-toast'), '用戶端也不准 toast')
})

test('靜態掃描器：註解不算、乾淨的純函式不誤報；行號不變', () => {
  const clean = [
    '// 這裡提到 $.ui.toast 和 console.log 只是說明',
    '/* fetch(url) 也是註解 */',
    'export function f(a: string): string { return a.trim() }',
    "const url = 'https://example.com/a'",
    'const t = `${a}.${b}`',
  ].join('\n')
  assert.deepEqual(scanSource(clean, 'pure'), [])
  assert.equal(stripComments('a\n/* x\ny */ b').split('\n').length, 3, '拿掉區塊註解後行數不變（報告的行號才對得上）')
  assert.equal(importsOf("import a from './a'\nimport type { B } from './b'\nimport './side'").length, 3)
})

// 新增的 chat-*.ts／dm-*.ts 不能被漏掉：要嘛列進 PURE_FILES（或 CLIENT／PANE），要嘛在 NOT_CHAT_TEXT 寫理由
test('hooks/ 底下的 chat-*.ts、dm-*.ts 都有被分類（沒有被默默漏掉）', async () => {
  const listed = new Set([...PURE_FILES, ...CLIENT_FILES, ...PANE_FILES, ...WIRING_FILES, ...Object.keys(NOT_CHAT_TEXT)])
  const present = (await readdir(hooksDir)).filter(f => /^(chat|dm)-.*\.tsx?$/.test(f))
  const missing = present.filter(f => !listed.has(f))
  assert.deepEqual(missing, [], `這些檔案沒列進 chat-iso-static.node.test.mjs：${missing.join(', ')}`)
  for (const f of listed) assert.ok(existsSync(hooks(f)), `${f} 列了但檔案不存在（改名了？）`)
})

for (const file of PURE_FILES) {
  test(`處理聊天文字的純函式檔不含任何出口：${file}`, async () => {
    const found = scanSource(await readFile(hooks(file), 'utf8'), 'pure')
    assert.deepEqual(found, [], `${file} 出現出口呼叫：${JSON.stringify(found)}`)
  })
}

for (const [list, kind] of [[CLIENT_FILES, 'client'], [PANE_FILES, 'pane']]) {
  for (const file of list) {
    test(`${kind === 'pane' ? '聊天分頁畫面檔只讀 atom' : '用戶端模組只做收送'}、不含別的出口：${file}`, async () => {
      const source = await readFile(hooks(file), 'utf8')
      assert.deepEqual(scanSource(source, kind), [], file)
      // 本地 import 只准純函式檔：否則把 $ 或明文交給沒檢查過的檔案，等於繞過這裡
      for (const spec of localValueImports(source)) {
        const name = spec.replace(/^\.\//, '') + '.ts'
        assert.ok(PURE_FILES.includes(name), `${file} import 了 ${spec}，它不在 PURE_FILES（先把它加進清單並通過掃描）`)
      }
    })
  }
}
