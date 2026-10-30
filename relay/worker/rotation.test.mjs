// L-SEC-ROTATE-1：自啟 Wrangler，驗證邀請碼世代、簽章、權限與重啟持久性。
// 執行：node relay/worker/rotation.test.mjs
import { spawn, execFileSync } from 'node:child_process'
import { createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { TEST_RESPONSE_SIGNING } from '../test-fixtures/response-signing-key.mjs'
import { fromB64url, responseEnvelope } from '../response-signing.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const wrangler = join(here, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const persist = mkdtempSync(join(tmpdir(), 'friends-rotation-'))
const port = 24000 + Math.floor(Math.random() * 4000)
const base = `http://127.0.0.1:${port}`
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
const publicKey = createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(fromB64url(TEST_RESPONSE_SIGNING.publicKey))]), format: 'der', type: 'spki' })
let child
let stderr = ''

async function start() {
  stderr = ''
  child = spawn(process.execPath, [wrangler, 'dev', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist,
    '--show-interactive-dev-session=false', '--var', `RESPONSE_SIGNING_PRIVATE_KEY:${TEST_RESPONSE_SIGNING.privateKeyPkcs8}`,
    '--var', `RESPONSE_SIGNING_KEY_ID:${TEST_RESPONSE_SIGNING.keyId}`], {
    cwd: here, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, XDG_CONFIG_HOME: join(persist, 'xdg') },
  })
  child.stderr.on('data', data => { stderr += data })
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`wrangler dev 提前結束（exit ${child.exitCode}）：${stderr}`)
    try { if ((await fetch(base + '/health')).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`wrangler dev 60 秒未就緒：${stderr}`)
}

async function stop() {
  if (!child) return
  const exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve()
  if (process.platform === 'win32') try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  else child.kill()
  child.stderr?.destroy()
  child.kill()
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))])
  child.unref()
  child = undefined
}

const auth = m => `Bearer ${m.groupId}.${m.memberId}.${m.memberKey}`
async function call(method, path, body, member) {
  const nonce = randomBytes(18).toString('base64url')
  const headers = { 'content-type': 'application/json', 'x-friends-nonce': nonce, 'x-friends-origin': base, 'x-friends-version': '0.5.6' }
  if (member) headers.authorization = auth(member)
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const bodyText = await response.text()
  const signature = Buffer.from(fromB64url(response.headers.get('x-friends-signature')))
  assert.equal(verifySignature(null, responseEnvelope({ nonce, origin: base, method, path, status: response.status, body: bodyText }), publicKey, signature), true,
    `${method} ${path} 必須簽完整 envelope`)
  return { status: response.status, data: JSON.parse(bodyText) }
}

const hasNoInvite = value => {
  if (Array.isArray(value)) return value.every(hasNoInvite)
  if (!value || typeof value !== 'object') return true
  return Object.entries(value).every(([key, childValue]) => key !== 'invite' && key !== 'inviteGeneration' && hasNoInvite(childValue))
}

let passed = 0
let failed = 0
try {
  await start()
  const owner = (await call('POST', '/groups', { name: 'Owner' })).data
  assert.equal(owner.inviteGeneration, 0)
  const member = (await call('POST', '/join', { invite: owner.invite, name: 'Member' })).data
  assert.equal(member.inviteGeneration, 0)

  assert.equal((await call('POST', '/invite/rotate', {}, member)).status, 403)
  const rotations = await Promise.all([
    call('POST', '/invite/rotate', {}, owner),
    call('POST', '/invite/rotate', {}, owner),
  ])
  const [first, second] = rotations.sort((a, b) => a.data.inviteGeneration - b.data.inviteGeneration)
  assert.deepEqual([first.status, first.data.inviteGeneration, second.status, second.data.inviteGeneration], [200, 1, 200, 2])
  assert.notEqual(first.data.invite, second.data.invite)
  assert.equal((await call('POST', '/join', { invite: first.data.invite, name: 'Old' })).status, 403, '舊邀請碼必須失效')
  assert.equal((await call('POST', '/join', { invite: second.data.invite, name: 'New' })).status, 200, '最新邀請碼可使用')
  const kicked = await call('POST', '/kick', { memberId: member.memberId }, owner)
  assert.deepEqual([kicked.status, kicked.data.inviteGeneration], [200, 3], 'kick 必須走同一條單調換碼路徑')
  assert.equal((await call('GET', '/friends', undefined, member)).status, 401, '被移除者金鑰必須失效')
  assert.equal((await call('POST', '/join', { invite: second.data.invite, name: 'KickedBack' })).status, 403, 'kick 前的邀請碼必須失效')
  assert.equal((await call('POST', '/join', { invite: kicked.data.invite, name: 'AfterKick' })).status, 200, 'kick 後的新邀請碼可用')
  // 0.5.6：找不到這個人是 404（重試已成功的踢人不能被當成「請求不對」）；Worker 與 Node 同一段 core 程式
  assert.equal((await call('POST', '/kick', { memberId: member.memberId }, owner)).status, 404, '已經被踢的人再踢一次：404')
  assert.equal((await call('POST', '/kick', {}, owner)).status, 400, '沒給 memberId：400')
  // 0.5.6：暫停是成員層級（Worker 與 Node 同一段 core 程式）；兩個對話交錯送心跳，晚到的 working 不外漏，明確 paused:false 才恢復
  const me = async body => (await call('POST', '/status', body, owner)).data.members.find(m => m.isMe)
  assert.equal((await me({ state: 'working', conn: 'pauseconnA1' })).presence, 'working', '前提：沒暫停時看得到 working')
  assert.equal((await me({ state: 'idle', conn: 'pauseconnA1', paused: true })).presence, 'idle')
  assert.equal((await me({ state: 'working', conn: 'pauseconnB2' })).presence, 'idle', '另一個對話晚到的 working 心跳不外漏')
  assert.equal((await me({ state: 'working', conn: 'pauseconnB2', paused: false })).presence, 'working', '明確 resume 後恢復')
  assert.equal((await me({ state: 'offline', conn: 'pauseconnA1' })).presence, 'working')
  assert.equal((await me({ state: 'offline', conn: 'pauseconnB2' })).presence, 'offline')
  assert.equal(hasNoInvite((await call('GET', '/friends', undefined, owner)).data), true, '/friends 不得洩漏邀請資料')
  assert.equal(hasNoInvite((await call('POST', '/status', { state: 'idle', conn: 'rotation01' }, owner)).data), true, '/status 不得洩漏邀請資料')

  await stop()
  await start()
  const third = await call('POST', '/invite/rotate', {}, owner)
  assert.equal(third.data.inviteGeneration, 4, 'Wrangler 重啟後世代不得倒退')
  assert.equal((await call('POST', '/join', { invite: kicked.data.invite, name: 'Old2' })).status, 403)
  passed = 1
  console.log('  ✓ Worker 邀請碼世代、403、簽章、無洩漏、重啟持久性')
} catch (error) {
  failed = 1
  console.log(`  ✗ Worker 邀請碼世代\n    ${error.stack ?? error}`)
} finally {
  await stop()
  for (let i = 0; i <= 30; i++) {
    try { rmSync(persist, { recursive: true, force: true }); break } catch {
      if (i === 30) console.log(`  ⚠ 暫存目錄仍被占用，請稍後刪除：${persist}`)
      else await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
