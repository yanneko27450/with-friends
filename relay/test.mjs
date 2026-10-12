// 中繼測試：照使用者會走的路徑打一遍。
// 用法：node relay/test.mjs                → 開一個新的本機中繼（隨機 port、不存檔）來測
//       node relay/test.mjs --base <網址>  → 測已經在跑的中繼（例：wrangler dev 的 Worker 版）
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { MAX_MEMBERS, createGroup, join } from './core.mjs'

const baseArg = process.argv.indexOf('--base')
let BASE = baseArg > 0 ? process.argv[baseArg + 1].replace(/\/$/, '') : ''
let server = null
if (!BASE) {
  const PORT = 18789 + Math.floor(Math.random() * 1000)
  BASE = `http://127.0.0.1:${PORT}`
  server = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve, reject) => {
    server.stdout.once('data', resolve)
    server.once('exit', code => reject(new Error(`中繼沒起來（exit ${code}）`)))
  })
}
console.log(`測試對象：${BASE}`)

const auth = m => `Bearer ${m.groupId}.${m.memberId}.${m.memberKey}`
async function call(method, path, body, m, rawBody) {
  const headers = { 'content-type': 'application/json' }
  if (m) headers.authorization = typeof m === 'string' ? m : auth(m)
  const res = await fetch(BASE + path, {
    method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  })
  return { status: res.status, data: await res.json() }
}

let passed = 0
const failed = []
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed.push(name)
    console.log(`  ✗ ${name}\n    ${err.message.split('\n').join('\n    ')}`)
  }
}

