// sec-3 資料保存期限與刪除：Node 開發版和 Worker 版各跑一次。
// 保存期限縮成 3 秒來測（正式是 24 小時），而且直接讀底下存的資料（JSON 檔／Durable Object 的 SQLite），
// 確認是真的刪掉，不是只有 API 不顯示：
//   ① 動態過期後，沒有任何人來讀，資料庫裡也已經沒有那筆動態
//   ② 離開群組後，資料庫裡找不到這個人
// 用法：node relay/expiry.test.mjs（Worker 版要先在 relay/worker 跑過 npm install）
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = fileURLToPath(new URL('.', import.meta.url))
const TTL = 3000
const ACTIVITY = { action: 'fixing-bugs', subject: 'website' }
const LEAVER = 'Leaver-zq'

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitUp(base) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + '/health')).ok) return
    } catch {}
    await sleep(1000)
  }
  throw new Error(`${base} 60 秒沒起來`)
}
function killTree(child) {
  // 程序已經自己結束時 taskkill 會丟錯，不影響
  if (process.platform === 'win32') try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  else child.kill()
}
async function removeDir(dir) {
  // Windows：程序關掉後要過一陣子才放開檔案
  for (let i = 0; i < 30; i++) {
    try {
      return rmSync(dir, { recursive: true, force: true })
    } catch {
      await sleep(1000)
    }
  }
  console.log(`  （暫存資料夾刪不掉，請手動刪：${dir}）`)
}

// 兩種中繼：怎麼開、怎麼直接讀它存的東西（回傳一個字串，拿來找有沒有那筆資料）
const relays = {
  'Node 開發版': dir => {
    const data = join(dir, 'relay-data.json')
    const child = spawn(process.execPath, [join(here, 'server.mjs'), '--port', '18788', '--data', data, '--activity-ttl-ms', String(TTL)], { stdio: 'ignore' })
    return { child, base: 'http://127.0.0.1:18788', stored: () => (existsSync(data) ? readFileSync(data, 'utf8') : '') }
  },
  'Worker 版': dir => {
    const wrangler = join(here, 'worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
    const child = spawn(process.execPath, [wrangler, 'dev', '--ip', '127.0.0.1', '--port', '8796', '--persist-to', dir, '--var', `ACTIVITY_TTL_MS:${TTL}`, '--show-interactive-dev-session=false'], {
      cwd: join(here, 'worker'), stdio: 'ignore',
    })
    const doDir = join(dir, 'v3', 'do', 'friends-status-relay-Group')
    const stored = () => {
      if (!existsSync(doDir)) return ''
      let all = ''
      for (const f of readdirSync(doDir).filter(f => f.endsWith('.sqlite'))) {
        const db = new DatabaseSync(join(doDir, f), { readOnly: true })
        try {
          // metadata.sqlite 是 alarm 排程表，沒有 _cf_KV
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = '_cf_KV'").get()) continue
          for (const row of db.prepare('SELECT key, value FROM _cf_KV').all()) all += row.key + Buffer.from(row.value).toString('latin1')
        } finally {
          db.close()
        }
      }
      return all
    }
    return { child, base: 'http://127.0.0.1:8796', stored }
  },
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

for (const [label, start] of Object.entries(relays)) {
  console.log(label)
  const dir = mkdtempSync(join(tmpdir(), 'friends-expiry-'))
  const r = start(dir)
  try {
    await waitUp(r.base)
    const alice = (await call(r.base, 'POST', '/groups', { name: 'Alice' })).data
    const bob = (await call(r.base, 'POST', '/join', { invite: alice.invite, name: 'Bob' })).data
    const leaver = (await call(r.base, 'POST', '/join', { invite: alice.invite, name: LEAVER })).data
    await call(r.base, 'POST', '/status', { conn: 'convAAAAAAAA', state: 'working', ...ACTIVITY }, alice)

    await check('期限內：好友看得到動態，資料庫裡也有', async () => {
      const a = (await call(r.base, 'GET', '/friends', undefined, bob)).data.members.find(m => m.name === 'Alice')
      assert.deepEqual([a.action, a.subject], [ACTIVITY.action, ACTIVITY.subject])
      assert.ok(r.stored().includes(ACTIVITY.action), '資料庫裡應該有這筆動態（不然下一條的檢查沒意義）')
    })
    await check('過期後沒人來讀，資料庫裡的動態也已經清掉', async () => {
      await sleep(TTL + 4000)
      assert.ok(!r.stored().includes(ACTIVITY.action), '過期的動態還在資料庫裡')
      const a = (await call(r.base, 'GET', '/friends', undefined, bob)).data.members.find(m => m.name === 'Alice')
      assert.deepEqual([a.action, a.subject, a.activityAgoSec], ['', '', null])
    })
    await check('離開群組後，資料庫裡找不到這個人', async () => {
      assert.ok(r.stored().includes(LEAVER), '離開前資料庫裡應該有這個人')
      assert.equal((await call(r.base, 'POST', '/leave', {}, leaver)).status, 200)
      assert.ok(!r.stored().includes(LEAVER), '離開後資料庫裡還有這個人')
      assert.equal((await call(r.base, 'GET', '/friends', undefined, leaver)).status, 401)
    })
  } finally {
    killTree(r.child)
    await removeDir(dir)
  }
}

console.log(`\n${passed} 通過，${failed.length} 失敗`)
process.exitCode = failed.length ? 1 : 0
