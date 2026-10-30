// ui-15：自啟真實 Wrangler，驗證 Worker 改名的授權、驗證、簽章與重啟後冷卻。
// 執行：node relay/worker/rename.test.mjs
import assert from 'node:assert/strict'
import { createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto'
import { TEST_RESPONSE_SIGNING } from '../test-fixtures/response-signing-key.mjs'
import { fromB64url, responseEnvelope } from '../response-signing.mjs'
import { startWorker, stopWorker } from './wrangler-test-server.mjs'

const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
const publicKey = createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(fromB64url(TEST_RESPONSE_SIGNING.publicKey))]), format: 'der', type: 'spki' })
const auth = m => `Bearer ${m.groupId}.${m.memberId}.${m.memberKey}`
let server

async function call(method, path, body, member, now, ip = '203.0.113.150') {
  const nonce = randomBytes(18).toString('base64url')
  const headers = {
    'content-type': 'application/json', 'x-friends-nonce': nonce, 'x-friends-origin': server.base,
    'x-friends-test-now': String(now), 'cf-connecting-ip': ip,
  }
  if (member) headers.authorization = auth(member)
  const response = await fetch(server.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  const signature = Buffer.from(fromB64url(response.headers.get('x-friends-signature')))
  assert.equal(verifySignature(null, responseEnvelope({ nonce, origin: server.base, method, path, status: response.status, body: text }), publicKey, signature), true,
    `${method} ${path} 必須簽完整 envelope`)
  return { status: response.status, data: JSON.parse(text) }
}

let passed = 0
let failed = 0
try {
  server = await startWorker({ FRIENDS_TEST_CLOCK: '1' })
  const owner = (await call('POST', '/groups', { name: 'Owner' }, undefined, 1_000)).data
  const friend = (await call('POST', '/join', { invite: owner.invite, name: 'Friend' }, undefined, 1_100)).data

  assert.equal((await call('POST', '/name', { name: 'SameName' }, owner, 2_000)).status, 200)
  assert.equal((await call('POST', '/name', { name: 'Hijack', memberId: owner.memberId }, friend, 2_100)).status, 400, '不能指定別人的 id')
  for (const name of ['', 'A'.repeat(21), 'Bad\u0007', 'Zero\u200bWidth', 'RTL\u202eName', '\u3164', 'X\uffa0', '\u2800'])
    assert.equal((await call('POST', '/name', { name }, friend, 2_200)).status, 400, JSON.stringify(name))
  assert.equal((await call('POST', '/name', { name: 'SameName' }, friend, 3_000)).status, 200, '同名政策跟 join 一樣允許')
  assert.equal((await call('POST', '/name', { name: 'TooSoon' }, friend, 3_001)).status, 429)
  const names = (await call('GET', '/friends', undefined, owner, 3_100)).data.members.map(m => m.name).sort()
  assert.deepEqual(names, ['SameName', 'SameName'])

  const quotaIp = '203.0.113.210'
  const otherIp = '203.0.113.211'
  const quotaOwners = []
  for (let i = 0; i <= 31; i++) quotaOwners.push((await call('POST', '/groups', { name: `Quota${i}` }, undefined, 90_000 + i, `198.51.100.${i + 1}`)).data)
  const wrong = { ...quotaOwners[0], memberKey: 'wrong-key-that-still-has-a-valid-bearer-shape' }
  for (let i = 0; i <= 30; i++) assert.equal((await call('POST', '/name', { name: `Wrong${i}` }, wrong, 99_000, quotaIp)).status, 401,
    '格式正確但錯誤的 member key 不得消耗 rename IP 額度')
  for (let i = 0; i < 30; i++) assert.equal((await call('POST', '/name', { name: `Renamed${i}` }, quotaOwners[i], 100_000, quotaIp)).status, 200,
    `同 IP 第 ${i + 1} 個合法 membership 應成功`)
  assert.equal((await call('POST', '/name', { name: 'Blocked31' }, quotaOwners[30], 159_999, quotaIp)).status, 429, '同 IP 第 31 個仍在 fixed window 內')
  assert.equal((await call('POST', '/name', { name: 'OtherIp' }, quotaOwners[30], 159_999, otherIp)).status, 200, '不同 IP 不受影響')
  assert.equal((await call('POST', '/name', { name: 'BoundaryReset' }, quotaOwners[31], 160_000, quotaIp)).status, 200, '恰好 60,000 ms 時 IP window 已重置')

  const persist = server.persist
  await stopWorker(server, { keepPersist: true })
  server = await startWorker({ FRIENDS_TEST_CLOCK: '1' }, { persist })
  assert.equal((await call('POST', '/name', { name: 'StillTooSoon' }, friend, 62_999)).status, 429, '重啟不能洗掉 60 秒冷卻')
  assert.equal((await call('POST', '/name', { name: 'AfterCooldown' }, friend, 63_000)).status, 200)
  const after = (await call('GET', '/friends', undefined, owner, 63_001)).data.members.find(m => m.id === friend.memberId)
  assert.equal(after.name, 'AfterCooldown')

  passed = 1
  console.log('  ✓ Worker 改名授權、嚴格驗證、錯 key 不吃額度、30+1/IP、邊界、簽章與重啟冷卻')
} catch (error) {
  failed = 1
  console.log(`  ✗ Worker 改名\n    ${error.stack ?? error}`)
} finally {
  await stopWorker(server)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
