// 中繼測試：照使用者會走的路徑打一遍。
// 用法：node relay/test.mjs                → 開一個新的本機中繼（隨機 port、不存檔）來測
//       node relay/test.mjs --base <網址>  → 測已經在跑的中繼（例：wrangler dev 的 Worker 版）
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto'
import * as core from './core.mjs'
import { MAX_MEMBERS, MIN_VERSION, createGroup, join } from './core.mjs'
import { ACTIONS, SUBJECTS, ACTION_LABEL } from '../mod/hooks/taxonomy.ts'
import { TEST_RESPONSE_SIGNING } from './test-fixtures/response-signing-key.mjs'
import { fromB64url, responseEnvelope, responseSigner } from './response-signing.mjs'

const SIGNING_ENV = {
  RESPONSE_SIGNING_PRIVATE_KEY: TEST_RESPONSE_SIGNING.privateKeyPkcs8,
  RESPONSE_SIGNING_KEY_ID: TEST_RESPONSE_SIGNING.keyId,
}
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
const testResponsePublicKey = createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(fromB64url(TEST_RESPONSE_SIGNING.publicKey))]), format: 'der', type: 'spki' })
const verifies = (signature, fields) => verifySignature(null, responseEnvelope(fields), testResponsePublicKey, Buffer.from(fromB64url(signature)))

const waitForRelayStart = (child, label, stderr = () => '') => new Promise((resolve, reject) => {
  let settled = false
  const finish = error => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    child.stdout?.off('data', onData)
    child.off('exit', onExit)
    error ? reject(error) : resolve()
  }
  const onData = () => finish()
  const onExit = code => finish(new Error(`${label} 啟動前結束（exit ${code}）${stderr() ? `：${stderr()}` : ''}`))
  const timer = setTimeout(() => finish(new Error(`${label} 10 秒內沒有啟動${stderr() ? `：${stderr()}` : ''}`)), 10_000)
  child.stdout?.once('data', onData)
  child.once('exit', onExit)
})

const baseArg = process.argv.indexOf('--base')
let BASE = baseArg > 0 ? process.argv[baseArg + 1].replace(/\/$/, '') : ''
let server = null
if (!BASE) {
  const PORT = 18789 + Math.floor(Math.random() * 1000)
  BASE = `http://127.0.0.1:${PORT}`
  server = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--port', String(PORT), '--test-ip-header'], {
    stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...SIGNING_ENV },
  })
  await waitForRelayStart(server, '主要測試中繼')
}
console.log(`測試對象：${BASE}`)

