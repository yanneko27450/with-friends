// sec-16b C：自己啟動真實 wrangler/workerd，驗 Worker 回應的完整 Ed25519 envelope。
// 用法：node relay/worker/signing.test.mjs
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
const persist = mkdtempSync(join(tmpdir(), 'friends-signing-'))
const port = 21000 + Math.floor(Math.random() * 2000)
const base = `http://127.0.0.1:${port}`
let child
let stderr = ''

const stop = async () => {
  if (!child) return
  const exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve()
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  } else child.kill()
  child.stderr?.destroy()
  child.kill()
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))])
  child.unref()
}

let passed = 0
const failed = []
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed.push(name)
    console.log(`  ✗ ${name}\n    ${error.message.split('\n').join('\n    ')}`)
  }
}

try {
  child = spawn(process.execPath, [wrangler, 'dev', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist,
    '--show-interactive-dev-session=false', '--var', `RESPONSE_SIGNING_PRIVATE_KEY:${TEST_RESPONSE_SIGNING.privateKeyPkcs8}`,
    '--var', `RESPONSE_SIGNING_KEY_ID:${TEST_RESPONSE_SIGNING.keyId}`], {
    cwd: here, stdio: ['ignore', 'ignore', 'pipe'],
    // Wrangler 的 log／registry 也留在本測試暫存目錄，CI／sandbox 不必寫使用者設定資料夾。
    env: { ...process.env, XDG_CONFIG_HOME: join(persist, 'xdg') },
  })
  child.stderr.on('data', data => { stderr += data })
  let ready = false
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`wrangler dev 提早結束（exit ${child.exitCode}）：${stderr}`)
    try { if ((await fetch(base + '/health')).ok) { ready = true; break } } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (!ready) throw new Error(`wrangler dev 60 秒沒起來：${stderr}`)

  await check('Worker 真實 API 回應簽完整 envelope；六個欄位任一變動都驗不過（sec-16b C）', async () => {
    const nonce = randomBytes(18).toString('base64url')
    const method = 'POST'
    const path = '/groups'
    const requestBody = JSON.stringify({ name: 'Signing test' })
    const response = await fetch(base + path, { method, headers: {
      'content-type': 'application/json', 'x-friends-nonce': nonce, 'x-friends-origin': base,
    }, body: requestBody })
    const body = await response.text()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-friends-key-id'), TEST_RESPONSE_SIGNING.keyId)
    assert.equal(response.headers.get('x-friends-nonce'), nonce)
    const signature = Buffer.from(fromB64url(response.headers.get('x-friends-signature')))
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
    const publicKey = createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(fromB64url(TEST_RESPONSE_SIGNING.publicKey))]), format: 'der', type: 'spki' })
    const fields = { nonce, origin: base, method, path, status: response.status, body }
    const verifies = value => verifySignature(null, responseEnvelope(value), publicKey, signature)
    assert.equal(verifies(fields), true)
    for (const [field, changed] of [
      ['nonce', nonce + 'A'], ['origin', base + '/other'], ['method', 'GET'], ['path', '/friends'],
      ['status', 201], ['body', body + ' '],
    ]) assert.equal(verifies({ ...fields, [field]: changed }), false, `改動 ${field} 後仍通過`)
  })
} catch (error) {
  failed.push('Worker 啟動／測試框架')
  console.log(`  ✗ Worker 啟動／測試框架\n    ${error.message.split('\n').join('\n    ')}`)
} finally {
  await stop()
  for (let i = 0; i <= 30; i++) {
    try { rmSync(persist, { recursive: true, force: true }); break } catch {
      if (i === 30) console.log(`  （暫存資料夾刪不掉，請手動刪：${persist}）`)
      else await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
}

console.log(`\n${passed} 通過，${failed.length} 失敗`)
process.exitCode = failed.length ? 1 : 0
