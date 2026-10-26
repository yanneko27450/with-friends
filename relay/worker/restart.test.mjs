// Worker 版才有的行為：Durable Object 重開（部署、閒置被回收）之後
//   ① 群組、金鑰、動態都還在（有寫進 SQLite）
//   ② 在線狀態是空的（心跳只放記憶體，不寫資料庫：relay/COST.md）
//   ③ 全員離開的群組整組刪掉，重開後舊邀請碼也加不進去
//   ④ 成員最後帶來的版本（X-Friends-Version）存在資料庫（解開 SQLite 逐欄位看 ver）、重開後還在，而且不會出現在任何回應（ver-2c）；
//      帶亂字串、超長、四段版本號的請求照常回應，ver 存成空字串（L-11）；
//      新舊版本來回變時不會每次都寫資料庫：第一次變動寫，之後只改記憶體，跟下一次本來就要寫的事一起存（fix-6）
// 用法：node relay/worker/restart.test.mjs（自己開兩次 wrangler dev，資料放暫存資料夾，跑完刪掉）
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { deserialize } from 'node:v8'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { TEST_RESPONSE_SIGNING } from '../test-fixtures/response-signing-key.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const wrangler = join(here, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const persist = mkdtempSync(join(tmpdir(), 'friends-relay-'))

async function startRelay(port) {
  const child = spawn(process.execPath, [wrangler, 'dev', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist, '--show-interactive-dev-session=false', '--var', `RESPONSE_SIGNING_PRIVATE_KEY:${TEST_RESPONSE_SIGNING.privateKeyPkcs8}`, '--var', `RESPONSE_SIGNING_KEY_ID:${TEST_RESPONSE_SIGNING.keyId}`], {
    cwd: here, stdio: 'ignore', env: { ...process.env, XDG_CONFIG_HOME: join(persist, 'xdg') },
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + '/health')).ok) return { child, base }
    } catch {}
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('wrangler dev 60 秒沒起來')
}
async function stopRelay(r) {
  const exited = r.child.exitCode === null ? new Promise(resolve => r.child.once('exit', resolve)) : Promise.resolve()
  // Windows：wrangler 底下還有 workerd，要整棵樹一起關
  // 程序已經自己結束時 taskkill 會丟錯，不影響
  if (process.platform === 'win32') try { execFileSync('taskkill', ['/pid', String(r.child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  else r.child.kill()
  r.child.kill()
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))])
  r.child.unref()
}

// 直接讀 Durable Object 底下的 SQLite（做法同 relay/expiry.test.mjs），把存的群組用 v8.deserialize 解開，回傳那個成員的資料（L-11：逐欄位確認，不是搜字串）
const storedMember = m => {
  const doDir = join(persist, 'v3', 'do', 'friends-status-relay-Group')
  if (!existsSync(doDir)) return undefined
  for (const f of readdirSync(doDir).filter(f => f.endsWith('.sqlite'))) {
    const db = new DatabaseSync(join(doDir, f), { readOnly: true })
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = '_cf_KV'").get()) continue
      for (const row of db.prepare("SELECT key, value FROM _cf_KV WHERE key = 'group'").all()) {
        const g = deserialize(Buffer.from(row.value))
        if (g.members?.[m.memberId]) return g.members[m.memberId]
      }
    } finally {
      db.close()
    }
  }
  return undefined
}
const VER = '7.7.7'