const auth = m => `Bearer ${m.groupId}.${m.memberId}.${m.memberKey}`
async function call(method, path, body, m, rawBody, ip, version = '0.5.6') {
  const nonce = randomBytes(18).toString('base64url')
  const headers = { 'content-type': 'application/json', 'x-friends-nonce': nonce, 'x-friends-origin': BASE }
  if (ip) headers['x-test-ip'] = ip
  if (ip) headers['cf-connecting-ip'] = ip
  if (version) headers['x-friends-version'] = version // 0.5.6：預設像新版外掛；傳 '' 模擬舊版／沒帶版本
  if (m) headers.authorization = typeof m === 'string' ? m : auth(m)
  const res = await fetch(BASE + path, {
    method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  })
  const text = await res.text()
  assert.equal(res.headers.get('x-friends-nonce'), nonce, '回應 nonce 必須逐字相同')
  assert.ok(res.headers.get('x-friends-key-id'), '回應必須有簽章 key id')
  assert.ok(res.headers.get('x-friends-signature'), '回應必須有簽章')
  const signature = res.headers.get('x-friends-signature')
  const fields = { nonce, origin: BASE, method, path, status: res.status, body: text }
  assert.equal(verifies(signature, fields), true, 'Node／Worker 中繼回應簽章必須可驗')
  for (const [field, changed] of [
    ['nonce', nonce + 'A'], ['origin', BASE + '/other'], ['method', method === 'GET' ? 'POST' : 'GET'],
    ['path', path + '/other'], ['status', res.status === 200 ? 201 : 200], ['body', text + ' '],
  ]) assert.equal(verifies(signature, { ...fields, [field]: changed }), false, `改動 ${field} 後簽章必須失效`)
  return { status: res.status, data: JSON.parse(text) }
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

let alice, bob, carol, coder
try {
  await check('Node／Worker 使用同一份固定 response envelope 位元組（sec-16b C parity）', () => {
    const fields = { nonce: 'ABCDEFGHIJKLMNOPQRSTUVWX', origin: 'https://relay.example', method: 'POST', path: '/status', status: 207, body: '{"ok":true}' }
    const expected = '["friends-response-v1","ABCDEFGHIJKLMNOPQRSTUVWX","https://relay.example","POST","/status",207,"{\\"ok\\":true}"]'
    assert.equal(Buffer.from(responseEnvelope(fields)).toString('utf8'), expected)
    const nodeSource = readFileSync(fileURLToPath(new URL('./server.mjs', import.meta.url)), 'utf8')
    const workerSource = readFileSync(fileURLToPath(new URL('./worker/src/index.mjs', import.meta.url)), 'utf8')
    assert.match(nodeSource, /responseSigner/)
    assert.match(workerSource, /responseSigner/)
  })
  await check('簽章私鑰只接受 canonical base64url（sec-16b C）', async () => {
    await assert.rejects(() => responseSigner(TEST_RESPONSE_SIGNING.privateKeyPkcs8 + '=', TEST_RESPONSE_SIGNING.keyId), /PKCS#8 base64url/)
  })
  await check('建群組：建立者拿到邀請碼與自己的金鑰', async () => {
    const r = await call('POST', '/groups', { name: 'Alice' })
    assert.equal(r.status, 200)
    assert.ok(r.data.invite && r.data.memberKey && r.data.isOwner)
    alice = r.data
  })
  await check('建群組不給 groupName（舊版 mod）→ 中繼仍用中文後備「名字 的群組」（ui-10）', async () => {
    const r = await call('POST', '/groups', { name: 'Old' })
    assert.equal(r.status, 200)
    assert.equal(r.data.groupName, 'Old 的群組')
    const g = await call('POST', '/groups', { name: 'New', groupName: "New's group" })
    assert.equal(g.data.groupName, "New's group")
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
  await check('好友列表和送狀態的回應都有 minVersion，格式 x.y.z（ver-2）', async () => {
    const f = await call('GET', '/friends', undefined, bob)
    assert.match(f.data.minVersion, /^\d+\.\d+\.\d+$/)
    assert.equal(f.data.minVersion, MIN_VERSION)
    const s = await call('POST', '/status', { state: 'idle' }, bob)
    assert.equal(s.data.minVersion, MIN_VERSION)
  })
  await check('好友列表不回任何自由文字動態欄位', async () => {
    const f = await call('GET', '/friends', undefined, carol)
    for (const m of f.data.members) {
      assert.deepEqual(Object.keys(m).sort(), ['action', 'activityAgoSec', 'avatar', 'id', 'isMe', 'isOwner', 'name', 'presence', 'seenAgoSec', 'subject', 'version'])
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
    // 0.5.6：暫停是成員層級，要明確送 paused: false 才解除（接下來的測試要看得到 working）
    assert.equal((await call('POST', '/status', { state: 'idle', paused: false }, alice)).status, 200)
  })
  await check('暫停分享 → 好友只看得到在線：送 working＋paused 也只顯示 idle，沒有動態與時間（0.5.6 隱私承諾）', async () => {
    const P = { conn: 'convPPPPPPPP' }
    assert.equal((await call('POST', '/status', { ...P, state: 'working', action: 'learning', subject: 'game' }, alice)).status, 200)
    assert.equal((await aliceSeenBy(bob)).presence, 'working', '前提：沒暫停時好友看得到工作中')
    assert.equal((await call('POST', '/status', { ...P, state: 'working', paused: true }, alice)).status, 200)
    const a = await aliceSeenBy(bob)
    assert.deepEqual([a.presence, a.action, a.subject, a.activityAgoSec], ['idle', '', '', null], '暫停後 working 不外漏')
    // 同一人另一個還沒讀到暫停的對話（working）：一樣降成 idle
    const Q = { conn: 'convQQQQQQQQ' }
    assert.equal((await call('POST', '/status', { ...Q, state: 'working' }, alice)).status, 200)
    assert.equal((await aliceSeenBy(bob)).presence, 'idle', '成員層級暫停：另一個對話晚到的 working 心跳也不外漏（不用等下一次 paused）')
    assert.equal((await call('POST', '/status', { ...P, state: 'idle', paused: true }, alice)).status, 200)
    assert.equal((await aliceSeenBy(bob)).presence, 'idle', '別的對話的 working 也不外漏')
    await call('POST', '/status', { ...Q, state: 'offline' }, alice)
    await call('POST', '/status', { ...P, state: 'offline' }, alice)
    await call('POST', '/status', { ...P, state: 'idle', paused: false }, alice) // 明確繼續，後面的測試才看得到 working
    await call('POST', '/status', { ...P, state: 'offline' }, alice)
  })
  await check('暫停是成員層級（0.5.6）：兩個對話交錯送心跳，一個送 paused 之後另一個晚到的 working／動態都不外漏，直到明確 resume', async () => {
    const A = { conn: 'convPausAAAA' }
    const B = { conn: 'convPausBBBB' }
    const seen = async () => { const a = await aliceSeenBy(bob); return [a.presence, a.action, a.subject, a.activityAgoSec] }
    // 前提：沒暫停時兩個對話的 working 與動態都看得到
    assert.equal((await call('POST', '/status', { ...A, state: 'working', action: 'learning', subject: 'game' }, alice)).status, 200)
    assert.equal((await call('POST', '/status', { ...B, state: 'working' }, alice)).status, 200)
    assert.deepEqual((await seen()).slice(0, 3), ['working', 'learning', 'game'], '前提：沒暫停時看得到')
    // A 暫停；B 還沒讀到暫停，之後才送來的 working 心跳（R056b 的空窗）
    assert.equal((await call('POST', '/status', { ...A, state: 'idle', paused: true }, alice)).status, 200)
    assert.deepEqual(await seen(), ['idle', '', '', null], 'A 暫停後')
    assert.equal((await call('POST', '/status', { ...B, state: 'working' }, alice)).status, 200)
    assert.deepEqual(await seen(), ['idle', '', '', null], 'B 晚到的 working 心跳不能讓好友看到工作中')
    // B 晚到的新動態也不收；A 沒帶 paused 的心跳（working）也一樣
    assert.equal((await call('POST', '/status', { ...B, state: 'working', action: 'fixing-bugs', subject: 'website' }, alice)).status, 200)
    assert.equal((await call('POST', '/status', { ...A, state: 'working' }, alice)).status, 200)
    assert.deepEqual(await seen(), ['idle', '', '', null], 'B 晚到的動態與 A 沒帶 paused 的心跳都不外漏')
    assert.equal((await call('GET', '/friends', undefined, bob)).data.members.find(m => m.name === 'Alice').activityAgoSec, null)
    // 暫停期間回給自己的列表也一樣
    assert.equal((await call('POST', '/status', { ...B, state: 'working' }, alice)).data.members.find(m => m.isMe).presence, 'idle')
    // 明確 resume（任一對話送 paused: false）後才恢復；之後 B 的 working 看得到、動態收得到
    assert.equal((await call('POST', '/status', { ...A, state: 'idle', paused: false }, alice)).status, 200)
    assert.equal((await call('POST', '/status', { ...B, state: 'working', action: 'fixing-bugs', subject: 'website' }, alice)).status, 200)
    assert.deepEqual((await seen()).slice(0, 3), ['working', 'fixing-bugs', 'website'], 'resume 後恢復')
    await call('POST', '/status', { ...A, state: 'offline' }, alice)
    await call('POST', '/status', { ...B, state: 'offline' }, alice)
  })
  await check('舊版外掛（沒帶版本或 0.5.6 以前）從不送 paused:false：沒帶 paused 的心跳＝繼續，不會被卡在暫停；0.5.6 以上沒帶 paused 不解除', async () => {
    const L = { conn: 'convLegacy001' }
    const seen = async () => (await aliceSeenBy(bob)).presence
    for (const v of ['', '0.5.5', '0.4.0', 'web']) {
      assert.equal((await call('POST', '/status', { ...L, state: 'idle', paused: true }, alice, undefined, undefined, v)).status, 200)
      assert.equal((await call('POST', '/status', { ...L, state: 'working' }, alice, undefined, undefined, v)).status, 200)
      assert.equal(await seen(), 'working', `版本「${v}」按過暫停、再按繼續（只是不再帶 paused）後要能看到工作中`)
    }
    for (const v of ['0.5.6', '0.5.7', '0.6.0', '1.0.0']) {
      assert.equal((await call('POST', '/status', { ...L, state: 'idle', paused: true }, alice, undefined, undefined, v)).status, 200)
      assert.equal((await call('POST', '/status', { ...L, state: 'working' }, alice, undefined, undefined, v)).status, 200)
      assert.equal(await seen(), 'idle', `版本 ${v}：沒帶 paused 不解除`)
      assert.equal((await call('POST', '/status', { ...L, state: 'working', paused: false }, alice, undefined, undefined, v)).status, 200)
      assert.equal(await seen(), 'working')
    }
    await call('POST', '/status', { ...L, state: 'offline' }, alice)
  })
  await check('暫停旗標：算在成員身上、要寫進資料庫（重啟後仍暫停）；亂值被拒且不動旗標', async () => {
    const g = { ownerId: 'o', members: { o: { name: 'O', conns: {}, action: '', subject: '', activityAt: 0, seenAt: 0 } } }
    const mem = g.members.o
    assert.equal(core.status(g, 'o', mem, { conn: 'convUnit0001', state: 'working' }, 1000, '0.5.6')[2], false)
    assert.equal(core.status(g, 'o', mem, { conn: 'convUnit0001', state: 'working', paused: true }, 2000, '0.5.6')[2], true, '開始暫停要寫進資料庫')
    assert.equal(mem.paused, true)
    assert.equal(core.status(g, 'o', mem, { conn: 'convUnit0002', state: 'working', paused: 'no' }, 3000, '0.5.6')[0], 400)
    assert.equal(mem.paused, true, '被拒的請求不動旗標')
    assert.equal(core.presence(mem, 3000), 'idle')
    mem.conns.convUnit0009 = { state: 'working', seenAt: 3000 } // 就算有連線直接記著 working（例如重啟前存的），讀的時候也只算在線
    assert.equal(core.presence(mem, 3000), 'idle', 'presence 讀取時也擋')
    assert.equal(core.status(g, 'o', mem, { conn: 'convUnit0002', state: 'working', paused: false }, 4000, '0.5.6')[2], true, '繼續也要寫進資料庫')
    assert.equal(mem.paused, undefined)
    assert.equal(core.status(g, 'o', mem, { conn: 'convUnit0002', state: 'working', paused: false }, 5000, '0.5.6')[2], false, '重複繼續不重寫')
  })
  // 0.5.8 資安 ①：暫停／恢復請求先後顛倒。外掛每次按暫停／繼續產生一個單調遞增的 pauseSeq，中繼只接受比已存更大的；
  // 舊請求（序號 ≤ 已存）晚到，paused 欄位整個忽略，不能把暫停蓋回恢復（隱私承諾：暫停了就是暫停了）
  // 用另一個群組，免得這個成員留下的序號影響上面沒帶序號的舊版測試
  await check('0.5.8 暫停序號：晚到的舊「恢復」不能解除新的暫停（含它夾帶的動態）；晚到的舊「暫停」不能蓋掉新的恢復；同序號重送沒事', async () => {
    const dana = (await call('POST', '/groups', { name: 'Dana' })).data
    const erin = (await call('POST', '/join', { invite: dana.invite, name: 'Erin' }, undefined, undefined, '192.0.2.201')).data // 另一個 IP：加入每小時 10 次的額度留給後面的測試
    const D = { conn: 'convSeqDANA01' }
    const seen = async () => {
      const a = (await call('GET', '/friends', undefined, erin)).data.members.find(m => m.name === 'Dana')
      return [a.presence, a.action, a.subject]
    }
    const send = (body, version = '0.5.8') => call('POST', '/status', { ...D, ...body }, dana, undefined, undefined, version)
    const WORK = { state: 'working', action: 'fixing-bugs', subject: 'website' }
    // 先恢復（序號 100）→ 看得到
    assert.equal((await send({ ...WORK, paused: false, pauseSeq: 100 })).status, 200)
    assert.deepEqual(await seen(), ['working', 'fixing-bugs', 'website'])
    // 使用者按暫停（序號 300）→ 只看得到在線
    assert.equal((await send({ state: 'idle', paused: true, pauseSeq: 300 })).status, 200)
    assert.deepEqual(await seen(), ['idle', '', ''])
    // 更早按的「恢復」（序號 200）網路慢、晚到：必須被忽略，仍是暫停（修前這裡會被解除、好友看到 working）
    assert.equal((await send({ state: 'working', paused: false, pauseSeq: 200 })).status, 200)
    assert.deepEqual(await seen(), ['idle', '', ''], '晚到的舊恢復不能解除暫停')
    // 舊恢復夾帶動態也不收
    assert.equal((await send({ ...WORK, action: 'learning', subject: 'game', paused: false, pauseSeq: 200 })).status, 200)
    assert.deepEqual(await seen(), ['idle', '', ''], '晚到的舊恢復夾帶的動態不外漏')
    // 同序號重送暫停（逾時重試）沒事；同序號但值相反（不該發生）也不能解除
    assert.equal((await send({ state: 'idle', paused: true, pauseSeq: 300 })).status, 200)
    assert.equal((await send({ state: 'working', paused: false, pauseSeq: 300 })).status, 200)
    assert.deepEqual(await seen(), ['idle', '', ''], '同序號不同值不能解除暫停')
    // 沒帶 paused 的心跳照舊不解除
    assert.equal((await send({ state: 'working' })).status, 200)
    assert.deepEqual(await seen(), ['idle', '', ''])
    // 使用者再按恢復（序號 400）→ 解除；之後晚到的舊暫停（序號 350）不能把它蓋回暫停
    assert.equal((await send({ ...WORK, paused: false, pauseSeq: 400 })).status, 200)
    assert.deepEqual(await seen(), ['working', 'fixing-bugs', 'website'])
    assert.equal((await send({ state: 'working', paused: true, pauseSeq: 350 })).status, 200)
    assert.deepEqual(await seen(), ['working', 'fixing-bugs', 'website'], '晚到的舊暫停不能蓋掉新的恢復')
    // 比較新的暫停（序號 500）照常生效
    assert.equal((await send({ state: 'idle', paused: true, pauseSeq: 500 })).status, 200)
    assert.deepEqual(await seen(), ['idle', '', ''])
    await send({ state: 'offline' })
  })
  await check('0.5.8 暫停序號：用過序號的成員，沒帶序號的恢復（舊版外掛）不能解除暫停，沒帶序號的暫停仍然有效；格式錯被拒且不動旗標', async () => {
    const fay = (await call('POST', '/groups', { name: 'Fay' })).data
    const gus = (await call('POST', '/join', { invite: fay.invite, name: 'Gus' }, undefined, undefined, '192.0.2.202')).data
    const F = { conn: 'convSeqFAYY001' }
    const seen = async () => {
      const a = (await call('GET', '/friends', undefined, gus)).data.members.find(m => m.name === 'Fay')
      return [a.presence, a.action, a.subject]
    }
    const send = (body, version = '0.5.8') => call('POST', '/status', { ...F, ...body }, fay, undefined, undefined, version)
    const WORK = { state: 'working', action: 'fixing-bugs', subject: 'website' }
    // 沒用過序號的成員：舊版行為不變（沒帶序號的恢復有效）
    assert.equal((await send({ state: 'idle', paused: true }, '0.5.7')).status, 200)
    assert.equal((await send({ ...WORK, paused: false }, '0.5.7')).status, 200)
    assert.deepEqual(await seen(), ['working', 'fixing-bugs', 'website'])
    // 用過序號之後：沒帶序號的暫停有效（寧可多暫停）、沒帶序號的恢復（0.5.6／0.5.7）無效
    assert.equal((await send({ state: 'idle', paused: true, pauseSeq: 1000 })).status, 200)
    assert.equal((await send({ state: 'working', paused: false }, '0.5.7')).status, 409, '緩衝期內沒帶序號的恢復：回 409 讓舊外掛下一輪重送（不是 200，不然它以為送到了）')
    assert.deepEqual(await seen(), ['idle', '', ''], '沒帶序號的恢復不能解除有序號的暫停')
    assert.equal((await send({ state: 'working' }, '')).status, 200) // 更舊的外掛：沒帶 paused ＝ 繼續
    assert.deepEqual(await seen(), ['idle', '', ''], '更舊外掛沒帶 paused 的心跳也不能解除')
    assert.equal((await send({ ...WORK, paused: false, pauseSeq: 1001 })).status, 200)
    assert.deepEqual(await seen(), ['working', 'fixing-bugs', 'website'])
    assert.equal((await send({ state: 'working', paused: true }, '0.5.7')).status, 200)
    assert.deepEqual(await seen(), ['idle', '', ''], '沒帶序號的暫停有效')
    // 格式錯：非正整數、非數字、超過安全整數，或沒搭配 paused → 400，旗標不動（現在是暫停）
    for (const bad of [0, -1, 1.5, '5', null, [], {}, 2 ** 53, 1e308]) {
      const r = await send({ state: 'working', paused: false, pauseSeq: bad })
      assert.equal(r.status, 400, `pauseSeq ${JSON.stringify(bad)} 要被拒`)
    }
    assert.equal((await send({ state: 'working', pauseSeq: 2000 })).status, 400, '序號要搭配 paused')
    assert.deepEqual(await seen(), ['idle', '', ''], '被拒的請求不動旗標')
    // 序號被拒之後，正常的更大序號照常
    assert.equal((await send({ ...WORK, paused: false, pauseSeq: 3000 })).status, 200)
    assert.deepEqual(await seen(), ['working', 'fixing-bugs', 'website'])
    await send({ state: 'offline' })
  })
  await check('0.5.8 暫停序號：core.status 單元——序號接受才寫資料庫、舊序號不寫；序號存在成員身上；好友列表不回序號', async () => {
    const g = { ownerId: 'o', members: { o: { name: 'O', conns: {}, action: '', subject: '', activityAt: 0, seenAt: 0 } } }
    const mem = g.members.o
    const send = (b, now) => core.status(g, 'o', mem, { conn: 'convUnit0001', state: 'idle', ...b }, now, '0.5.8')
    assert.equal(send({ paused: true, pauseSeq: 10 }, 1000)[2], true)
    assert.equal(mem.paused, true)
    assert.equal(mem.pauseSeq, 10)
    assert.equal(send({ paused: true, pauseSeq: 10 }, 2000)[2], false, '同序號重送不重寫')
    assert.equal(send({ paused: false, pauseSeq: 9 }, 3000)[2], false, '舊序號不寫')
    assert.equal(mem.paused, true)
    assert.equal(mem.pauseSeq, 10)
    assert.equal(send({ paused: false, pauseSeq: 11 }, 4000)[2], true)
    assert.equal(mem.paused, undefined)
    assert.equal(mem.pauseSeq, 11)
    // 同序號：暫停仍有效（兩個對話同一毫秒各按暫停與繼續會拿到同一個序號，偏向暫停），同序號的繼續不收
    assert.equal(send({ paused: true, pauseSeq: 11 }, 4500)[2], true)
    assert.equal(mem.paused, true, '同序號的暫停要生效')
    assert.equal(send({ paused: false, pauseSeq: 11 }, 4600)[2], false)
    assert.equal(mem.paused, true, '同序號的繼續不能解除')
    // 緩衝期：帶序號的暫停／繼續之後 60 秒內，沒帶序號的明確繼續回 409、不動旗標；期滿後生效（混用舊版對話不會永遠卡在暫停）
    assert.equal(mem.pauseSeqAt, 4000)
    const legacyResume = now => core.status(g, 'o', mem, { conn: 'convUnit0001', state: 'idle', paused: false }, now, '0.5.7')
    assert.equal(legacyResume(4700)[0], 409)
    assert.equal(mem.paused, true)
    assert.equal(legacyResume(4000 + core.LEGACY_RESUME_GRACE_MS - 1)[0], 409)
    const after = legacyResume(4000 + core.LEGACY_RESUME_GRACE_MS)
    assert.deepEqual([after[0], after[2]], [200, true])
    assert.equal(mem.paused, undefined, '緩衝期滿，沒帶序號的繼續生效')
    assert.equal(legacyResume(4100)[0], 200, '成員本來就沒暫停：沒帶序號的繼續是無害的空操作，緩衝期內也照常收（不回 409）')
    for (const v of core.friendsView(g, 'o', 5000).members) assert.equal('pauseSeq' in v, false)
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
      assert.deepEqual(Object.keys(m).sort(), ['action', 'activityAgoSec', 'avatar', 'id', 'isMe', 'isOwner', 'name', 'presence', 'seenAgoSec', 'subject', 'version'])
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
  await check('外掛版本：只收 x.y.z，好友看得到；亂給被拒（ui-19f ②，不能拿來夾帶文字）', async () => {
    const before = await call('GET', '/friends', undefined, bob)
    assert.equal(before.data.members.find(m => m.name === 'Carol').version, '')
    const ok = await call('POST', '/status', { state: 'idle', conn: 'convVVVVVVVV', version: '0.4.0' }, carol)
    assert.equal(ok.status, 200)
    // 之後的心跳不帶版本：保留
    await call('POST', '/status', { state: 'idle', conn: 'convVVVVVVVV' }, carol)
    const f = await call('GET', '/friends', undefined, bob)
    assert.equal(f.data.members.find(m => m.name === 'Carol').version, '0.4.0')
    for (const version of ['1.2', 'v1.2.3', '1.2.3 hi Bob', '123456.0.0', 123, '', '1.2.3\n']) {
      const r = await call('POST', '/status', { state: 'idle', version }, carol)
      assert.equal(r.status, 400, JSON.stringify(version))
    }
    const after = await call('GET', '/friends', undefined, bob)
    assert.equal(after.data.members.find(m => m.name === 'Carol').version, '0.4.0')
  })
  await check('網頁成員（web-2）：只送在線、不帶動態 → 好友看到在線、沒有動態；關頁送 offline 就離線', async () => {
    const w = await call('POST', '/join', { invite: alice.invite, name: 'Web' })
    assert.equal(w.status, 200)
    const s = await call('POST', '/status', { state: 'idle', conn: 'webTabAAAAAA' }, w.data)
    assert.equal(s.status, 200)
    let me = (await call('GET', '/friends', undefined, alice)).data.members.find(m => m.name === 'Web')
    assert.deepEqual([me.presence, me.action, me.subject, me.version], ['idle', '', '', ''])
    await call('POST', '/status', { state: 'offline', conn: 'webTabAAAAAA' }, w.data)
    me = (await call('GET', '/friends', undefined, alice)).data.members.find(m => m.name === 'Web')
    assert.equal(me.presence, 'offline')
    assert.equal((await call('POST', '/leave', {}, w.data)).status, 200)
  })
  await check('頭像：清單外代碼、網址、SVG、自由文字、非字串都被拒 400（ui-22）', async () => {
    for (const avatar of ['dragon', 'Cat', 'https://evil.test/a.png', '<svg onload=alert(1)>', 'data:image/png;base64,AAAA', '🐱', '', 7, null, ['cat'], { code: 'cat' }]) {
      assert.equal((await call('POST', '/status', { state: 'idle', avatar }, carol)).status, 400, JSON.stringify(avatar))
    }
    const c = (await call('GET', '/friends', undefined, bob)).data.members.find(m => m.name === 'Carol')
    assert.equal(c.avatar, '', '被拒的不會存')
  })
  await check('頭像：沒送就照舊（舊版 mod 不壞），好友列表回空字串（ui-22）', async () => {
    assert.equal((await call('POST', '/status', { state: 'idle' }, carol)).status, 200)
    const c = (await call('GET', '/friends', undefined, bob)).data.members.find(m => m.name === 'Carol')
    assert.equal(c.avatar, '')
  })
  await check('頭像：送清單內代碼 → 好友看得到代碼；之後只送心跳不會被清掉（ui-22）', async () => {
    assert.equal((await call('POST', '/status', { state: 'idle', avatar: 'fox' }, carol)).status, 200)
    assert.equal((await call('POST', '/status', { state: 'working' }, carol)).status, 200)
    const c = (await call('GET', '/friends', undefined, bob)).data.members.find(m => m.name === 'Carol')
    assert.equal(c.avatar, 'fox')
    assert.equal((await call('POST', '/status', { state: 'idle', avatar: 'robot' }, carol)).status, 200)
    assert.equal((await call('GET', '/friends', undefined, alice)).data.members.find(m => m.name === 'Carol').avatar, 'robot')
    assert.equal((await call('POST', '/status', { state: 'idle', avatar: 'https://evil.test/x.png' }, carol)).status, 400)
    assert.equal((await call('GET', '/friends', undefined, alice)).data.members.find(m => m.name === 'Carol').avatar, 'robot', '被拒的不會蓋掉原本的')
  })
  await check(`分類代碼：清單上每一組 ${ACTIONS.length}×${SUBJECTS.length} 中繼都收、好友看到的就是那組代碼（core-4）`, async () => {
    const ip = '192.0.2.40'
    // 用一個專門的群組（自己建、不用加入）：不影響其他測試看 Bob 的動態，也不吃「每小時加入 10 次」的額度（--base 時全部同一個 IP）
    coder = (await call('POST', '/groups', { name: 'Coder' }, undefined, undefined, ip)).data
    assert.ok(coder.memberKey)
    for (const action of ACTIONS) {
      for (const subject of SUBJECTS) {
        const r = await call('POST', '/status', { state: 'working', action, subject }, coder, undefined, ip)
        assert.equal(r.status, 200, `${action} · ${subject}`)
        const me = r.data.members.find(m => m.isMe)
        assert.deepEqual([me.action, me.subject], [action, subject])
      }
    }
  })
  await check('分類代碼：清單外（大小寫、空白、顯示文字、只給一半、原型名字）一律 400（core-4）', async () => {
    const ip = '192.0.2.41'
    const bad = [
      ['Fixing-Bugs', 'website'], ['fixing-bugs ', 'website'], [' fixing-bugs', 'website'], ['fixing_bugs', 'website'],
      [ACTION_LABEL.en['fixing-bugs'], 'website'], [ACTION_LABEL['zh-TW']['fixing-bugs'], 'website'],
      ['fixing-bugs', 'Website'], ['fixing-bugs', 'a website'], ['fixing-bugs', 'web'],
      ['__proto__', 'website'], ['toString', 'website'], ['constructor', 'other'], ['fixing-bugs', 'hasOwnProperty'],
      ['fixing-bugs', undefined], [undefined, 'website'], ['fixing-bugs', ''], ['', 'website'],
      ['fixing-bugs\n', 'website'], ['fixing－bugs', 'website'], ['оther', 'other'], ['fixing-bugs\u0000', 'website'], ['other ', 'other'], [true, false],
      [['fixing-bugs'], 'website'], ['fixing-bugs', { code: 'website' }], [1, 'website'], [null, null],
    ]
    for (const [action, subject] of bad) {
      assert.equal((await call('POST', '/status', { state: 'working', action, subject }, coder, undefined, ip)).status, 400, JSON.stringify([action, subject]))
    }
    const me = (await call('GET', '/friends', undefined, coder, undefined, ip)).data.members.find(m => m.isMe)
    assert.deepEqual([me.action, me.subject], [ACTIONS.at(-1), SUBJECTS.at(-1)], '被拒的不會蓋掉上一組')
  })
  // 專門的群組用完就刪（前面兩條失敗也一樣）
  if (coder?.memberKey) assert.equal((await call('POST', '/leave', {}, coder, undefined, '192.0.2.41')).status, 200)
  await check('POST 不是 application/json 被拒 415（別的網站不能借瀏覽者的 IP 塞假成員）', async () => {
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
      const headers = ct ? { 'content-type': ct } : {}
      const r = await fetch(BASE + '/join', { method: 'POST', headers, body: JSON.stringify({ invite: alice.invite, name: 'CSRF' }) })
      assert.equal(r.status, 415, ct)
      await r.text()
    }
    const f = await call('GET', '/friends', undefined, alice)
    assert.ok(!f.data.members.some(m => m.name === 'CSRF'))
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
  await check('改名：只能改自己、同名允許、好友列表更新、容量人數不變（ui-15）', async () => {
    const owner = (await call('POST', '/groups', { name: 'RenameOwner' })).data
    const friend = (await call('POST', '/join', { invite: owner.invite, name: 'RenameFriend' })).data
    const before = (await call('GET', '/friends', undefined, owner)).data.members.length
    assert.equal((await call('POST', '/name', { name: 'SameName' }, owner)).status, 200)
    assert.equal((await call('POST', '/name', { name: 'SameName' }, friend)).status, 200, 'join 允許同名，rename 政策一致')
    const names = (await call('GET', '/friends', undefined, owner)).data.members.map(m => m.name)
    assert.deepEqual(names.sort(), ['SameName', 'SameName'])
    assert.equal((await call('GET', '/friends', undefined, owner)).data.members.length, before, '改名不增減 membership')
    assert.equal((await call('POST', '/name', { name: 'Hijack', memberId: owner.memberId }, friend)).status, 400, '不能指定別人的 memberId')
  })
  await check('看不見的填充字元當名字（U+3164／FFA0／115F／2800／034F／17B4／Tag）：建立與改名都擋，夾在中間的被清掉（0.5.6 盲審 #5）', async () => {
    const IP = '203.0.113.77'
    const fills = ['\u3164', '\uffa0', '\u115f\u1160', '\u2800', '\u034f', '\u17b4\u17b5', '\u{e0041}\u{e0042}', '\u{1d159}', '\u3164\u3164\u3164']
    for (const fill of fills) {
      assert.equal((await call('POST', '/groups', { name: fill }, undefined, undefined, IP)).status, 400, 'create ' + JSON.stringify(fill))
    }
    const owner = (await call('POST', '/groups', { name: 'A\u3164B\u2800C' }, undefined, undefined, IP)).data
    const me = (await call('GET', '/friends', undefined, owner)).data.members.find(m => m.isMe)
    assert.equal(me.name, 'ABC', '夾在中間的填充字元被清掉')
    for (const fill of fills) {
      assert.equal((await call('POST', '/name', { name: fill }, owner)).status, 400, 'rename ' + JSON.stringify(fill))
      assert.equal((await call('POST', '/name', { name: 'X' + fill }, owner)).status, 400, 'rename X+' + JSON.stringify(fill))
    }
    const joiner = await call('POST', '/join', { invite: owner.invite, name: '\u3164' }, undefined, undefined, IP)
    assert.equal(joiner.status, 400, 'join 只有填充字元')
  })
  await check('改名：長度、控制／零寬／RTL、額外欄位先於寫入與限速拒絕（ui-15）', async () => {
    const owner = (await call('POST', '/groups', { name: 'ValidBefore' })).data
    for (const name of ['', 'A'.repeat(21), 'Bad\u0007', 'Zero\u200bWidth', 'RTL\u202eName']) {
      assert.equal((await call('POST', '/name', { name }, owner)).status, 400, JSON.stringify(name))
    }
    assert.equal((await call('POST', '/name', { name: 'Bad\u200b' }, 'Bearer malformed')).status, 400, '輸入檢查先於成員金鑰 hash')
    assert.equal((await call('POST', '/name', { name: 'Good', extra: true }, owner)).status, 400)
    assert.equal((await call('POST', '/name', { name: 'Good' }, owner)).status, 200, '非法輸入沒有先吃掉成員冷卻')
    assert.equal((await call('POST', '/name', { name: 'TooSoon' }, owner)).status, 429)
    const me = (await call('GET', '/friends', undefined, owner)).data.members.find(m => m.isMe)
    assert.equal(me.name, 'Good', '被拒的改名不能寫入')
  })
  await check('改名核心：同一成員 60 秒一次，時鐘倒退可恢復；檢查都先於寫入（ui-15）', async () => {
    const made = await core.createGroup({ name: 'CoreRename' }, 1_000)
    const mem = made.g.members[made.g.ownerId]
    assert.deepEqual(core.rename(mem, { name: 'First' }, 10_000), [200, { ok: true }])
    assert.equal(core.rename(mem, { name: 'Second' }, 69_999)[0], 429)
    assert.equal(mem.name, 'First')
    assert.equal(core.rename(mem, { name: 'Second' }, 70_000)[0], 200)
    assert.equal(core.rename(mem, { name: 'ClockBack' }, 1)[0], 200)
    assert.equal(mem.name, 'ClockBack')
  })
  await check('限速 fixed window：59,999 ms 仍在窗內，恰好 60,000 ms 已重置', async () => {
    const limit = core.makeLimiter()
    assert.equal(limit('rename:boundary', 1, core.RENAME_GLOBAL_WINDOW_MS, 10_000), false)
    assert.equal(limit('rename:boundary', 1, core.RENAME_GLOBAL_WINDOW_MS, 69_999), true)
    assert.equal(limit('rename:boundary', 1, core.RENAME_GLOBAL_WINDOW_MS, 70_000), false)
  })
  await check('改名：同一來源 IP 每分鐘最多 30 次，其他 IP 不受影響（ui-15）', async () => {
    const owners = []
    for (let i = 0; i <= core.RENAME_GLOBAL_MAX; i++) owners.push((await call('POST', '/groups', { name: `Global${i}` }, undefined, undefined, `198.51.100.${i + 1}`)).data)
    const sharedIp = '203.0.113.200'
    for (let i = 0; i < core.RENAME_GLOBAL_MAX; i++) assert.equal((await call('POST', '/name', { name: `Renamed${i}` }, owners[i], undefined, sharedIp)).status, 200)
    assert.equal((await call('POST', '/name', { name: 'Blocked' }, owners[core.RENAME_GLOBAL_MAX], undefined, sharedIp)).status, 429)
    assert.equal((await call('POST', '/name', { name: 'OtherIp' }, owners[core.RENAME_GLOBAL_MAX], undefined, '203.0.113.201')).status, 200)
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
    alice.inviteGeneration = k.data.inviteGeneration
    assert.equal((await call('POST', '/join', { invite: alice.invite, name: 'Dan' })).status, 200)
  })
  await check('踢人：找不到這個人 → 404（已經被踢的人再踢一次也是），請求本身不對（沒給 id、踢自己）仍是 400；404 不換邀請碼（0.5.6）', async () => {
    const testIp = '192.0.2.172'
    const go = (method, path, body, member) => call(method, path, body, member, undefined, testIp)
    const owner = (await go('POST', '/groups', { name: 'KickOwner' })).data
    const friend = (await go('POST', '/join', { invite: owner.invite, name: 'KickFriend' })).data
    const first = await go('POST', '/kick', { memberId: friend.memberId }, owner)
    assert.equal(first.status, 200)
    const again = await go('POST', '/kick', { memberId: friend.memberId }, owner)
    assert.equal(again.status, 404, '重試已經成功的踢人：找不到這個人是 404，不是 400')
    assert.deepEqual(again.data, { error: '找不到這個人' })
    assert.equal((await go('POST', '/kick', { memberId: 'nobodyAtAll' }, owner)).status, 404)
    assert.equal((await go('POST', '/kick', {}, owner)).status, 400)
    assert.equal((await go('POST', '/kick', { memberId: 123 }, owner)).status, 400)
    assert.equal((await go('POST', '/kick', { memberId: owner.memberId }, owner)).status, 400, '踢自己是請求不對')
    assert.equal((await go('POST', '/join', { invite: first.data.invite, name: 'StillValid' })).status, 200, '404 沒有換掉邀請碼')
  })
  await check('原群主離開：接任者可換邀請碼與移除朋友，非群主仍被拒', async () => {
    const testIp = '192.0.2.171'
    const go = (method, path, body, member) => call(method, path, body, member, undefined, testIp)
    const original = (await go('POST', '/groups', { name: 'OriginalOwner' })).data
    const successor = (await go('POST', '/join', { invite: original.invite, name: 'Successor' })).data
    const ordinary = (await go('POST', '/join', { invite: original.invite, name: 'Ordinary' })).data
    assert.equal((await go('POST', '/leave', {}, original)).status, 200)
    const self = (await go('GET', '/friends', undefined, successor)).data.members.find(m => m.isMe)
    assert.equal(self.isOwner, true)
    assert.equal((await go('POST', '/kick', { memberId: successor.memberId }, ordinary)).status, 403)
    assert.equal((await go('POST', '/invite/rotate', {}, successor)).status, 200)
    assert.equal((await go('POST', '/kick', { memberId: ordinary.memberId }, successor)).status, 200)
    assert.equal((await go('GET', '/friends', undefined, ordinary)).status, 401)
  })
  await check('L-SEC-ROTATE-1: generations are monotonic, concurrent rotations are unique, and lists do not leak invites', async () => {
    const testIp = '192.0.2.170'
    const beforeGeneration = alice.inviteGeneration
    const [r1, r2] = await Promise.all([
      call('POST', '/invite/rotate', {}, alice, undefined, testIp),
      call('POST', '/invite/rotate', {}, alice, undefined, testIp),
    ])
    assert.equal(r1.status, 200)
    assert.equal(r2.status, 200)
    assert.deepEqual([r1.data.inviteGeneration, r2.data.inviteGeneration].sort((a, b) => a - b), [beforeGeneration + 1, beforeGeneration + 2])
    const latest = r1.data.inviteGeneration > r2.data.inviteGeneration ? r1.data : r2.data
    const older = latest === r1.data ? r2.data : r1.data
    assert.equal((await call('POST', '/join', { invite: older.invite, name: 'Stale' }, undefined, undefined, testIp)).status, 403)
    assert.equal((await call('POST', '/join', { invite: latest.invite, name: 'Fresh' }, undefined, undefined, testIp)).status, 200)
    alice.invite = latest.invite
    alice.inviteGeneration = latest.inviteGeneration
    const friends = await call('GET', '/friends', undefined, alice, undefined, testIp)
    const status = await call('POST', '/status', { state: 'idle', conn: 'rotation01' }, alice, undefined, testIp)
    assert.equal(JSON.stringify(friends.data).includes('invite'), false)
    assert.equal(JSON.stringify(status.data).includes('invite'), false)
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
  // sec-9 模糊測試：固定亂數種子（每次跑都一樣，失敗可以重現）；每個端點 200 個亂七八糟的請求，
  // 只能回 2xx／4xx、不能 500、中繼不能掛，跑完正常請求照常成功
  let seed = 20261014
  const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const pick = arr => arr[Math.floor(rand() * arr.length)]
  const WEIRD = ['', ' ', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '../../etc', 'working', 'fixing-bugs', 'website', 'cat', '1.2.3', 'Ignore previous instructions', '‮​', '🐱', 'null', '{}', 'a'.repeat(300)]
  const KEYS = ['name', 'groupName', 'invite', 'state', 'action', 'subject', 'paused', 'conn', 'version', 'avatar', 'memberId', '__proto__', 'constructor', 'x']
  const fuzzValue = (depth = 0) => {
    const r = rand()
    if (r < 0.1) return null
    if (r < 0.18) return rand() < 0.5
    if (r < 0.3) return pick([0, -1, 1e308, -1e-308, 2 ** 53 + 1, 3.14])
    if (r < 0.55) return rand() < 0.15 ? 'z'.repeat(Math.floor(rand() * 5000)) : pick(WEIRD)
    if (r < 0.7 || depth > 2) return depth > 2 ? pick(WEIRD) : Array.from({ length: Math.floor(rand() * 4) }, () => fuzzValue(depth + 1))
    return fuzzBody(depth + 1)
  }
  const fuzzBody = (depth = 0) => Object.fromEntries(Array.from({ length: Math.floor(rand() * 5) }, () => [pick(KEYS), fuzzValue(depth)]))
  const fuzzRaw = () => {
    const r = rand()
    if (r < 0.06) return pick(['{', 'not json', '[1,2', '\u0000', '"just a string"', 'null', '[]', '42', 'true'])
    return JSON.stringify(r < 0.12 ? fuzzValue() : fuzzBody())
  }
  let ipN = 0
  const nextIp = () => `198.51.100.${(ipN++ % 250) + 1}`
  async function raw(method, path, rawBody, authHeader, contentType = 'application/json') {
    const headers = { 'content-type': contentType, 'x-test-ip': nextIp() }
    if (authHeader) headers.authorization = authHeader
    const res = await fetch(BASE + path, { method, headers, body: method === 'GET' ? undefined : rawBody })
    await res.text()
    return res.status
  }
  if (server) {
    await check('模糊測試：每個端點 200 個亂七八糟的請求 → 只回 2xx／4xx、中繼沒掛、之後照常（sec-9）', async () => {
      const owner = (await call('POST', '/groups', { name: 'Fuzz' }, undefined, undefined, nextIp())).data
      let invite = owner.invite
      const fresh = async () => (await call('POST', '/join', { invite, name: 'F' + ipN }, undefined, undefined, nextIp())).data
      const garbageAuth = () => pick([
        undefined, 'Bearer', 'Bearer a.b', 'Basic xyz', `Bearer ${owner.groupId}.${owner.memberId}.wrong`,
        `Bearer ${owner.groupId}.__proto__.x`, `Bearer ${owner.groupId}.constructor.x`, 'Bearer __proto__.__proto__.__proto__',
        `Bearer constructor.${owner.memberId}.${owner.memberKey}`, 'Bearer ' + 'a'.repeat(3000) + '.b.c',
      ])
      const bad = []
      const okCount = {}
      const routes = [['POST', '/groups'], ['POST', '/join'], ['POST', '/status'], ['GET', '/friends'], ['POST', '/invite/rotate'], ['POST', '/kick'], ['POST', '/name'], ['POST', '/leave'], ['GET', '/health']]
      // 前面的 /join 會把群組塞滿（10 人），/kick、/leave 要用的臨時成員就進不來：先清空（踢人會換邀請碼）
      const makeRoom = async () => {
        for (const m of (await call('GET', '/friends', undefined, owner, undefined, nextIp())).data.members.filter(x => !x.isMe)) {
          const k = await call('POST', '/kick', { memberId: m.id }, owner, undefined, nextIp())
          if (k.status === 200) invite = k.data.invite
        }
      }
      for (const [method, path] of routes) {
        if (path === '/kick' || path === '/leave') await makeRoom()
        for (let i = 0; i < 200; i++) {
          let authHeader = rand() < 0.35 ? garbageAuth() : auth(owner)
          // 離開會讓金鑰失效：用剛加入的臨時成員（群組滿了就用壞金鑰）
          if (path === '/leave' && authHeader === auth(owner)) {
            const tmp = await fresh()
            authHeader = tmp.memberKey ? auth(tmp) : garbageAuth()
          }
          let body = fuzzRaw()
          // 偶爾帶上真的邀請碼或真的成員 id，才走得到更深的路
          if (path === '/join' && rand() < 0.3) body = JSON.stringify({ ...fuzzBody(), invite, name: rand() < 0.5 ? fuzzValue() : 'J' })
          const isRealKick = path === '/kick' && rand() < 0.1
          if (isRealKick) { const tmp = await fresh(); if (tmp.memberId) body = JSON.stringify({ memberId: tmp.memberId }) }
          if (path === '/name' && rand() < 0.1) body = JSON.stringify({ name: `N${i}` })
          const ct = rand() < 0.05 ? pick(['text/plain', 'application/jsonx', '']) : 'application/json'
          const status = await raw(method, path, body, authHeader, ct)
          if (status >= 200 && status < 300) okCount[path] = (okCount[path] ?? 0) + 1
          // 踢成功就換了邀請碼：建立者再換一次，拿到新的
          if (isRealKick && status === 200) invite = (await call('POST', '/invite/rotate', {}, owner, undefined, nextIp())).data.invite
          if (!(status >= 200 && status < 500)) bad.push(`${method} ${path} → ${status}：${String(body).slice(0, 80)}`)
        }
        // 換邀請碼／踢人會換掉邀請碼：重新拿一個（建立者換一次就知道新的）
        if (path === '/invite/rotate' || path === '/kick') invite = (await call('POST', '/invite/rotate', {}, owner, undefined, nextIp())).data.invite
      }
      assert.deepEqual(bad, [], '不能有 5xx')
      // 不能全部在門口就被擋（401／415）：每個端點都要有亂資料真的走到底、成功的
      for (const [, path] of routes) assert.ok((okCount[path] ?? 0) > 0, `${path} 至少一個 2xx（有走到深處）：${JSON.stringify(okCount)}`)
      assert.equal(server.exitCode, null, '中繼還活著')
      assert.equal((await call('GET', '/health', undefined, undefined, undefined, nextIp())).status, 200)
      const s = await call('POST', '/status', { state: 'working', action: 'fixing-bugs', subject: 'website' }, owner, undefined, nextIp())
      assert.equal(s.status, 200, '建立者照常送狀態')
      assert.ok(s.data.members.find(m => m.isMe && m.action === 'fixing-bugs'))
      const j = await call('POST', '/join', { invite, name: 'After' }, undefined, undefined, nextIp())
      assert.ok([200, 403].includes(j.status), '加入照常（群組可能滿了＝403）')
    })
  }
  await check('金鑰裡的成員 id 是 __proto__／constructor 這種名字 → 401（不是 400），連線 id __proto__ → 400（sec-9）', async () => {
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      assert.equal((await call('GET', '/friends', undefined, `Bearer ${alice.groupId}.${id}.x`)).status, 401, id)
    }
    assert.equal((await call('POST', '/status', { state: 'idle', conn: '__proto__' }, alice)).status, 400)
    assert.equal((await call('POST', '/status', { state: 'idle', conn: 'constructor' }, alice)).status, 200, '其他名字照收（不放寬也不多擋）')
  })
  await check('模糊測試：共用核心 core.mjs 直接呼叫 → 物件形狀的亂資料一律回 [code, …]、不丟例外（sec-9）', async () => {
    // HTTP 那邊兩個中繼都會把例外包成 400，看不出核心有沒有壞；這裡直接呼叫
    const made = await core.createGroup({ name: 'Core' }, 0)
    const g = made.g
    const ownerId = g.ownerId
    const errors = []
    const tryIt = async (label, fn) => { try { const r = await fn(); if (r !== null && r !== undefined && Array.isArray(r) && !(r[0] >= 200 && r[0] < 500)) errors.push(`${label} → ${r[0]}`) } catch (err) { errors.push(`${label} 丟例外：${err.message}`) } }
    for (let i = 0; i < 200; i++) {
      const b = fuzzBody()
      await tryIt(`createGroup ${JSON.stringify(b).slice(0, 60)}`, async () => { const r = await core.createGroup(b, 0); return r.error ?? r.reply })
      await tryIt(`join ${JSON.stringify(b).slice(0, 60)}`, () => core.join(g, made.groupId, b, 0))
      await tryIt(`status ${JSON.stringify(b).slice(0, 60)}`, () => core.status(g, ownerId, g.members[ownerId], b, i * 1000))
      await tryIt(`kick ${JSON.stringify(b).slice(0, 60)}`, () => core.kick(g, made.groupId, ownerId, b))
      const id = pick([...WEIRD, ownerId])
      await tryIt(`findMember ${id}`, async () => { await core.findMember(g, id, pick(WEIRD)); return null })
      await tryIt(`parseAuth`, () => { core.parseAuth(pick([...WEIRD, undefined, 'Bearer a.b.c'])); return null })
    }
    assert.deepEqual(errors, [])
    assert.ok(g.members[ownerId], '建立者還在')
  })
  await check('群組代碼是 __proto__／constructor／toString → 每條要登入的路都 401，加入跟「沒這個群組」一樣 403（sec-10）', async () => {
    for (const gid of ['__proto__', 'constructor', 'toString']) {
      const authHeader = `Bearer ${gid}.${alice.memberId}.${alice.memberKey}`
      for (const [method, path, body] of [['GET', '/friends'], ['POST', '/status', { state: 'idle' }], ['POST', '/invite/rotate', {}], ['POST', '/kick', { memberId: bob.memberId }], ['POST', '/name', { name: 'Valid' }], ['POST', '/leave', {}]]) {
        assert.equal((await call(method, path, body, authHeader, undefined, '192.0.2.60')).status, 401, `${gid} ${path}`)
      }
      const unknown = (await call('POST', '/join', { invite: 'zzzzzzzzzzzz.x', name: 'Q' }, undefined, undefined, '192.0.2.61')).status
      assert.equal((await call('POST', '/join', { invite: `${gid}.x`, name: 'Q' }, undefined, undefined, '192.0.2.61')).status, unknown, `${gid} 加入`)
    }
    assert.equal((await call('GET', '/friends', undefined, alice, undefined, '192.0.2.60')).status, 200, 'Alice 自己沒受影響')
  })
  if (server) {
    await check('Node 中繼沒有回應簽章私鑰時會明確拒絕啟動（sec-16b C）', async () => {
      const env = { ...process.env }
      delete env.RESPONSE_SIGNING_PRIVATE_KEY
      delete env.RESPONSE_SIGNING_KEY_ID
      const port = 19700 + Math.floor(Math.random() * 90)
      const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--port', String(port)], {
        stdio: ['ignore', 'pipe', 'pipe'], env,
      })
      let stderr = ''
      child.stderr.on('data', data => { stderr += data })
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error('沒有私鑰的 Node 中繼 10 秒內沒有結束'))
        }, 10_000)
        child.once('exit', exitCode => {
          clearTimeout(timer)
          resolve(exitCode)
        })
      })
      assert.notEqual(code, 0)
      assert.match(stderr, /Node 中繼需要 RESPONSE_SIGNING_PRIVATE_KEY 與 RESPONSE_SIGNING_KEY_ID；沒有簽章私鑰不啟動/)
    })
    await check('舊格式的資料檔（成員沒有 conns／version／avatar）用 --data 開得起來，金鑰照用（sec-10）', async () => {
      const dir = mkdtempSync(joinPath(tmpdir(), 'friends-olddata-'))
      const data = joinPath(dir, 'relay-data.json')
      const key = 'oldkey' + 'x'.repeat(37)
      const old = { groups: { OldGroup1234: { name: 'Old group', inviteHash: await core.sha('OldGroup1234.invite'), ownerId: 'm0', members: {
        m0: { name: 'Old', keyHash: await core.sha(key), action: 'learning', subject: 'game', activityAt: 0, seenAt: 0 },
      } } } }
      writeFileSync(data, JSON.stringify(old))
      const port = 19900 + Math.floor(Math.random() * 90)
      const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--port', String(port), '--data', data], {
        stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...SIGNING_ENV },
      })
      try {
        await waitForRelayStart(child, '舊資料檔中繼')
        const base = `http://127.0.0.1:${port}`
        const h = { 'content-type': 'application/json', authorization: `Bearer OldGroup1234.m0.${key}` }
        const f = await fetch(base + '/friends', { headers: h })
        assert.equal(f.status, 200)
        assert.equal((await f.json()).members[0].name, 'Old')
        const st = await fetch(base + '/status', { method: 'POST', headers: h, body: JSON.stringify({ state: 'working', conn: 'connAAAAAAAA', avatar: 'owl' }) })
        assert.equal(st.status, 200, '舊成員也能送新欄位')
        const j = await fetch(base + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: 'OldGroup1234.invite', name: 'New' }) })
        assert.equal(j.status, 200, '舊邀請碼照用')
      } finally {
        const exited = new Promise(resolve => child.once('exit', resolve))
        child.kill()
        await exited
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
  // ops-2a：每週活躍群組數（預設關）。要另外開中繼，--base 測 Worker 版時跳過（Worker 版沒有這個功能）
  if (server) {
    await check('L-SEC-ROTATE-1: Node data-file restart preserves invite generation', async () => {
      const dir = mkdtempSync(joinPath(tmpdir(), 'friends-rotation-'))
      const data = joinPath(dir, 'relay-data.json')
      const port = 20100 + Math.floor(Math.random() * 90)
      const base = `http://127.0.0.1:${port}`
      let child
      const startNode = async () => {
        child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--port', String(port), '--data', data], {
          stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...SIGNING_ENV },
        })
        await waitForRelayStart(child, 'rotation Node relay')
      }
      const stopNode = async () => {
        const exited = new Promise(resolve => child.once('exit', resolve))
        child.kill()
        await exited
      }
      const request = async (method, path, body, member) => {
        const headers = { 'content-type': 'application/json' }
        if (member) headers.authorization = auth(member)
        const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
        return { status: response.status, data: await response.json() }
      }
      try {
        await startNode()
        const owner = (await request('POST', '/groups', { name: 'Owner' })).data
        assert.equal(owner.inviteGeneration, 0)
        assert.equal((await request('POST', '/invite/rotate', {}, owner)).data.inviteGeneration, 1)
        assert.equal((await request('POST', '/invite/rotate', {}, owner)).data.inviteGeneration, 2)
        await stopNode()
        await startNode()
        assert.equal((await request('POST', '/invite/rotate', {}, owner)).data.inviteGeneration, 3)
      } finally {
        if (child?.exitCode === null) await stopNode()
        rmSync(dir, { recursive: true, force: true })
      }
    })
    const ADMIN = 'admin-' + 'k'.repeat(30)
    const startRelay = async (args, env = {}, init = undefined) => {
      const dir = mkdtempSync(joinPath(tmpdir(), 'friends-weekly-'))
      const data = joinPath(dir, 'relay-data.json')
      if (init) writeFileSync(data, JSON.stringify(init))
      const port = 19800 + Math.floor(Math.random() * 90)
      const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--port', String(port), '--data', data, ...args], {
        stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...SIGNING_ENV, FRIENDS_WEEKLY_STATS: '', FRIENDS_ADMIN_KEY: '', ...env },
      })
      await waitForRelayStart(child, '每週統計中繼')
      const base = `http://127.0.0.1:${port}`
      const req = async (method, path, body, authz) => {
        const h = { 'content-type': 'application/json' }
        if (authz) h.authorization = authz
        const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
        const text = await res.text()
        return { status: res.status, data: text ? JSON.parse(text) : null }
      }
      // 3 個群組，前 2 個送狀態（第 1 個送兩次、還有一位朋友也送）
      const groups = []
      for (const name of ['WeeklyAlice', 'WeeklyBob', 'WeeklyCarol']) groups.push((await req('POST', '/groups', { name, groupName: name + 'Group' })).data)
      const friend = (await req('POST', '/join', { invite: groups[0].invite, name: 'WeeklyDan' })).data
      for (const m of [groups[0], groups[0], friend, groups[1]]) {
        const r = await req('POST', '/status', { state: 'working', conn: 'connWEEKLY01', action: 'learning', subject: 'game' }, auth(m))
        assert.equal(r.status, 200)
      }
      const stop = async () => {
        const exited = new Promise(resolve => child.once('exit', resolve))
        child.kill()
        await exited
        rmSync(dir, { recursive: true, force: true })
      }
      return { req, stop, stored: () => readFileSync(data, 'utf8'), groups }
    }
    await check('每週活躍群組數：預設關 → 資料檔沒有統計、查詢端點不存在（ops-2a）', async () => {
      const r = await startRelay([], { FRIENDS_ADMIN_KEY: ADMIN })
      try {
        assert.equal(JSON.parse(r.stored()).weekly, undefined)
        assert.equal((await r.req('GET', '/admin/weekly', undefined, 'Bearer ' + ADMIN)).status, 404)
      } finally { await r.stop() }
    })
    await check('每週活躍群組數：開了 → 這週 2 個群組；沒帶／帶錯管理金鑰 401（ops-2a）', async () => {
      const r = await startRelay(['--weekly-stats'], { FRIENDS_ADMIN_KEY: ADMIN })
      try {
        for (const bad of [undefined, 'Bearer wrong-key-' + 'x'.repeat(30), ADMIN, 'Bearer ' + ADMIN + 'x', auth(r.groups[0])])
          assert.equal((await r.req('GET', '/admin/weekly', undefined, bad)).status, 401, String(bad).slice(0, 20))
        const ok = await r.req('GET', '/admin/weekly', undefined, 'Bearer ' + ADMIN)
        assert.equal(ok.status, 200)
        assert.equal(ok.data.activeGroups, 2)
        assert.equal(ok.data.week, core.weekOf(Date.now()))
        assert.deepEqual(Object.keys(ok.data).sort(), ['activeGroups', 'lastWeek', 'week'])
      } finally { await r.stop() }
    })
    await check('每週活躍群組數：統計裡只有週次和雜湊，找不到群組名、成員名、群組代碼、動態（ops-2a）', async () => {
      const r = await startRelay(['--weekly-stats'], { FRIENDS_ADMIN_KEY: ADMIN })
      try {
        const weekly = JSON.parse(r.stored()).weekly
        assert.deepEqual(Object.keys(weekly).sort(), ['groups', 'lastWeek', 'week'])
        assert.equal(weekly.groups.length, 2)
        // 存的就是「週次＋群組代碼」的雜湊：前兩個群組的，第三個沒送狀態所以沒有
        const want = await Promise.all(r.groups.map(g => core.weeklyHash(weekly.week, g.groupId)))
        assert.deepEqual([...weekly.groups].sort(), [want[0], want[1]].sort())
        assert.equal(weekly.lastWeek, null, '剛開始記，上週不知道')
      } finally { await r.stop() }
    })
    await check('每週活躍群組數：FRIENDS_WEEKLY_STATS 不是 1 都當關；關了會把資料檔裡舊的統計清掉（ops-2a）', async () => {
      // 資料檔裡留著之前開的時候記的統計
      const stale = { groups: {}, weekly: { week: 1, groups: ['0'.repeat(64)], lastWeek: null } }
      for (const v of ['true', ' 1', '0', 'yes']) {
        const r = await startRelay([], { FRIENDS_WEEKLY_STATS: v, FRIENDS_ADMIN_KEY: ADMIN }, stale)
        try {
          assert.equal(JSON.parse(r.stored()).weekly, undefined, v)
          assert.equal((await r.req('GET', '/admin/weekly', undefined, 'Bearer ' + ADMIN)).status, 404, v)
        } finally { await r.stop() }
      }
    })
    await check('每週活躍群組數：開了但沒設管理金鑰（或太短、有空白、太長）→ 照記，但沒有查詢端點（ops-2a）', async () => {
      for (const key of ['', 'short-key', 'my long admin pass phrase here ok', 'k'.repeat(201)]) {
        const r = await startRelay([], { FRIENDS_WEEKLY_STATS: '1', FRIENDS_ADMIN_KEY: key })
        try {
          assert.equal(JSON.parse(r.stored()).weekly.groups.length, 2, key)
          assert.equal((await r.req('GET', '/admin/weekly', undefined, 'Bearer ' + key)).status, 404, key)
        } finally { await r.stop() }
      }
    })
  }
  // ver-2c：版本存在伺服器端的成員資料。要看資料檔，所以只有 Node 版跑（Worker 版重開後版本還在，由 restart.test.mjs 驗）
  if (server) {
    await check('X-Friends-Version 存進成員資料；亂字串、超長、沒帶、四段版本號一律存空字串；新舊版本來回變時不會每次都存檔（ver-2c／fix-6，Node）', async () => {
      const dir = mkdtempSync(joinPath(tmpdir(), 'friends-ver-'))
      const data = joinPath(dir, 'relay-data.json')
      const port = 19900 + Math.floor(Math.random() * 90)
      const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--port', String(port), '--data', data], {
        stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...SIGNING_ENV },
      })
      try {
        await waitForRelayStart(child, '版本測試中繼')
        const req = async (method, path, body, authz, v, raw) => {
          const h = { 'content-type': 'application/json' }
          if (authz) h.authorization = authz
          if (v !== undefined) h['x-friends-version'] = v
          const res = await fetch(`http://127.0.0.1:${port}` + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) })
          return { status: res.status, data: await res.json() }
        }
        const stored = m => JSON.parse(readFileSync(data, 'utf8')).groups[m.groupId].members[m.memberId].ver
        const beat = (m, v) => req('POST', '/status', { state: 'idle', conn: 'connVER00001' }, auth(m), v)
        const a = (await req('POST', '/groups', { name: 'VerAnn' }, undefined, '0.4.0')).data
        assert.equal(stored(a), '0.4.0', '建群組帶合法版本 → 存下來')
        const b = (await req('POST', '/join', { invite: a.invite, name: 'VerBob' }, undefined, 'web')).data
        assert.equal(stored(b), 'web', '加入帶 web')
        const c = (await req('POST', '/join', { invite: a.invite, name: 'VerCat' })).data
        assert.equal(stored(c), '', '加入沒帶版本 → 空字串')
        assert.equal((await beat(a, '0.5.0')).status, 200)
        assert.equal(stored(a), '0.5.0', '送狀態帶新版本 → 換成新的')
        // 送狀態在 Node 版每次都存檔，所以用它來看「記憶體裡現在是什麼」；亂值、沒帶都存空字串
        for (const v of ['garbage<>"', 'x'.repeat(2000), '9.9.9.9', '1.2', '']) {
          assert.equal((await beat(a, '0.5.0')).status, 200)
          assert.equal(stored(a), '0.5.0')
          assert.equal((await beat(a, v)).status, 200, '照常回應 ' + v.slice(0, 12))
          assert.equal(stored(a), '', '存空字串 ' + v.slice(0, 12))
        }
        assert.equal((await beat(a, '0.5.0')).status, 200)
        assert.equal((await beat(a)).status, 200)
        assert.equal(stored(a), '', '沒帶 → 空字串')
        // fix-6：GET /friends 只有版本會讓它存檔。第一次變動存下來；之後新舊版本來回變（舊對話 0.4.0、新對話 0.5.x 並用）一小時內只改記憶體
        assert.equal((await req('GET', '/friends', undefined, auth(b), '0.5.1')).status, 200)
        assert.equal(stored(b), '0.5.1', '第一次變動 → 馬上存檔')
        for (let i = 0; i < 49; i++) assert.equal((await req('GET', '/friends', undefined, auth(b), i % 2 ? '0.5.1' : '0.4.0')).status, 200)
        assert.equal(stored(b), '0.5.1', '來回變 49 次，資料檔裡還是第一次存的（沒有每次都存）')
        // 下一次本來就要存的事（送狀態）會把記憶體裡最後看到的版本一起存
        assert.equal((await beat(b, '0.4.0')).status, 200)
        assert.equal(stored(b), '0.4.0', '送狀態時一起存下最後看到的版本')
        // fix-7：內文是 null 的 POST /status 回 400；之後這個成員帶新版本的請求，版本還是會寫進資料檔（不會被記成已寫而永遠停在舊的）
        const d = (await req('POST', '/join', { invite: a.invite, name: 'VerDan' }, undefined, '0.4.0')).data
        assert.equal(stored(d), '0.4.0')
        assert.equal((await req('POST', '/status', undefined, auth(d), '0.5.0', 'null')).status, 400)
        for (let i = 0; i < 5; i++) assert.equal((await req('GET', '/friends', undefined, auth(d), '0.5.0')).status, 200)
        assert.equal(stored(d), '0.5.0', 'null 內文那次之後，版本仍然寫進資料檔')
        // fix-7：存檔失敗（把暫存檔的位置佔成資料夾，openSync 會丟 EISDIR）時請求照常回應；不記成已寫，
        // 存檔恢復後下一個請求即使版本沒再變也要補寫進去
        const f = (await req('POST', '/join', { invite: a.invite, name: 'VerFay' }, undefined, '0.4.0')).data
        mkdirSync(data + '.tmp')
        assert.equal((await req('GET', '/friends', undefined, auth(f), '0.9.0')).status, 200, '存檔失敗，請求照常回應')
        assert.equal(stored(f), '0.4.0', '存檔失敗，資料檔沒變')
        rmSync(data + '.tmp', { recursive: true })
        assert.equal((await req('GET', '/friends', undefined, auth(f), '0.9.0')).status, 200)
        assert.equal(stored(f), '0.9.0', '存檔恢復後，版本沒再變也補寫進去')
        // fix-8：路由自己存檔就丟錯（POST /status 本來就會存）→ 回 400；檔案沒變、版本不記成已寫，恢復後下一個請求補寫
        const g2 = (await req('POST', '/join', { invite: a.invite, name: 'VerGus' }, undefined, '0.4.0')).data
        mkdirSync(data + '.tmp')
        assert.equal((await beat(g2, '0.8.0')).status, 500, '路由自己存檔丟錯 → 500（不是 400：外掛會把 400 當成「中繼不認得 pauseSeq」）')
        assert.equal(stored(g2), '0.4.0', '存檔失敗，資料檔沒變')
        rmSync(data + '.tmp', { recursive: true })
        assert.equal((await req('GET', '/friends', undefined, auth(g2), '0.8.0')).status, 200)
        assert.equal(stored(g2), '0.8.0', '恢復後，版本沒再變也補寫進去')
        // fix-7：路由自己沒存的回應（非建立者換邀請碼 → 403）也要把版本存下來
        const e = (await req('POST', '/join', { invite: a.invite, name: 'VerEve' }, undefined, '0.4.0')).data
        assert.equal((await req('POST', '/invite/rotate', {}, auth(e), '0.6.0')).status, 403)
        assert.equal(stored(e), '0.6.0', '非建立者換邀請碼被擋（403），版本照樣存下來')
      } finally {
        const exited = new Promise(resolve => child.once('exit', resolve))
        child.kill()
        await exited
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
  await check('每週活躍群組數：換週時上週的數字留下來；中間空一週以上，上週是 0（ops-2a）', async () => {
    const W = core.WEEK_MS
    const st = core.newWeeklyStats()
    assert.equal(await core.recordWeekly(st, 'g1', 10 * W), true)
    assert.equal(st.lastWeek, null, '第一次記，上週不知道')
    assert.equal(await core.recordWeekly(st, 'g1', 10 * W + 5), false, '同一週同一群組不重記')
    assert.equal(await core.recordWeekly(st, 'g2', 10 * W + 6), true)
    assert.deepEqual(core.weeklyView(st, 11 * W), { week: 11, activeGroups: 0, lastWeek: { week: 10, activeGroups: 2 } })
    await core.recordWeekly(st, 'g3', 11 * W + 1)
    assert.deepEqual(core.weeklyView(st, 14 * W), { week: 14, activeGroups: 0, lastWeek: { week: 13, activeGroups: 0 } })
    assert.equal(await core.isAdmin('Bearer abc', ''), false, '沒設金鑰一律不行')
    assert.equal(await core.isAdmin(undefined, 'abc'), false)
    assert.notEqual(await core.weeklyHash(10, 'g1'), await core.weeklyHash(11, 'g1'), '同一群組每週雜湊不同')
  })
  // relay-9：資料檔壞了不會掛。要另外開中繼，--base 測 Worker 版時跳過
  if (server) {
    const startWithData = async (content, args = []) => {
      const dir = mkdtempSync(joinPath(tmpdir(), 'friends-broken-'))
      const data = joinPath(dir, 'relay-data.json')
      if (content !== undefined) writeFileSync(data, content)
      const port = 19600 + Math.floor(Math.random() * 90)
      const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--port', String(port), '--data', data, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...SIGNING_ENV },
      })
      let stderr = ''
      child.stderr.on('data', d => { stderr += d })
      await waitForRelayStart(child, '資料復原中繼', () => stderr)
      const base = `http://127.0.0.1:${port}`
      const stop = async () => {
        const exited = new Promise(resolve => child.once('exit', resolve))
        child.kill()
        await exited
        rmSync(dir, { recursive: true, force: true })
      }
      return { base, dir, data, stop, stderr: () => stderr }
    }
    const brokenFiles = dir => readdirSync(dir).filter(f => f.startsWith('relay-data.json.broken-'))
    for (const [label, content] of [['壞的 JSON', '{"groups": {"x": '], ['空檔', ''], ['型別錯（陣列）', '[]'], ['型別錯（groups 是數字）', '{"groups": 5}'], ['型別錯（群組沒有 members）', '{"groups": {"AbcdefGhijkl": {"name": "x"}}}'], ['型別錯（成員是 null）', '{"groups": {"AbcdefGhijkl": {"members": {"m": null}}}}']]) {
      await check(`資料檔${label} → 不崩、壞檔改名成 .broken-<時間> 留著、用空資料開起來、印警告（relay-9）`, async () => {
        const r = await startWithData(content)
        try {
          const h = await fetch(r.base + '/health')
          assert.equal(h.status, 200)
          await h.text()
          const broken = brokenFiles(r.dir)
          assert.equal(broken.length, 1, '壞檔留著')
          assert.equal(readFileSync(joinPath(r.dir, broken[0]), 'utf8'), content, '內容原封不動')
          assert.match(r.stderr(), /資料檔.*改名成.*broken/)
          // 空資料照常能用，而且寫回的是完整的新檔
          const g = await fetch(r.base + '/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Fresh' }) })
          assert.equal(g.status, 200)
          await g.text()
          assert.equal(Object.keys(JSON.parse(readFileSync(r.data, 'utf8')).groups).length, 1)
        } finally { await r.stop() }
      })
    }
    await check('正常的資料檔照常讀、不改名；沒有資料檔就用空的開（relay-9）', async () => {
      const key = 'goodkey' + 'x'.repeat(36)
      const good = { groups: { GoodGroup123: { name: 'Good', inviteHash: await core.sha('GoodGroup123.inv'), ownerId: 'm0', members: { m0: { name: 'G', keyHash: await core.sha(key), conns: {}, action: '', subject: '', activityAt: 0, seenAt: 0 } } } } }
      const r = await startWithData(JSON.stringify(good))
      try {
        const f = await fetch(r.base + '/friends', { headers: { authorization: `Bearer GoodGroup123.m0.${key}` } })
        assert.equal(f.status, 200)
        assert.equal((await f.json()).members[0].name, 'G')
        assert.deepEqual(brokenFiles(r.dir), [])
        assert.equal(r.stderr(), '')
      } finally { await r.stop() }
      // Windows 記事本存的檔開頭有 BOM：照常讀
      const bom = await startWithData('\uFEFF' + JSON.stringify(good))
      try {
        const f2 = await fetch(bom.base + '/friends', { headers: { authorization: `Bearer GoodGroup123.m0.${key}` } })
        assert.equal(f2.status, 200, 'BOM')
        await f2.text()
        assert.deepEqual(brokenFiles(bom.dir), [])
      } finally { await bom.stop() }
      const none = await startWithData(undefined)
      try {
        const h = await fetch(none.base + '/health')
        assert.equal(h.status, 200)
        await h.text()
        assert.deepEqual(brokenFiles(none.dir), [])
      } finally { await none.stop() }
    })
    await check('開了每週統計、但資料檔裡的統計格式不對 → 重新開始記，/status 不會出錯（relay-9）', async () => {
      const r = await startWithData(JSON.stringify({ groups: {}, weekly: 5 }), ['--weekly-stats'])
      try {
        const g = await (await fetch(r.base + '/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'W' }) })).json()
        const st = await fetch(r.base + '/status', { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth(g) }, body: JSON.stringify({ state: 'working', conn: 'connRELAY9AA' }) })
        assert.equal(st.status, 200)
        await st.text()
        assert.equal(JSON.parse(readFileSync(r.data, 'utf8')).weekly.groups.length, 1)
      } finally { await r.stop() }
    })
  }
  await check('請求大小照位元組算：中文 1500 字（約 4.5 KB）超過 4096 → 400；1300 字（約 3.9 KB）照常（L-6，跟 Worker 版一致）', async () => {
    const big = await call('POST', '/groups', undefined, undefined, JSON.stringify({ name: '中'.repeat(1500) }), '192.0.2.80')
    assert.equal(big.status, 400)
    assert.equal(big.data.error, '請求格式錯誤', '是「太大」那條路徑（讀 body 時丟錯）')
    const ok = await call('POST', '/groups', undefined, undefined, JSON.stringify({ name: '中'.repeat(1300) }), '192.0.2.80')
    assert.equal(ok.status, 200)
    assert.equal(ok.data.isOwner, true)
  })
  await check('沒有 content-length（分段傳送）時也照位元組算：中文 1500 字 → 400、1300 字照常（L-9，Node 和 Worker 都跑）', async () => {
    const send = async n => {
      const body = new TextEncoder().encode(JSON.stringify({ name: '中'.repeat(n) }))
      // 用 ReadableStream 當 body，fetch 不會帶 content-length，改用 chunked 傳送
      const stream = new ReadableStream({ start(c) { c.enqueue(body.slice(0, 1000)); c.enqueue(body.slice(1000)); c.close() } })
      const res = await fetch(BASE + '/groups', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': '192.0.2.81' }, body: stream, duplex: 'half' })
      await res.text()
      return res.status
    }
    assert.equal(await send(1500), 400)
    assert.equal(await send(1300), 200)
  })
  await check('body 開頭有 UTF-8 BOM → 照常處理，結果跟沒有 BOM 一樣（fix-5，Node 和 Worker 都跑）', async () => {
    const plain = await call('POST', '/groups', undefined, undefined, JSON.stringify({ name: 'Ann', groupName: 'BomGroup' }), '192.0.2.82')
    const withBom = await call('POST', '/groups', undefined, undefined, '\uFEFF' + JSON.stringify({ name: 'Ann', groupName: 'BomGroup' }), '192.0.2.82')
    assert.equal(plain.status, 200)
    assert.equal(withBom.status, 200)
    assert.deepEqual(Object.keys(withBom.data).sort(), Object.keys(plain.data).sort())
    assert.equal(withBom.data.groupName, plain.data.groupName, '名字有讀到（不是被當成空 body）')
    assert.equal(withBom.data.isOwner, true)
    // 內文只有一個 BOM：當成沒有內文（空 {}），送狀態照常回 200（兩個中繼的行為一樣）
    const onlyBom = await call('POST', '/status', undefined, withBom.data, '\uFEFF', '192.0.2.82')
    assert.equal(onlyBom.status, 200)
  })
  await check('內文不是 JSON 物件（null、陣列、數字、字串、布林）→ 400 固定句子，不動任何東西；Node 上也不算加入次數（fix-7）', async () => {
    const owner = (await call('POST', '/groups', { name: 'ObjA' }, undefined, undefined, '192.0.2.91')).data
    for (const raw of ['null', '[]', '[1,2]', '5', '"x"', 'true']) {
      for (const path of ['/status', '/invite/rotate', '/kick', '/name', '/leave']) {
        const r = await call('POST', path, undefined, owner, raw, '192.0.2.91')
        assert.equal(r.status, 400, path + ' ' + raw)
        assert.equal(r.data.error, '請求格式錯誤', path + ' ' + raw)
      }
      assert.equal((await call('POST', '/groups', undefined, undefined, raw, '192.0.2.91')).status, 400, '/groups ' + raw)
    }
    // /join 帶這種內文 12 次：每次都是 400，沒有一次是 429（Node 版以前會先算一次加入次數）
    for (let i = 0; i < 12; i++) assert.equal((await call('POST', '/join', undefined, undefined, i % 2 ? 'null' : '[]', '192.0.2.92')).status, 400, 'join ' + i)
    const f = await call('GET', '/friends', undefined, owner, undefined, '192.0.2.91')
    assert.equal(f.status, 200, '群組和金鑰都沒被動到（/leave 的 400 沒讓人離開）')
    assert.equal(f.data.members.length, 1)
  })
  await check('POST /status 多送不收的欄位 → 400，錯誤是固定句子，不回顯請求的鍵名（fix-8）', async () => {
    const m = (await call('POST', '/groups', { name: 'ExtraKey' }, undefined, undefined, '192.0.2.93')).data
    for (const key of ['evilKeyName', '<script>', 'x'.repeat(40)]) {
      const r = await call('POST', '/status', { state: 'idle', conn: 'connEXTRA001', [key]: 'v' }, m, undefined, '192.0.2.93')
      assert.equal(r.status, 400, key.slice(0, 12))
      assert.equal(r.data.error, '不收的欄位', key.slice(0, 12))
      assert.ok(!JSON.stringify(r.data).includes(key), '回應裡不能出現請求的鍵名 ' + key.slice(0, 12))
    }
  })
  // test-2：之前沒有任何測試走到的分支
  await check('同一人超過 20 條連線 → 只留最新的 20 條（最舊的先丟），在線狀態照最新的算（test-2）', async () => {
    const made = await core.createGroup({ name: 'Conns' }, 0)
    const id = made.g.ownerId
    const mem = made.g.members[id]
    for (let i = 0; i < 25; i++) assert.equal(core.status(made.g, id, mem, { state: i === 24 ? 'working' : 'idle', conn: `conn${String(i).padStart(5, '0')}` }, 1000 + i)[0], 200)
    const ids = Object.keys(mem.conns).sort()
    assert.equal(ids.length, core.MAX_CONNS)
    assert.equal(ids[0], 'conn00005', '最舊的 5 條丟掉')
    assert.equal(core.presence(mem, 1100), 'working')
  })
  await check('動態過期：超過保存期限就清掉、回報要寫回；沒過期不動（test-2）', async () => {
    const made = await core.createGroup({ name: 'Exp' }, 0)
    const id = made.g.ownerId
    const mem = made.g.members[id]
    core.status(made.g, id, mem, { state: 'working', action: 'learning', subject: 'game' }, 1000)
    assert.equal(core.expireActivity(made.g, 1000 + 500, 1000), false, '還沒過期')
    assert.equal(mem.action, 'learning')
    assert.equal(core.expireActivity(made.g, 1000 + 1001, 1000), true, '過期了')
    assert.deepEqual([mem.action, mem.subject, mem.activityAt], ['', '', 0])
    assert.equal(core.expireActivity(made.g, 99999, 1000), false, '清過了就不用再寫')
  })
  await check('nextExpiry：沒有動態回 null；有就回最早那筆到期的時間（Worker 用來排 alarm）（test-2）', async () => {
    const made = await core.createGroup({ name: 'Next' }, 0)
    assert.equal(core.nextExpiry(made.g, 1000), null)
    const j = await core.join(made.g, made.groupId, { invite: made.reply[1].invite, name: 'B' }, 0)
    core.status(made.g, made.g.ownerId, made.g.members[made.g.ownerId], { state: 'working', action: 'learning', subject: 'game' }, 5000)
    core.status(made.g, j[1].memberId, made.g.members[j[1].memberId], { state: 'working', action: 'planning', subject: 'app' }, 3000)
    assert.equal(core.nextExpiry(made.g, 1000), 3000 + 1000 + 1)
  })
  await check('X-Friends-Version：clientVersion 只認 x.y.z 和 web，其他當沒帶（ver-2b）', async () => {
    for (const v of ['0.4.0', '10.20.30', 'web']) assert.equal(core.clientVersion(v), v)
    for (const v of [undefined, null, '', '0.4', '0.4.0-beta', 'v0.4.0', ' 0.4.0', '0.4.0\n', 'WEB', '1'.repeat(6) + '.0.0', '<script>', 'x'.repeat(5000), 42, ['0.4.0']])
      assert.equal(core.clientVersion(v), '', String(v).slice(0, 20))
  })
  await check('noteVer：版本一定先改記憶體；單獨寫資料庫的次數有上限（同一成員一小時內最多一次）；亂值經 clientVersion 變空字串（ver-2c／fix-6）', async () => {
    const H = core.VER_WRITE_MS
    const made = await core.createGroup({ name: 'VerCore' }, 0, core.clientVersion('0.4.0'))
    const owner = made.g.members[made.g.ownerId]
    // 回 true 的話，模擬「寫成功了」：呼叫 markVerWritten
    const nv = (v, t) => {
      const w = core.noteVer(owner, v, t)
      if (w) core.markVerWritten(owner, t)
      return w
    }
    assert.equal(owner.ver, '0.4.0')
    const noVer = await core.createGroup({ name: 'VerCore' }, 0)
    assert.equal(noVer.g.members[noVer.g.ownerId].ver, '', '建群組沒帶版本 → 空字串')
    assert.equal(nv( '0.4.0', 1000), false, '沒變不回 true')
    assert.equal(nv( 'web', 1000), true, '第一次變動：馬上單獨寫一次')
    assert.equal(owner.ver, 'web')
    // 新舊版對話並用、版本來回變 49 次：記憶體每次都換，但一小時內不再要求單獨寫（記成待補寫）
    let writes = 0
    for (let i = 0; i < 49; i++) if (nv( i % 2 ? 'web' : '0.5.0', 2000 + i)) writes++
    assert.equal(writes, 0, '來回變 49 次，單獨寫 0 次')
    assert.equal(owner.ver, '0.5.0', '記憶體裡是最後一次看到的')
    assert.equal(nv( '0.5.0', 1000 + H - 1), false, '還差 1 毫秒滿一小時')
    assert.equal(nv( '0.5.0', 1000 + H), true, '滿一小時：就算版本沒再變，也把待補寫的最後一次看到的版本寫進去')
    assert.equal(nv( '0.5.0', 1000 + H + 1), false, '補寫過了，沒變就不再寫')
    assert.equal(nv( 'web', 1000 + H + 2), false, '剛寫過，一小時內又變 → 只改記憶體')
    assert.equal(nv( 'web', 1000 + H + 3), false, '還在一小時內')
    assert.equal(nv( 'web', 1000 + 2 * H + 2), true, '再滿一小時 → 補寫')
    assert.equal(nv( 'web', 1000 + 2 * H + 3), false)
    assert.equal(nv( '0.5.0', 1000 + 2 * H + 4), false, '又變，一小時內')
    assert.equal(nv( '0.5.0', 5), true, '時鐘倒退（now 比上次還早）→ 當作已過期，照寫')
    assert.equal(nv( core.clientVersion('x'.repeat(2000)), 3_000_000_000), true, '亂值＝沒帶＝空字串，跟 0.5.0 不同，而且隔很久')
    assert.equal(owner.ver, '')
    assert.equal(core.noteVer({ name: 'old' }, '', 0), false, '舊資料沒有 ver 欄位，當空字串')
    assert.equal(core.noteVer({ name: 'old' }, '0.4.0', 0), true, '舊資料第一次帶版本 → 寫一次')
    // fix-7：寫之前出錯（路由丟例外、儲存丟錯）就不呼叫 markVerWritten：下個請求就算版本沒再變也要再回 true 重試
    const flaky = Object.values((await core.createGroup({ name: 'Flaky' }, 0)).g.members)[0]
    assert.equal(core.noteVer(flaky, '0.6.0', 100), true)
    assert.equal(core.noteVer(flaky, '0.6.0', 101), true, '沒記成已寫 → 版本沒再變也要再試')
    core.markVerWritten(flaky, 102)
    assert.equal(core.noteVer(flaky, '0.6.0', 103), false, '寫成功了就不再試')
    const rotated = await core.rotateInvite(made.g, made.groupId, made.g.ownerId)
    const joined = await core.join(made.g, made.groupId, { invite: rotated[1].invite, name: 'VerJoin' }, 0, '0.5.0')
    assert.equal(joined[0], 200)
    assert.equal(made.g.members[joined[1].memberId].ver, '0.5.0')
  })
  await check('任何回應的 JSON 裡都沒有 ver（建群組、加入、狀態、好友列表、換碼、踢人、改名、離開；ver-2c）', async () => {
    const hasVer = x => {
      if (Array.isArray(x)) return x.some(hasVer)
      if (x && typeof x === 'object') return Object.entries(x).some(([k, v]) => k === 'ver' || hasVer(v))
      return false
    }
    const go = async (method, path, body, m) => {
      const h = { 'content-type': 'application/json', 'x-friends-version': '7.3.9', 'x-test-ip': '192.0.2.90' }
      if (m) h.authorization = auth(m)
      const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
      const data = await res.json()
      assert.equal(hasVer(data), false, method + ' ' + path + ' 的回應不能有 ver：' + JSON.stringify(data).slice(0, 80))
      assert.ok(!JSON.stringify(data).includes('7.3.9'), method + ' ' + path + ' 的回應裡不能出現帶來的版本值')
      return { status: res.status, data }
    }
    const owner = (await go('POST', '/groups', { name: 'NoVerA' })).data
    const friend = (await go('POST', '/join', { invite: owner.invite, name: 'NoVerB' })).data
    assert.equal((await go('POST', '/status', { state: 'working', conn: 'connNOVER001', action: 'learning', subject: 'game' }, owner)).status, 200)
    const f = await go('GET', '/friends', undefined, friend)
    assert.equal(f.status, 200)
    assert.equal(f.data.members.length, 2)
    assert.equal((await go('POST', '/invite/rotate', {}, owner)).status, 200)
    assert.equal((await go('POST', '/name', { name: 'NoVerRenamed' }, owner)).status, 200)
    assert.equal((await go('POST', '/kick', { memberId: friend.memberId }, owner)).status, 200)
    assert.equal((await go('POST', '/leave', {}, owner)).status, 200)
  })
  await check('X-Friends-Version 帶亂字串、超長、沒帶，各個路徑都照常回應（ver-2b）', async () => {
    const r0 = await call('POST', '/groups', { name: 'Ver' }, undefined, undefined, '192.0.2.72')
    assert.equal(r0.status, 200)
    for (const v of [undefined, '0.4.0', 'web', 'garbage<>"', 'x'.repeat(2000), '9.9.9.9']) {
      const h = { 'content-type': 'application/json', authorization: auth(r0.data), 'x-test-ip': '192.0.2.72' }
      if (v !== undefined) h['x-friends-version'] = v
      const label = v === undefined ? '沒帶' : v.slice(0, 12)
      const st = await fetch(BASE + '/status', { method: 'POST', headers: h, body: JSON.stringify({ state: 'working', conn: 'connVERSION01', action: 'learning', subject: 'game' }) })
      assert.equal(st.status, 200, 'status ' + label)
      assert.equal((await st.json()).ok, true, 'status body ' + label)
      const f = await fetch(BASE + '/friends', { headers: h })
      assert.equal(f.status, 200, 'friends ' + label)
      assert.equal((await f.json()).members.length, 1, 'friends body ' + label)
      const g = await fetch(BASE + '/groups', { method: 'POST', headers: { ...h, authorization: '' }, body: JSON.stringify({ name: 'V' }) })
      assert.equal(g.status, 200, 'groups ' + label)
      const inv = (await g.json()).invite
      const j = await fetch(BASE + '/join', { method: 'POST', headers: { ...h, authorization: '' }, body: JSON.stringify({ invite: inv, name: 'W' }) })
      assert.equal(j.status, 200, 'join ' + label)
      await j.text()
      const hz = await fetch(BASE + '/health', { headers: h })
      assert.equal(hz.status, 200, 'health ' + label)
      await hz.text()
    }
  })
  await check('沒有的路徑 → 404；GET 打 POST 才有的路徑也 404（test-2）', async () => {
    for (const [m, path] of [['GET', '/nope'], ['GET', '/status'], ['POST', '/health'], ['DELETE', '/friends']]) {
      const res = await fetch(BASE + path, { method: m, headers: { 'content-type': 'application/json', 'x-test-ip': '192.0.2.70' } })
      await res.text()
      assert.equal(res.status, 404, `${m} ${path}`)
    }
  })
  await check('POST 沒有內文 → 當成 {}：送狀態照常（只是心跳），建群組缺名字 400（test-2）', async () => {
    const h = { 'content-type': 'application/json', authorization: auth(alice), 'x-test-ip': '192.0.2.71' }
    const st = await fetch(BASE + '/status', { method: 'POST', headers: h })
    assert.equal(st.status, 200)
    await st.text()
    const g = await fetch(BASE + '/groups', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': '192.0.2.71' } })
    assert.equal(g.status, 400)
    await g.text()
  })
  // sec-2 限流：用 x-test-ip 扮成不同 IP（只有測試自己開的中繼認這個標頭），才不會把其他測試一起擋掉。
  // --base 測 Worker 版時跳過：Worker 只認 cf-connecting-ip，灌 600 次會把這台機器本身擋一分鐘
  if (server) {
    await check('限流：同一個 IP 一分鐘超過 600 次 → 429，別的 IP 照常（sec-2）', async () => {
      const ip = '203.0.113.1'
      const codes = []
      for (let i = 0; i < 6; i++) {
        codes.push(...await Promise.all(Array.from({ length: 100 }, () => call('GET', '/health', undefined, undefined, undefined, ip).then(r => r.status))))
      }
      assert.deepEqual(codes.filter(c => c !== 200), [], '前 600 次都要放行')
      assert.equal((await call('GET', '/health', undefined, undefined, undefined, ip)).status, 429)
      assert.equal((await call('POST', '/join', { invite: 'x', name: 'Z' }, undefined, undefined, ip)).status, 429, '被擋時每條路都擋')
      assert.equal((await call('GET', '/health', undefined, undefined, undefined, '203.0.113.2')).status, 200)
    })
    await check('限流：同一個 IP 一小時加入超過 10 次 → 429，別的 IP 還是能加入（sec-2）', async () => {
      const owner = (await call('POST', '/groups', { name: 'Rate' }, undefined, undefined, '203.0.113.10')).data
      const ip = '203.0.113.11'
      // 猜邀請碼：前 10 次照常回「邀請碼不對」，第 11 次起不管對不對都 429
      for (let i = 0; i < 10; i++) {
        assert.equal((await call('POST', '/join', { invite: owner.invite + 'x', name: `G${i}` }, undefined, undefined, ip)).status, 403, `第 ${i + 1} 次`)
      }
      assert.equal((await call('POST', '/join', { invite: owner.invite + 'x', name: 'G11' }, undefined, undefined, ip)).status, 429)
      assert.equal((await call('POST', '/join', { invite: owner.invite, name: 'G12' }, undefined, undefined, ip)).status, 429, '拿對的邀請碼也一樣擋')
      const other = await call('POST', '/join', { invite: owner.invite, name: 'Other' }, undefined, undefined, '203.0.113.12')
      assert.equal(other.status, 200)
      assert.ok(other.data.memberKey)
    })
  } else {
    console.log('  - 限流兩條、HTTP 模糊測試略過（--base 測的中繼只認真正的連線 IP，灌請求會把這台機器自己擋掉）')
  }
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
