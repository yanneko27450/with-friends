// CHAT-4W：接線檔（chat-register.tsx）的靜態檢查，用 Node 跑（`claude plugin test` 不會跑它）：
//   node --test mod/tests/chat-iso-wiring.node.test.mjs      （Node 22.18 以上或 24：直接載入 .ts）
// 外掛只准一個 hooks 模組、$ 又不能傳進別的模組，所以所有碰 $ 的聊天程式都在 chat-register.tsx 這一個檔案裡。
// 這支檢查它能用的出口剛好那幾種（static-scan.ts 的 WIRING_ALLOWED 逐條放行，其餘照 SINKS 全擋），而且每一條放行都有反向例。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { localValueImports, scanSource } from './fixtures/chat-iso/static-scan.ts'

const hooks = name => new URL(`../hooks/${name}`, import.meta.url)
const WIRING_FILES = ['chat-register.tsx']
/** 接線檔可以 import 的本地檔（都是純函式檔或已掃描過的小工具；chat-iso-static.node.test.mjs 的 PURE_FILES 掃過前者） */
const ALLOWED_IMPORTS = new Set([
  'chat-capability', 'chat-controller', 'chat-http-map', 'chat-client', 'chat-members', 'chat-pane', 'chat-provision', 'chat-strings', 'chat-sync', 'chat-view', 'chat-wire-strings',
  'dm-strings', 'relay-url', 'response-signing', 'taxonomy',
])

const rules = code => scanSource(code, 'wiring').map(f => f.rule)

test('接線檔掃描器：放行的出口剛好那幾種', () => {
  const fine = [
    "on('ui.render', { component: 'Pane', requestId: 'friends-chat' }, async ($, e) => 1)",
    "$.ui.toast(wireText('newMessageNotice', lang))",
    'await $.ui.ask(question, { header: x, options: [a, b] })',
    "const res = await $.http.fetch(origin + path, { method: 'POST' })",
    'const v = await $.store.get(VAULT_KEY)',
    'await $.store.set(VAULT_KEY, vault)',
    'await $.store.set(LEASE_KEY, { conn, until })',
    'await $.store.delete(LEASE_KEY)',
    'await $.store.delete(VAULT_KEY)',
    'await update($, chatAtom, () => view)',
    'const view = await read($, chatAtom)',
  ]
  for (const code of fine) assert.deepEqual(scanSource(code, 'wiring'), [], code)
})

test('接線檔掃描器：其餘照 SINKS 全擋（每一條放行都有反向例）', () => {
  const bad = [
    ['其他 hook', "on('prompt.section', async () => ({ text }))", 'hook-answer'],
    ['別的 requestId 的畫面', "on('ui.render', { component: 'Pane', requestId: 'friends' }, f)", 'hook-answer'],
    ['萬用 hook', "on('*', f)", 'hook-answer'],
    ['toast 帶訊息', '$.ui.toast(m.text)', 'ui-toast'],
    ['toast 帶別的固定句子', "$.ui.toast(wireText('relayBad', lang))", 'ui-toast'],
    ['notify', '$.ui.notify(m.text)', 'ui-toast'],
    ['日誌', '$.ui.log(m.text)', 'ui-log'],
    ['console', 'console.log(m.text)', 'console'],
    ['複製', '$.ui.copy({ text: m.text })', 'ui-copy'],
    ['開面板', "await $.ui.open({ id: 'x', title: m.senderName })", 'ui-pane-meta'],
    ['ask 帶訊息', 'await $.ui.ask(m.text, { options: [a] })', 'ui-pane-meta'],
    ['store 寫別的鍵', "await $.store.set('chat', m.text)", 'persist'],
    ['store 刪別的鍵', "await $.store.delete('x')", 'persist'],
    ['寫檔', 'await $.fs.write(p, m.text)', 'persist'],
    ['寫狀態', 'await $.state.set(ref, m.text)', 'persist'],
    ['寫對話', 'await $.session.append({ message: m })', 'session'],
    ['叫模型', 'await $.model.classify(m.text, [a])', 'model'],
    ['子行程', 'await $.process.run([a, m.text])', 'process'],
    ['指令輸出', 'await $.command.run({ command: x })', 'command-out'],
    ['裸 fetch', 'await fetch(url)', 'network'],
    ['WebSocket', 'new WebSocket(u)', 'network'],
    ['MCP', 'await $.mcp.call(tool, { text })', 'mcp'],
    ['朗讀', 'await $.audio.speak(m.text)', 'audio'],
    ['動態程式碼', 'new Function("return 1")', 'dynamic-code'],
    ['瀏覽器儲存', 'localStorage.setItem(k, v)', 'browser-storage'],
    ['跨行鏈', 'await $.ui\n  .toast(m.text)', 'ui-toast'],
    ['讀檔（UNC 路徑）', 'await $.fs.read(p)', 'fs-path'],
  ]
  for (const [name, code, rule] of bad) assert.ok(rules(code).includes(rule), `接線檔該抓到 ${rule}（${name}）：${code}；實際 ${JSON.stringify(rules(code))}`)
})

for (const file of WIRING_FILES) {
  test(`接線檔只用放行的出口：${file}`, async () => {
    const source = await readFile(hooks(file), 'utf8')
    assert.deepEqual(scanSource(source, 'wiring'), [], file)
    for (const spec of localValueImports(source)) assert.ok(ALLOWED_IMPORTS.has(spec.replace(/^\.\//, '')), `${file} import 了 ${spec}，它不在接線檔可以 import 的清單裡`)
    // ask 的題目一律來自 DM_STRINGS 的固定句子；toast 與 on 都只有一個（掃描器逐條放行，這裡再數一次）
    for (const m of source.matchAll(/await ask\(([^)]*)\)/g)) assert.match(m[1], /^DM_STRINGS\[lang\]\.\w+$/, 'ask 的題目要是 DM_STRINGS 的固定句子')
    assert.equal((source.match(/\.ui\.toast\(/g) ?? []).length, 1, '只有一個 toast')
    assert.equal((source.match(/(^|[^\w$])on\(/gm) ?? []).length, 1, '只登記一個 hook')
    assert.equal((source.match(/\.store\.set\(/g) ?? []).length, 3, 'store.set 只有保管庫（存檔、第一次建立）與租約三處')
    assert.ok(!/requestId:\s*CHAT_PANE\b/.test(source), 'requestId 要寫字面字串（validate 才讀得到）')
  })
}

test('聊天分頁的 requestId：接線檔寫死的字串、chat-view.ts 的常數、朋友列表按鈕開的 id 是同一個', async () => {
  const view = await readFile(hooks('chat-view.ts'), 'utf8')
  const wiring = await readFile(hooks('chat-register.tsx'), 'utf8')
  const id = /export const CHAT_PANE_ID = '([^']+)'/.exec(view)?.[1]
  assert.equal(id, 'friends-chat')
  assert.ok(wiring.includes(`requestId: '${id}'`))
  assert.ok(wiring.includes(`const CHAT_PANE = '${id}'`))
  assert.notEqual(id, 'friends', '聊天分頁要有自己獨立的 requestId')
})