const auth = m => `Bearer ${m.groupId}.${m.memberId}.${m.memberKey}`
async function call(base, method, path, body, m, ver) {
  const headers = { 'content-type': 'application/json' }
  if (ver) headers['x-friends-version'] = ver
  if (m) headers.authorization = auth(m)
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
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

const firstPort = 30000 + Math.floor(Math.random() * 10000)
let r = await startRelay(firstPort)
let alice, bob, solo
try {
  alice = (await call(r.base, 'POST', '/groups', { name: 'Alice' })).data
  bob = (await call(r.base, 'POST', '/join', { invite: alice.invite, name: 'Bob' })).data
  await call(r.base, 'POST', '/status', { conn: 'convAAAAAAAA', state: 'working', action: 'fixing-bugs', subject: 'website' }, alice, VER)
  solo = (await call(r.base, 'POST', '/groups', { name: 'Solo' })).data
  assert.equal((await call(r.base, 'POST', '/leave', {}, solo)).status, 200)
  assert.equal(storedMember(alice)?.ver, VER, '重開前：Alice 帶來的版本已經寫進資料庫')
  assert.equal(storedMember(bob)?.ver, '', '重開前：Bob 從來沒帶版本 → 空字串')
  const before = (await call(r.base, 'GET', '/friends', undefined, bob)).data.members.find(m => m.name === 'Alice')
  assert.equal(before.presence, 'working', '重開前 Alice 應該是工作中')

  await stopRelay(r)
  r = await startRelay(firstPort + 1)

  // 放在最前面：後面的檢查會用沒帶版本的請求打 Alice，版本就被換成空字串（最後一次看到的版本）
  await check('重開後：Alice 最後帶來的版本還在資料庫；任何回應裡都沒有（ver-2c）', async () => {
    assert.equal(storedMember(alice)?.ver, VER, 'Alice 的 ver 欄位重開後還在')
    assert.equal(storedMember(bob)?.ver, '', 'Bob 的 ver 欄位是空字串')
    const f = await call(r.base, 'GET', '/friends', undefined, bob, VER)
    assert.equal(f.status, 200)
    assert.ok(!JSON.stringify(f.data).includes(VER), '好友列表不能出現版本')
    assert.ok(!('ver' in f.data.members[0]), '成員資料不能有 ver 欄位')
    assert.equal(storedMember(bob)?.ver, VER, 'Bob 帶了版本 → 寫進資料庫（給下一個檢查當起點）')
  })
  await check('重開後：亂版本存空字串；新舊版本來回變時不會每次都寫資料庫，下一次本來就要寫的事會一起存（L-11／fix-6）', async () => {
    // 另開一個群組，不動前面 Alice、Bob 那組（後面的檢查還要用）
    const zed = (await call(r.base, 'POST', '/groups', { name: 'Zed' }, undefined, VER)).data
    const others = []
    for (const n of ['Amy', 'Ben', 'Cal']) others.push((await call(r.base, 'POST', '/join', { invite: zed.invite, name: n }, undefined, VER)).data)
    assert.equal(storedMember(zed)?.ver, VER, '建群組帶版本 → 存下來')
    // 亂字串、超長、四段版本號：照常回應，存空字串（每個成員第一次變動都馬上寫）
    for (const [i, v] of ['junk<>"', 'x'.repeat(2000), '9.9.9.9'].entries()) {
      assert.equal(storedMember(others[i])?.ver, VER)
      assert.equal((await call(r.base, 'GET', '/friends', undefined, others[i], v)).status, 200, '照常回應 ' + v.slice(0, 12))
      assert.equal(storedMember(others[i])?.ver, '', '存空字串 ' + v.slice(0, 12))
    }
    // fix-6：新成員第一次變動 → 馬上寫；之後新舊版本來回變 49 次（舊對話 2.0.0、新對話 1.0.0 並用）只改記憶體，資料庫裡還是第一次寫的。
    // 連續 49 次請求中間若剛好遇到 Durable Object 被回收重載（記憶體裡的節流時間重來），會多寫一次而讓這個斷言誤失敗：
    // 最多換成新成員重試一次（拿掉節流的話每次都會失敗）
    const flip = async m => {
      assert.equal((await call(r.base, 'GET', '/friends', undefined, m, '1.0.0')).status, 200)
      assert.equal(storedMember(m)?.ver, '1.0.0', '第一次變動 → 馬上寫')
      for (let i = 0; i < 49; i++) assert.equal((await call(r.base, 'GET', '/friends', undefined, m, i % 2 ? '1.0.0' : '2.0.0')).status, 200)
      return storedMember(m)?.ver
    }
    let flipped = await flip(zed)
    let flipper = zed
    if (flipped !== '1.0.0') {
      flipper = (await call(r.base, 'POST', '/join', { invite: zed.invite, name: 'Dee' }, undefined, VER)).data
      flipped = await flip(flipper)
    }
    assert.equal(flipped, '1.0.0', '來回變 49 次，資料庫裡沒有跟著變（沒有每次都寫）')
    // 下一次本來就要寫的事（動態換了）把記憶體裡最後看到的版本一起寫進去
    assert.equal((await call(r.base, 'POST', '/status', { conn: 'convZZZZZZZZ', state: 'working', action: 'learning', subject: 'game' }, flipper, '2.0.0')).status, 200)
    assert.equal(storedMember(flipper)?.ver, '2.0.0', '動態換了 → 一起寫下最後看到的版本')
    assert.equal(storedMember(alice)?.ver, VER, 'Alice 沒被動到')
  })
  await check('重開後：只送心跳（沒有動態）帶新版本、非建立者換邀請碼被擋（403）、null 內文被擋（400）之後，版本都照樣寫進資料庫（fix-7）', async () => {
    const owner = (await call(r.base, 'POST', '/groups', { name: 'Fay' }, undefined, VER)).data
    const joinAs = async name => (await call(r.base, 'POST', '/join', { invite: owner.invite, name }, undefined, VER)).data
    // ① 只送心跳（沒有動態）：core.status 說沒有東西要寫，只有版本要寫
    const hb = await joinAs('Gus')
    assert.equal((await call(r.base, 'POST', '/status', { conn: 'convHEARTBEAT', state: 'idle' }, hb, '5.0.0')).status, 200)
    assert.equal(storedMember(hb)?.ver, '5.0.0', '只送心跳也把新版本寫進去')
    // ② 非建立者換邀請碼 → 403（路由自己不寫），版本仍要寫
    const rot = await joinAs('Hal')
    assert.equal((await call(r.base, 'POST', '/invite/rotate', {}, rot, '5.1.0')).status, 403)
    assert.equal(storedMember(rot)?.ver, '5.1.0', '被擋的請求也把新版本寫進去')
    // ③ 非建立者踢人 → 403，同理
    const kk = await joinAs('Ivy')
    assert.equal((await call(r.base, 'POST', '/kick', { memberId: owner.memberId }, kk, '5.2.0')).status, 403)
    assert.equal(storedMember(kk)?.ver, '5.2.0')
    // ④ 內文是 null 的 POST /status → 400；之後帶新版本的請求，版本還是寫得進去
    const nul = await joinAs('Jon')
    assert.equal((await call(r.base, 'POST', '/status', null, nul, '5.3.0')).status, 400)
    for (let i = 0; i < 5; i++) assert.equal((await call(r.base, 'GET', '/friends', undefined, nul, '5.3.0')).status, 200)
    assert.equal(storedMember(nul)?.ver, '5.3.0', 'null 內文那次之後，版本仍然寫進資料庫')
  })
  await check('重開後：群組、兩個人的金鑰、Alice 的動態都還在', async () => {
    const f = await call(r.base, 'GET', '/friends', undefined, bob)
    assert.equal(f.status, 200)
    assert.deepEqual(f.data.members.map(m => m.name).sort(), ['Alice', 'Bob'])
    const a = f.data.members.find(m => m.name === 'Alice')
    assert.deepEqual([a.action, a.subject], ['fixing-bugs', 'website'])
    assert.equal((await call(r.base, 'GET', '/friends', undefined, alice)).status, 200)
  })
  await check('重開後：在線狀態沒存（心跳不寫資料庫），等下一次心跳補回', async () => {
    let a = (await call(r.base, 'GET', '/friends', undefined, bob)).data.members.find(m => m.name === 'Alice')
    assert.equal(a.presence, 'offline')
    await call(r.base, 'POST', '/status', { conn: 'convAAAAAAAA', state: 'idle' }, alice)
    a = (await call(r.base, 'GET', '/friends', undefined, bob)).data.members.find(m => m.name === 'Alice')
    assert.deepEqual([a.presence, a.action], ['idle', 'fixing-bugs'])
  })
  await check('重開後：全員離開的群組已經刪掉，舊邀請碼加不進去', async () => {
    const j = await call(r.base, 'POST', '/join', { invite: solo.invite, name: 'Late' })
    assert.equal(j.status, 403)
  })
} finally {
  await stopRelay(r)
  // Windows：workerd 被關掉後要過一陣子才放開 SQLite 檔案
  for (let i = 0; ; i++) {
    try {
      rmSync(persist, { recursive: true, force: true })
      break
    } catch (err) {
      if (i >= 30) {
        console.log(`  （暫存資料夾刪不掉，請手動刪：${persist}）`)
        break
      }
      await new Promise(r => setTimeout(r, 1000))
    }
  }
}

console.log(`\n${passed} 通過，${failed.length} 失敗`)
process.exitCode = failed.length ? 1 : 0
