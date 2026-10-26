import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { deserialize } from 'node:v8'
import { join } from 'node:path'
import { aggregateReports, groupOpsSummary, newGroupOps, recordMembershipRequest, rollGroupOps, UTC_DAY_MS } from './ops-stats.mjs'
import { startWorker, stopWorker } from './wrangler-test-server.mjs'

let passed = 0
const failed = []
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`) }
  catch (error) { failed.push(name); console.log(`  ✗ ${name}\n    ${error.message.split('\n').join('\n    ')}`) }
}

await check('群內精確保留七日活躍 membership 與今日請求分布', () => {
  const start = 20 * UTC_DAY_MS
  const ops = newGroupOps(start)
  const members = { a: {}, b: {} }
  recordMembershipRequest(ops, members, members.a, start)
  for (let i = 0; i < 6; i++) recordMembershipRequest(ops, members, members.b, start)
  assert.deepEqual(groupOpsSummary(ops, members), { rolling7ActiveMemberships: 2, requestHistogram: [1, 0, 1, 0, 0, 0], day: 20 })
  assert.deepEqual(Object.keys(ops).sort(), ['day', 'dirtySince', 'lastReportedAt', 'lastToken'])
  rollGroupOps(ops, members, start + 6 * UTC_DAY_MS)
  assert.equal(groupOpsSummary(ops, members).rolling7ActiveMemberships, 2)
  rollGroupOps(ops, members, start + 7 * UTC_DAY_MS)
  assert.equal(groupOpsSummary(ops, members).rolling7ActiveMemberships, 0)
})

await check('集中端只彙總匿名小計並清掉過期報告與預留', () => {
  const now = 30 * UTC_DAY_MS
  const reports = {
    anonymousA: { rolling7ActiveMemberships: 2, requestHistogram: [1, 1, 0, 0, 0, 0], day: 30, reportedAt: now },
    expired: { rolling7ActiveMemberships: 99, requestHistogram: [99], day: 20, reportedAt: now - 8 * UTC_DAY_MS },
  }
  const reservations = { live: now + 1, expired: now }
  const view = aggregateReports(reports, reservations, now)
  assert.equal(view.rolling7ActiveMemberships, 2)
  assert.equal(view.activeGroups, 1)
  assert.equal(view.reservationCount, 1)
  assert.deepEqual(Object.keys(reports), ['anonymousA'])
  assert.deepEqual(Object.keys(reservations), ['live'])
})

function persistedRows(persist) {
  const dir = join(persist, 'v3', 'do', 'friends-status-relay-Group')
  if (!existsSync(dir)) return []
  const rows = []
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sqlite'))) {
    const db = new DatabaseSync(join(dir, file), { readOnly: true })
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = '_cf_KV'").get()) continue
      for (const row of db.prepare('SELECT key, value FROM _cf_KV').all()) rows.push({ key: row.key, value: deserialize(Buffer.from(row.value)) })
    } finally { db.close() }
  }
  return rows
}

let worker
try {
  worker = await startWorker({ FRIENDS_OPS_STATS: '1', FRIENDS_ADMIN_KEY: 'ops-test-admin-key-1234567890', FRIENDS_TEST_CLOCK: '1' })
  const call = async (path, init = {}) => {
    const response = await fetch(worker.base + path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
    return { status: response.status, data: await response.json() }
  }
  let alice, bob
  await check('真實 Worker API 產生匿名的活躍 membership 統計', async () => {
    alice = (await call('/groups', { method: 'POST', body: JSON.stringify({ name: 'Alice', groupName: 'Secret group' }) })).data
    bob = (await call('/join', { method: 'POST', body: JSON.stringify({ name: 'Bob', invite: alice.invite }) })).data
    await call('/status', { method: 'POST', headers: { authorization: `Bearer ${alice.groupId}.${alice.memberId}.${alice.memberKey}` }, body: JSON.stringify({ state: 'idle' }) })
    const unauthorized = await call('/admin/stats')
    assert.equal(unauthorized.status, 401)
    const malformed = await call('/admin/stats', { headers: { authorization: 'Bearer short key' } })
    assert.equal(malformed.status, 401)
    assert.equal(JSON.stringify([unauthorized.data, malformed.data]).includes('ops-test-admin-key-1234567890'), false)
    const result = await call('/admin/stats', { headers: { authorization: 'Bearer ops-test-admin-key-1234567890' } })
    assert.equal(result.status, 200)
    assert.equal(result.data.rolling7ActiveMemberships, 2)
    assert.equal(result.data.activeGroups, 1)
    assert.deepEqual(Object.keys(result.data.requestHistogram), ['1', '2-5', '6-20', '21-100', '101-500', '501+'])
    const raw = JSON.stringify(result.data)
    for (const secret of ['Alice', 'Bob', 'Secret group', alice.groupId, alice.memberId, bob.memberId]) assert.equal(raw.includes(secret), false)
    assert.equal(worker.stderr().includes('ops-test-admin-key-1234567890'), false, '營運 log 不可印管理金鑰')
  })
  await check('一小時內一般請求不觸發新的集中回報', async () => {
    const headers = { authorization: `Bearer ${alice.groupId}.${alice.memberId}.${alice.memberKey}` }
    const before = (await call('/admin/stats', { headers: { authorization: 'Bearer ops-test-admin-key-1234567890' } })).data.dataUpdatedAt
    for (let i = 0; i < 5; i++) assert.equal((await call('/friends', { headers })).status, 200)
    const after = (await call('/admin/stats', { headers: { authorization: 'Bearer ops-test-admin-key-1234567890' } })).data.dataUpdatedAt
    assert.equal(after, before)
  })
  await check('跨週回報原子替換舊 token，全域 membership 不翻倍', async () => {
    const beforeBoundary = 101 * 7 * UTC_DAY_MS - 1_000
    const afterBoundary = beforeBoundary + 2_000
    const created = await call('/groups', { method: 'POST', headers: { 'x-friends-test-now': String(beforeBoundary) }, body: JSON.stringify({ name: 'Week Alice' }) })
    const member = created.data
    const auth = { authorization: `Bearer ${member.groupId}.${member.memberId}.${member.memberKey}`, 'x-friends-test-now': String(afterBoundary) }
    assert.equal((await call('/friends', { headers: auth })).status, 200)
    const stats = await call('/admin/stats', { headers: { authorization: 'Bearer ops-test-admin-key-1234567890', 'x-friends-test-now': String(afterBoundary) } })
    assert.equal(stats.data.rolling7ActiveMemberships, 3, '原本 2 加新群 1；同一新群不可跨週算兩次')
    assert.equal(stats.data.activeGroups, 2)
  })
  await check('持久化統計不另存名字、群組名、memberId、IP 或內容', () => {
    const rows = persistedRows(worker.persist)
    const groupRows = rows.filter(row => row.key === 'group')
    const opsRows = rows.filter(row => row.key === 'ops')
    const statsRows = rows.filter(row => row.key === 'reports' || row.key === 'reservations')
    assert.ok(groupRows.length >= 1)
    assert.ok(opsRows.length >= 1)
    assert.ok(statsRows.length >= 1)
    const raw = JSON.stringify([...opsRows, ...statsRows])
    for (const secret of ['Alice', 'Bob', 'Secret group', alice.groupId, alice.memberId, bob.memberId, 'fixing-bugs', '127.0.0.1']) assert.equal(raw.includes(secret), false, secret)
    for (const row of opsRows) assert.deepEqual(Object.keys(row.value).sort(), ['day', 'dirtySince', 'lastReportedAt', 'lastToken'])
    const aliceGroup = groupRows.find(row => row.value?.members?.[alice.memberId])?.value
    assert.equal(typeof aliceGroup.members[alice.memberId].opsDays, 'number', 'bitmap 併入原本就有的 membership record')
    assert.equal(typeof aliceGroup.members[alice.memberId].opsTodayRequests, 'number')
    assert.equal(opsRows.some(row => 'members' in row.value), false, 'ops metadata 不得另建 memberId map')
  })
} catch (error) {
  failed.push('Worker 自啟動')
  console.log(`  ✗ Worker 自啟動\n    ${error.message.split('\n').join('\n    ')}`)
} finally { await stopWorker(worker) }

let faulty
try {
  faulty = await startWorker({ FRIENDS_OPS_STATS: '1', FRIENDS_TEST_STATS_FAULT: 'report' })
  await check('stats report 故障時既有與新 membership 都成功，dirty 留待下次重試', async () => {
    assert.equal((await fetch(faulty.base + '/admin/stats')).status, 404, '沒設 admin key 時端點不存在')
    const createdResponse = await fetch(faulty.base + '/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Fault Alice' }) })
    assert.equal(createdResponse.status, 200)
    const member = await createdResponse.json()
    const response = await fetch(faulty.base + '/friends', { headers: { authorization: `Bearer ${member.groupId}.${member.memberId}.${member.memberKey}` } })
    assert.equal(response.status, 200)
  })
} catch (error) {
  failed.push('Worker report fault injection')
  console.log(`  ✗ Worker report fault injection\n    ${error.message.split('\n').join('\n    ')}`)
} finally { await stopWorker(faulty) }

let invalidKeyWorker
try {
  invalidKeyWorker = await startWorker({ FRIENDS_OPS_STATS: '1', FRIENDS_ADMIN_KEY: 'short' })
  await check('格式錯誤的 configured admin key 不開查詢端點', async () => {
    const response = await fetch(invalidKeyWorker.base + '/admin/stats', { headers: { authorization: 'Bearer short' } })
    assert.equal(response.status, 404)
    assert.equal((await response.text()).includes('short'), false)
    assert.equal(invalidKeyWorker.stderr().includes('short'), false)
  })
} catch (error) {
  failed.push('Worker invalid admin key')
  console.log(`  ✗ Worker invalid admin key\n    ${error.message.split('\n').join('\n    ')}`)
} finally { await stopWorker(invalidKeyWorker) }

console.log(`\n${passed} passed, ${failed.length} failed`)
process.exitCode = failed.length ? 1 : 0
