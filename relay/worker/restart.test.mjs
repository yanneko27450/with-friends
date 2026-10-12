// Worker 版才有的行為：Durable Object 重開（部署、閒置被回收）之後
//   ① 群組、金鑰、動態都還在（有寫進 SQLite）
//   ② 在線狀態是空的（心跳只放記憶體，不寫資料庫：relay/COST.md）
//   ③ 全員離開的群組整組刪掉，重開後舊邀請碼也加不進去
// 用法：node relay/worker/restart.test.mjs（自己開兩次 wrangler dev，資料放暫存資料夾，跑完刪掉）
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = fileURLToPath(new URL('.', import.meta.url))
const wrangler = join(here, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const persist = mkdtempSync(join(tmpdir(), 'friends-relay-'))

async function startRelay(port) {
  const child = spawn(process.execPath, [wrangler, 'dev', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist, '--show-interactive-dev-session=false'], {
    cwd: here, stdio: 'ignore',
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
function stopRelay(r) {
  // Windows：wrangler 底下還有 workerd，要整棵樹一起關
  // 程序已經自己結束時 taskkill 會丟錯，不影響
  if (process.platform === 'win32') try { execFileSync('taskkill', ['/pid', String(r.child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  else r.child.kill()
}

const auth = m => `Bearer ${m.groupId}.${m.memberId}.${m.memberKey}`
async function call(base, method, path, body, m) {
  const headers = { 'content-type': 'application/json' }
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

let r = await startRelay(8797)
let alice, bob, solo
try {
  alice = (await call(r.base, 'POST', '/groups', { name: 'Alice' })).data
  bob = (await call(r.base, 'POST', '/join', { invite: alice.invite, name: 'Bob' })).data
  await call(r.base, 'POST', '/status', { conn: 'convAAAAAAAA', state: 'working', action: 'fixing-bugs', subject: 'website' }, alice)
  solo = (await call(r.base, 'POST', '/groups', { name: 'Solo' })).data
  assert.equal((await call(r.base, 'POST', '/leave', {}, solo)).status, 200)
  const before = (await call(r.base, 'GET', '/friends', undefined, bob)).data.members.find(m => m.name === 'Alice')
  assert.equal(before.presence, 'working', '重開前 Alice 應該是工作中')

  stopRelay(r)
  r = await startRelay(8798)

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
  stopRelay(r)
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
