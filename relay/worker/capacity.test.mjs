import assert from 'node:assert/strict'
import { createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto'
import { startWorker, stopWorker } from './wrangler-test-server.mjs'
import { CAPACITY_BLOCK, CAPACITY_PUBLIC, CAPACITY_WARNING } from '../capacity.mjs'
import { TEST_RESPONSE_SIGNING } from '../test-fixtures/response-signing-key.mjs'
import { fromB64url, responseEnvelope } from '../response-signing.mjs'

let passed = 0
const failed = []
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`) }
  catch (error) { failed.push(name); console.log(`  ✗ ${name}\n    ${error.message.split('\n').join('\n    ')}`) }
}
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
const publicKey = createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(fromB64url(TEST_RESPONSE_SIGNING.publicKey))]), format: 'der', type: 'spki' })
const call = async (base, method, path, body, headers = {}) => {
  const nonce = randomBytes(18).toString('base64url')
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-friends-nonce': nonce, 'x-friends-origin': base, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  const signature = Buffer.from(fromB64url(response.headers.get('x-friends-signature')))
  assert.equal(verifySignature(null, responseEnvelope({ nonce, origin: base, method, path, status: response.status, body: text }), publicKey, signature), true)
  return { status: response.status, data: JSON.parse(text) }
}
const post = (base, path, body) => call(base, 'POST', path, body)

await check('正式容量預設固定為 900／950／1000', () => {
  assert.deepEqual([CAPACITY_WARNING, CAPACITY_BLOCK, CAPACITY_PUBLIC], [900, 950, 1000])
})

await check('Worker 公開模式同步預留，失敗會取消，達門檻只擋新 membership', async () => {
  const worker = await startWorker({ FRIENDS_PUBLIC_CAPACITY: '1', FRIENDS_OPS_STATS: '1', FRIENDS_CAP_WARNING: '1', FRIENDS_CAP_BLOCK: '2', FRIENDS_CAP_PUBLIC: '3', FRIENDS_ADMIN_KEY: 'capacity-admin-key-123456789' })
  try {
    const alice = (await post(worker.base, '/groups', { name: 'Alice' })).data
    assert.equal((await post(worker.base, '/groups', { name: '' })).status, 400, '失敗的建立不可吃掉預留')
    assert.equal((await post(worker.base, '/join', { name: 'Bob', invite: alice.invite })).status, 200)
    const full = await post(worker.base, '/groups', { name: 'Carol' })
    assert.equal(full.status, 503)
    assert.match(full.data.error, /自架中繼/)
    const existing = await fetch(worker.base + '/friends', { headers: { authorization: `Bearer ${alice.groupId}.${alice.memberId}.${alice.memberKey}` } })
    assert.equal(existing.status, 200)
    const stats = await fetch(worker.base + '/admin/stats', { headers: { authorization: 'Bearer capacity-admin-key-123456789' } })
    const data = await stats.json()
    assert.deepEqual(data.capacity, { unit: 'rolling7ActiveMemberships', warningAt: 1, warning: true, blockNewAt: 2, publicCapacity: 3 })
    assert.equal(data.rolling7ActiveMemberships, 2)
    assert.equal(data.reservationCount, 0)
    assert.equal(worker.stderr().includes('capacity-admin-key-123456789'), false, '營運 log 不可印管理金鑰')
  } finally { await stopWorker(worker) }
})

await check('Worker 自架預設不啟用容量門檻', async () => {
  const worker = await startWorker({ FRIENDS_CAP_BLOCK: '1' })
  try {
    assert.equal((await post(worker.base, '/groups', { name: 'Alice' })).status, 200)
    assert.equal((await post(worker.base, '/groups', { name: 'Bob' })).status, 200)
  } finally { await stopWorker(worker) }
})

for (const fault of ['admit', 'report', 'cancel']) {
  await check(`stats ${fault} 故障遵守 admission／commit point`, async () => {
    const vars = { FRIENDS_PUBLIC_CAPACITY: '1', FRIENDS_CAP_BLOCK: '2', FRIENDS_TEST_STATS_FAULT: fault, FRIENDS_TEST_RESERVATION_MS: '150' }
    let worker = await startWorker(vars)
    try {
      const first = await post(worker.base, '/groups', { name: `Fault ${fault}` })
      if (fault === 'admit') {
        assert.equal(first.status, 503, 'admission 故障必須 fail-closed')
        assert.match(first.data.error, /自架中繼/)
      } else {
        assert.equal(first.status, 200, 'membership commit 後 report/cancel 故障不可翻成 400')
        if (fault === 'cancel') {
          assert.equal((await post(worker.base, '/groups', { name: 'Before expiry' })).status, 503, '未過期預留仍計入')
          const persist = worker.persist
          await stopWorker(worker, { keepPersist: true })
          await new Promise(resolve => setTimeout(resolve, 200))
          worker = await startWorker(vars, { persist })
          assert.equal((await post(worker.base, '/groups', { name: 'After expiry' })).status, 200, '真實時鐘過期後預留自動清掉')
        }
      }
    } finally { await stopWorker(worker) }
  })
}

console.log(`\n${passed} passed, ${failed.length} failed`)
process.exitCode = failed.length ? 1 : 0
