import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { TEST_RESPONSE_SIGNING } from './test-fixtures/response-signing-key.mjs'

const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url))
const signingEnv = { RESPONSE_SIGNING_PRIVATE_KEY: TEST_RESPONSE_SIGNING.privateKeyPkcs8, RESPONSE_SIGNING_KEY_ID: TEST_RESPONSE_SIGNING.keyId }

async function start(vars = {}) {
  const port = 32000 + Math.floor(Math.random() * 10000)
  const base = `http://127.0.0.1:${port}`
  let stderr = ''
  const child = spawn(process.execPath, [serverPath, '--port', String(port)], {
    stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...signingEnv, ...vars },
  })
  child.stderr.on('data', data => { stderr += data })
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error(`Node relay exited ${child.exitCode}: ${stderr}`)
    try { if ((await fetch(base + '/health')).ok) return { child, base } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  child.kill()
  throw new Error(`Node relay was not ready: ${stderr}`)
}

const stop = child => child?.kill()
const post = async (base, path, body) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, data: await response.json() }
}

let passed = 0
const failed = []
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`) }
  catch (error) { failed.push(name); console.log(`  ✗ ${name}\n    ${error.message.split('\n').join('\n    ')}`) }
}

await check('Node 公開模式在門檻擋新 membership，既有 membership 不受影響', async () => {
  const server = await start({ FRIENDS_PUBLIC_CAPACITY: '1', FRIENDS_CAP_BLOCK: '2' })
  try {
    const alice = (await post(server.base, '/groups', { name: 'Alice' })).data
    assert.equal((await post(server.base, '/groups', { name: '' })).status, 400)
    assert.equal((await post(server.base, '/join', { name: 'Bob', invite: alice.invite })).status, 200)
    const full = await post(server.base, '/groups', { name: 'Carol' })
    assert.equal(full.status, 503)
    assert.match(full.data.error, /自架中繼/)
    const friends = await fetch(server.base + '/friends', { headers: { authorization: `Bearer ${alice.groupId}.${alice.memberId}.${alice.memberKey}` } })
    assert.equal(friends.status, 200)
  } finally { stop(server.child) }
})

await check('Node 自架預設不啟用容量門檻', async () => {
  const server = await start({ FRIENDS_CAP_BLOCK: '1' })
  try {
    assert.equal((await post(server.base, '/groups', { name: 'Alice' })).status, 200)
    assert.equal((await post(server.base, '/groups', { name: 'Bob' })).status, 200)
  } finally { stop(server.child) }
})

console.log(`\n${passed} passed, ${failed.length} failed`)
process.exitCode = failed.length ? 1 : 0