let alice, bob, carol
try {
  await check('建群組：建立者拿到邀請碼與自己的金鑰', async () => {
    const r = await call('POST', '/groups', { name: 'Alice' })
    assert.equal(r.status, 200)
    assert.ok(r.data.invite && r.data.memberKey && r.data.isOwner)
    alice = r.data
  })
  await check('兩個人用邀請碼加入', async () => {
    const b = await call('POST', '/join', { invite: alice.invite, name: 'Bob' })
    const c = await call('POST', '/join', { invite: alice.invite, name: 'Carol' })
    assert.equal(b.status, 200)
    assert.equal(c.status, 200)
    assert.equal(b.data.isOwner, false)
    bob = b.data
    carol = c.data
  })
  await check('送清單內代碼的動態，好友看得到代碼', async () => {
    const s = await call('POST', '/status', { state: 'working', action: 'fixing-bugs', subject: 'website' }, alice)
    assert.equal(s.status, 200)
    const f = await call('GET', '/friends', undefined, bob)
    assert.equal(f.status, 200)
    const a = f.data.members.find(m => m.name === 'Alice')
    assert.deepEqual([a.presence, a.action, a.subject], ['working', 'fixing-bugs', 'website'])
    assert.equal(f.data.members.length, 3)
    assert.equal(f.data.members.filter(m => m.isMe).length, 1)
  })
  await check('好友列表不回任何自由文字動態欄位', async () => {
    const f = await call('GET', '/friends', undefined, carol)
    for (const m of f.data.members) {
      assert.deepEqual(Object.keys(m).sort(), ['action', 'activityAgoSec', 'id', 'isMe', 'isOwner', 'name', 'presence', 'seenAgoSec', 'subject'])
    }
  })
  const aliceSeenBy = async viewer => (await call('GET', '/friends', undefined, viewer)).data.members.find(m => m.name === 'Alice')
  await check('只送心跳（不給代碼）→ 保留舊動態', async () => {
    await call('POST', '/status', { state: 'idle' }, alice)
    const a = await aliceSeenBy(bob)
    assert.deepEqual([a.presence, a.action, a.subject], ['idle', 'fixing-bugs', 'website'])
  })
  await check('暫停分享（明確送 paused）→ 動態清空', async () => {
    assert.equal((await call('POST', '/status', { state: 'idle', paused: true }, alice)).status, 200)
    const a = await aliceSeenBy(bob)
    assert.deepEqual([a.presence, a.action, a.subject, a.activityAgoSec], ['idle', '', '', null])
  })
  await check('同一人兩個對話：一個有動態、一個只送心跳，好友看到的動態不跳（10-11 抓到的 bug）', async () => {
    const A = { conn: 'convAAAAAAAA' }
    const B = { conn: 'convBBBBBBBB' }
    assert.equal((await call('POST', '/status', { ...A, state: 'working', action: 'setting-up', subject: 'ai-agent' }, alice)).status, 200)
    const first = await aliceSeenBy(bob)
    for (let i = 0; i < 4; i++) {
      assert.equal((await call('POST', '/status', { ...B, state: 'idle' }, alice)).status, 200)
      let a = await aliceSeenBy(bob)
      assert.deepEqual([a.action, a.subject], ['setting-up', 'ai-agent'], `B 心跳第 ${i + 1} 次後`)
      assert.equal((await call('POST', '/status', { ...A, state: 'working' }, alice)).status, 200)
      a = await aliceSeenBy(bob)
      assert.deepEqual([a.action, a.subject], ['setting-up', 'ai-agent'], `A 心跳第 ${i + 1} 次後`)
      // 動態沒換，時間也不能被心跳重設
      assert.ok(a.activityAgoSec >= first.activityAgoSec)
    }
  })
  await check('在線狀態：任一對話工作中就是工作中，全部結束才離線', async () => {
    const A = { conn: 'convAAAAAAAA' }
    const B = { conn: 'convBBBBBBBB' }
    await call('POST', '/status', { ...A, state: 'working' }, alice)
    await call('POST', '/status', { ...B, state: 'idle' }, alice)
    assert.equal((await aliceSeenBy(bob)).presence, 'working', 'A 工作、B 閒置')
    await call('POST', '/status', { ...B, state: 'idle' }, alice)
    assert.equal((await aliceSeenBy(bob)).presence, 'working', 'B 再送一次閒置也不能蓋掉 A')
    await call('POST', '/status', { ...A, state: 'offline' }, alice)
    assert.equal((await aliceSeenBy(bob)).presence, 'idle', 'A 結束、B 還開著')
    await call('POST', '/status', { ...B, state: 'offline' }, alice)
    await call('POST', '/status', { state: 'offline' }, alice) // 舊版（不帶 conn）的連線也收掉
    assert.equal((await aliceSeenBy(bob)).presence, 'offline', '全部結束')
    const a = await aliceSeenBy(bob)
    assert.deepEqual([a.action, a.subject], ['setting-up', 'ai-agent'], '離線不清動態（上線後接著顯示，離線時 pane 本來就不畫）')
  })
  await check('送狀態時順便回好友列表，欄位和 /friends 一樣、不含連線 id（cost-2）', async () => {
    const s = await call('POST', '/status', { conn: 'convCCCCCCCC', state: 'idle' }, bob)
    assert.equal(s.status, 200)
    assert.equal(s.data.ok, true)
    const f = await call('GET', '/friends', undefined, bob)
    assert.deepEqual(s.data.members.map(m => m.name).sort(), f.data.members.map(m => m.name).sort())
    for (const m of s.data.members) {
      assert.deepEqual(Object.keys(m).sort(), ['action', 'activityAgoSec', 'id', 'isMe', 'isOwner', 'name', 'presence', 'seenAgoSec', 'subject'])
    }
    assert.ok(!JSON.stringify(s.data).includes('conv'), '回應裡出現連線 id')
  })
  await check('paused／conn 欄位亂給被拒（conn 不能拿來夾帶文字）', async () => {
    for (const body of [
      { state: 'idle', paused: 'yes' },
      { state: 'idle', paused: true, action: 'learning', subject: 'game' },
      { state: 'idle', conn: 'hi Bob 我在修 Alice 公司的網站' },
      { state: 'idle', conn: 'short' },
      { state: 'idle', conn: 12345678 },
      { state: 'idle', conn: 'x'.repeat(65) },
    ]) {
      const r = await call('POST', '/status', body, alice)
      assert.equal(r.status, 400, JSON.stringify(body))
    }
  })
  await check('錯的金鑰被拒', async () => {
    const r = await call('GET', '/friends', undefined, { ...bob, memberKey: 'x'.repeat(43) })
    assert.equal(r.status, 401)
    const r2 = await call('GET', '/friends', undefined, 'Bearer garbage')
    assert.equal(r2.status, 401)
    const r3 = await call('GET', '/friends')
    assert.equal(r3.status, 401)
  })
  await check('清單外代碼被拒（包含自由文字、只給一半）', async () => {
    for (const body of [
      { state: 'working', action: '在修 Alice 公司的網站', subject: 'website' },
      { state: 'working', action: 'fixing-bugs', subject: 'secret-project-x' },
      { state: 'working', action: 'fixing-bugs' },
      { state: 'working', action: 1, subject: 2 },
    ]) {
      const r = await call('POST', '/status', body, bob)
      assert.equal(r.status, 400, JSON.stringify(body))
    }
    const f = await call('GET', '/friends', undefined, alice)
    assert.equal(f.data.members.find(m => m.name === 'Bob').action, '')
  })
  await check('夾帶舊版 summary 等額外欄位被拒', async () => {
    const r = await call('POST', '/status', { state: 'working', action: 'learning', subject: 'game', summary: 'hello' }, bob)
    assert.equal(r.status, 400)
  })
  await check('超大請求被拒', async () => {
    const r = await call('POST', '/status', undefined, bob, JSON.stringify({ state: 'idle', pad: 'x'.repeat(10_000) }))
    assert.equal(r.status, 400)
  })
  await check('名字裡的控制字元與雙向字元被清掉', async () => {
    const r = await call('POST', '/join', { invite: alice.invite, name: 'E‮ve\u0007' })
    assert.equal(r.status, 200)
    const f = await call('GET', '/friends', undefined, alice)
    assert.ok(f.data.members.some(m => m.name === 'Eve'))
    await call('POST', '/leave', {}, r.data)
  })
  // ui-18 F（reviews/ui-14_guide_review_1.md）：零寬字元、阿拉伯字母標記、C1 控制字元也要擋，不然名字可以偽裝成別人
  await check('名字裡的零寬字元、U+061C、C1 控制字元被清掉', async () => {
    const r = await call('POST', '/join', { invite: alice.invite, name: '​Z‌e‍d‎‏؜\u0085\u009f⁦﻿' })
    assert.equal(r.status, 200)
    const f = await call('GET', '/friends', undefined, alice)
    assert.ok(f.data.members.some(m => m.name === 'Zed'), JSON.stringify(f.data.members.map(m => m.name)))
    await call('POST', '/leave', {}, r.data)
  })
  await check('錯的邀請碼被拒', async () => {
    const r = await call('POST', '/join', { invite: alice.groupId + '.wrong', name: 'Mallory' })
    assert.equal(r.status, 403)
  })
  await check('群組 id 含 - 的邀請碼也能加入（10-11 抓到的 bug：約 17% 群組加不進去）', async () => {
    let g
    for (let i = 0; i < 300 && !g; i++) {
      const r = await call('POST', '/groups', { name: 'Probe' })
      if (r.data.groupId.includes('-')) g = r.data
      else await call('POST', '/leave', {}, r.data)
    }
    assert.ok(g, '300 次都沒產生含 - 的群組 id')
    const j = await call('POST', '/join', { invite: g.invite, name: 'Joiner' })
    assert.equal(j.status, 200)
  })
  await check('非建立者不能踢人、不能換邀請碼', async () => {
    assert.equal((await call('POST', '/kick', { memberId: carol.memberId }, bob)).status, 403)
    assert.equal((await call('POST', '/invite/rotate', {}, bob)).status, 403)
  })
  await check('踢人：被踢的金鑰失效、舊邀請碼失效', async () => {
    const k = await call('POST', '/kick', { memberId: carol.memberId }, alice)
    assert.equal(k.status, 200)
    assert.equal((await call('GET', '/friends', undefined, carol)).status, 401)
    assert.equal((await call('POST', '/join', { invite: alice.invite, name: 'Carol2' })).status, 403)
    alice.invite = k.data.invite
    assert.equal((await call('POST', '/join', { invite: alice.invite, name: 'Dan' })).status, 200)
  })
  await check('離開：自己的金鑰失效，好友列表少一個人', async () => {
    const before = (await call('GET', '/friends', undefined, alice)).data.members.length
    assert.equal((await call('POST', '/leave', {}, bob)).status, 200)
    assert.equal((await call('GET', '/friends', undefined, bob)).status, 401)
    const after = (await call('GET', '/friends', undefined, alice)).data.members.length
    assert.equal(after, before - 1)
  })
  // 直接測共用核心：用 HTTP 塞滿會撞到「加入每小時 10 次」的限流
  await check('群組最多 10 人（主人 10-11 定案：免費額度要 2 倍餘裕），第 11 人被拒', async () => {
    assert.equal(MAX_MEMBERS, 10)
    const made = await createGroup({ name: 'Owner' }, 0)
    const invite = made.reply[1].invite
    for (let i = 2; i <= MAX_MEMBERS; i++) {
      assert.equal((await join(made.g, made.groupId, { invite, name: `P${i}` }, 0))[0], 200)
    }
    const [status, body] = await join(made.g, made.groupId, { invite, name: 'Extra' }, 0)
    assert.equal(status, 403)
    assert.equal(body.error, '群組滿了')
    assert.equal(Object.keys(made.g.members).length, 10)
  })
} finally {
  if (server) {
    const exited = new Promise(resolve => server.once('exit', resolve))
    server.kill()
    await exited
  }
}

console.log(`\n${passed} 通過，${failed.length} 失敗`)
// 不用 process.exit：Windows 上 fetch 的連線還沒關完就硬退，libuv 會斷言失敗（exit 9）
process.exitCode = failed.length ? 1 : 0
