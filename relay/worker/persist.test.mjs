// Worker 版 Group（Durable Object）存檔失敗時，記憶體與資料庫要一致（0.5.8 資安 ②）。
// 不開 wrangler：用假的 cloudflare:workers 與假的 storage（可以指定下一次 put 失敗）直接呼叫 Group.authed。
//   ① 恢復存檔失敗 → 回 500、記憶體不能先變成「已恢復」（資料庫還是暫停），修好後同一個請求重送就成功
//   ② 暫停存檔失敗 → 回 500，但記憶體維持「已暫停」（寧可多暫停，好友不能因為存檔失敗而看得到動態），
//      之後任何一個請求都會補存，資料庫追上來
//   ③ 其他會寫資料庫的路由（改名）失敗 → 回 500，記憶體還原
//   ④ 還原不能動到別人的在線狀態（conns 只放記憶體）
// 用法：node relay/worker/persist.test.mjs
import { register } from 'node:module'
import assert from 'node:assert/strict'
import * as core from '../core.mjs'

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') {
    return { url: 'data:text/javascript,' + encodeURIComponent('export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }'), shortCircuit: true }
  }
  return next(specifier, context)
}`))
const { Group } = await import('./src/index.mjs')

function fakeStorage() {
  const data = new Map()
  const s = {
    data, failNextPuts: 0, failIf: null, failAlarm: false, puts: 0,
    async get(keys) {
      if (Array.isArray(keys)) return new Map(keys.filter(k => data.has(k)).map(k => [k, structuredClone(data.get(k))]))
      return data.has(keys) ? structuredClone(data.get(keys)) : undefined
    },
    async put(values) {
      if (s.failNextPuts > 0) { s.failNextPuts -= 1; throw new Error('storage fault (test)') }
      if (s.failIf?.(values)) throw new Error('storage fault (test, conditional)')
      s.puts += 1
      for (const [k, v] of Object.entries(values)) data.set(k, structuredClone(v))
    },
    // CHAT3-RELAY：私訊信箱存在 dm:<代碼> 鍵（list 找出來、delete／transaction 一起刪）
    async list({ prefix = '' } = {}) { return new Map([...data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])) },
    async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k) },
    async transaction(fn) { return fn({ put: values => s.put(values), delete: keys => s.delete(keys) }) },
    async setAlarm() { if (s.failAlarm) throw new Error('alarm fault (test)') }, async deleteAlarm() {}, async deleteAll() { data.clear() },
  }
  return s
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

// 建一個有兩位成員的群組（alice 是被測的人，bob 當旁觀者），回傳 { room, storage, alice, bob, stored, view }
async function setup() {
  const storage = fakeStorage()
  const room = new Group({ storage }, {})
  const { groupId, g, reply } = await core.createGroup({ name: 'Alice' }, 1000, '0.5.8')
  await room.init(groupId, g, false, 1000)
  const joined = await room.join(groupId, { invite: reply[1].invite, name: 'Bob' }, '203.0.113.1', '0.5.8', false, 1000)
  assert.equal(joined[0], 200)
  const alice = { groupId, memberId: reply[1].memberId, key: reply[1].memberKey }
  const bob = { groupId, memberId: joined[1].memberId, key: joined[1].memberKey }
  const joinedC = await room.join(groupId, { invite: reply[1].invite, name: 'Carol' }, '203.0.113.2', '0.5.8', false, 1000)
  assert.equal(joinedC[0], 200)
  const carol = { groupId, memberId: joinedC[1].memberId, key: joinedC[1].memberKey }
  const call = (who, route, body = {}, now = 2000) => room.authed(route, who, body, '203.0.113.1', '0.5.8', false, now)
  const stored = () => storage.data.get('group').members[alice.memberId]
  const view = async now => (await call(bob, 'GET /friends', {}, now))[1].members.find(m => m.name === 'Alice')
  return { room, storage, alice, bob, carol, call, stored, view }
}

const WORK = { conn: 'convPersist01', state: 'working', action: 'fixing-bugs', subject: 'website' }

await check('①恢復存檔失敗：回 500，記憶體不先變成已恢復（跟資料庫一致仍是暫停）；修好後重送成功', async () => {
  const { storage, alice, call, stored, view, room } = await setup()
  assert.equal((await call(alice, 'POST /status', { conn: 'convPersist01', state: 'idle', paused: true }))[0], 200)
  assert.equal(stored().paused, true)
  storage.failNextPuts = 1
  const r = await call(alice, 'POST /status', { ...WORK, paused: false }, 3000)
  assert.equal(r[0], 500, '存檔失敗要回 5xx 讓外掛重試（不是 400，也不是丟例外）')
  assert.equal(room.g.members[alice.memberId].paused, true, '記憶體不能先改')
    assert.equal(stored().paused, true, '資料庫沒動')
  const during = await view(3500)
  assert.deepEqual([during.presence, during.action], ['idle', ''], '失敗期間好友仍只看得到在線')
  const retry = await call(alice, 'POST /status', { ...WORK, paused: false }, 4000)
  assert.equal(retry[0], 200)
  assert.equal(stored().paused, undefined, '重送後資料庫也恢復')
    assert.equal((await view(4500)).presence, 'working')
})

await check('②暫停存檔失敗：回 500，但記憶體維持已暫停（好友看不到動態）；之後任何請求補存，資料庫追上', async () => {
  const { storage, alice, bob, call, stored, view, room } = await setup()
  assert.equal((await call(alice, 'POST /status', { ...WORK, paused: false }))[0], 200)
  assert.equal((await view(2500)).presence, 'working')
  storage.failNextPuts = 2 // 路由存一次、立刻重試一次，都失敗
  const r = await call(alice, 'POST /status', { conn: 'convPersist01', state: 'idle', paused: true }, 3000)
  assert.equal(r[0], 500)
  assert.equal(room.g.members[alice.memberId].paused, true, '記憶體要是暫停（fail-closed）')
  assert.equal(stored().paused, undefined, '資料庫還沒追上')
  const during = await view(3500)
  assert.deepEqual([during.presence, during.action, during.subject], ['idle', '', ''], '失敗期間好友看不到動態')
  // 別人的請求（bob 讀好友列表）就會補存；補存成功後資料庫是暫停
  assert.equal((await call(bob, 'GET /friends', {}, 4000))[0], 200)
  assert.equal(stored().paused, true, '補存之後資料庫也是暫停')
})

await check('②b暫停存檔連續失敗：每個請求都再試，沒好之前記憶體一直是暫停；別人的心跳照常；送來的恢復不能趁機解除', async () => {
  const { storage, alice, call, stored, view, room } = await setup()
  storage.failNextPuts = Infinity // 一直壞到說修好為止
  assert.equal((await call(alice, 'POST /status', { conn: 'convPersist01', state: 'idle', paused: true }, 3000))[0], 500)
  assert.equal((await call(alice, 'POST /status', { conn: 'convPersist01', state: 'idle', paused: true }, 3100))[0], 500, '重送仍失敗仍回 500（記憶體已暫停也要把存檔結果告訴外掛）')
  const late = await call(alice, 'POST /status', { ...WORK, paused: false }, 3200)
  assert.equal(late[0], 500, '還沒存成功之前，送狀態的回應都是 500（200＝已經寫進資料庫）')
  assert.equal(room.g.members[alice.memberId].paused, true)
  assert.deepEqual([(await view(3300)).presence, (await view(3300)).action], ['idle', ''])
  storage.failNextPuts = 0 // 修好了
  assert.equal((await call(alice, 'POST /status', { conn: 'convPersist01', state: 'idle', paused: true }, 4000))[0], 200)
  assert.equal(stored().paused, true)
})

await check('②c暫停只失敗一次（短暫）：立刻重試成功，回 200、資料庫已暫停', async () => {
  const { storage, alice, call, stored } = await setup()
  storage.failNextPuts = 1
  assert.equal((await call(alice, 'POST /status', { conn: 'convPersist01', state: 'idle', paused: true }, 3000))[0], 200)
  assert.equal(stored().paused, true)
})

await check('②d只有暫停沒存好的那位回 500；別的成員的心跳照常 200（盲審建議 4）', async () => {
  const { storage, alice, bob, call } = await setup()
  storage.failNextPuts = Infinity
  assert.equal((await call(alice, 'POST /status', { conn: 'convPersist01', state: 'idle', paused: true }, 3000))[0], 500)
  assert.equal((await call(bob, 'POST /status', { conn: 'convPersistBOB', state: 'working' }, 3100))[0], 200, 'Bob 的心跳不受 Alice 的存檔問題影響')
  assert.equal((await call(alice, 'POST /status', { conn: 'convPersist01', state: 'idle', paused: true }, 3200))[0], 500)
})

await check('⑥put 成功但排鬧鐘失敗：不算存檔失敗，記憶體不還原（盲審建議 1）', async () => {
  const { storage, alice, carol, call, room } = await setup()
  assert.equal((await call(alice, 'POST /status', { ...WORK }, 2500))[0], 200) // 有動態才會排到期鬧鐘（setAlarm）
  storage.failAlarm = true
  const r = await call(alice, 'POST /kick', { memberId: carol.memberId }, 3000)
  assert.equal(r[0], 200)
  assert.equal(Object.hasOwn(room.g.members, carol.memberId), false, '記憶體裡踢掉了')
  assert.equal(Object.hasOwn(storage.data.get('group').members, carol.memberId), false, '資料庫裡也踢掉了')
})

await check('⑦並行：踢人的存檔失敗時，同時進來並成功存檔的別人的暫停不能被還原抹掉（盲審必修 2）', async () => {
  const { storage, alice, bob, carol, call, room } = await setup()
  storage.failIf = v => !v.group.members[carol.memberId] // 只讓「把 Carol 踢掉」的那次存檔失敗
  const [kick, pause] = await Promise.all([
    call(alice, 'POST /kick', { memberId: carol.memberId }, 3000),
    call(bob, 'POST /status', { conn: 'convPersistBOB', state: 'idle', paused: true }, 3000),
  ])
  assert.equal(kick[0], 500)
  assert.equal(pause[0], 200)
  assert.equal(room.g.members[bob.memberId].paused, true, '記憶體裡 Bob 仍是暫停')
  assert.equal(storage.data.get('group').members[bob.memberId].paused, true, '資料庫裡 Bob 是暫停')
  assert.ok(room.g.members[carol.memberId], '踢人失敗，Carol 還在（還原）')
  const seen = (await call(alice, 'GET /friends', {}, 3500))[1].members.find(m => m.name === 'Bob')
  assert.deepEqual([seen.presence, seen.action], ['idle', ''])
})

await check('⑧帶序號：恢復存檔失敗後序號也還原，重送同一個序號成功；暫停沒存好時重送同序號能補存', async () => {
  const { storage, alice, call, stored, room } = await setup()
  assert.equal((await call(alice, 'POST /status', { conn: 'convPersist01', state: 'idle', paused: true, pauseSeq: 10 }))[0], 200)
  storage.failNextPuts = 1
  assert.equal((await call(alice, 'POST /status', { ...WORK, paused: false, pauseSeq: 20 }, 3000))[0], 500)
  assert.equal(room.g.members[alice.memberId].pauseSeq, 10, '序號跟著還原（不然重送的 20 會被當成舊的而忽略）')
  assert.equal((await call(alice, 'POST /status', { ...WORK, paused: false, pauseSeq: 20 }, 3100))[0], 200)
  assert.equal(stored().paused, undefined)
  assert.equal(stored().pauseSeq, 20)
  storage.failNextPuts = 2
  assert.equal((await call(alice, 'POST /status', { conn: 'convPersist01', state: 'idle', paused: true, pauseSeq: 30 }, 3200))[0], 500)
  assert.equal(room.g.members[alice.memberId].paused, true)
  assert.equal((await call(alice, 'POST /status', { conn: 'convPersist01', state: 'idle', paused: true, pauseSeq: 30 }, 3300))[0], 200, '同序號重送補存成功')
  assert.equal(stored().paused, true)
  assert.equal(stored().pauseSeq, 30)
})

await check('⑨暫停存檔連續失敗後 Durable Object 被回收（新的 Group 讀同一份 storage）：資料庫仍是暫停前；外掛重送同一個暫停（序號仍比資料庫大）就補上', async () => {
  const { storage, alice, call, stored, room } = await setup()
  assert.equal((await call(alice, 'POST /status', { ...WORK, paused: false, pauseSeq: 10 }))[0], 200)
  storage.failNextPuts = Infinity
  assert.equal((await call(alice, 'POST /status', { conn: 'convPersist01', state: 'idle', paused: true, pauseSeq: 20 }, 3000))[0], 500)
  storage.failNextPuts = 0
  // 殘餘風險（已知）：回收的當下資料庫還沒暫停；下一次心跳（外掛每 10～30 秒重送 paused）就補上
  const reborn = new Group({ storage }, {})
  const again = await reborn.authed('POST /status', alice, { conn: 'convPersist01', state: 'idle', paused: true, pauseSeq: 20 }, '203.0.113.1', '0.5.8', false, 4000)
  assert.equal(again[0], 200)
  assert.equal(stored().paused, true)
  assert.equal(room === reborn, false)
})

await check('⑩加入時存檔失敗：回 500，記憶體不留幽靈成員，也不佔名額；重試成功', async () => {
  const { storage, room, alice } = await setup()
  const g = room.g
  const invite = (await core.rotateInvite(g, alice.groupId, alice.memberId))[1].invite // 同一個 Durable Object 的新邀請碼
  storage.failNextPuts = 1
  const failedJoin = await room.join(alice.groupId, { invite, name: 'Ghost' }, '203.0.113.9', '0.5.8', false, 3000)
  assert.equal(failedJoin[0], 500)
  assert.equal(Object.values(room.g.members).some(m => m.name === 'Ghost'), false)
  const ok = await room.join(alice.groupId, { invite, name: 'Ghost' }, '203.0.113.9', '0.5.8', false, 3100)
  assert.equal(ok[0], 200)
  assert.equal(Object.values(storage.data.get('group').members).filter(m => m.name === 'Ghost').length, 1)
})

await check('③改名存檔失敗：回 500，記憶體的名字還原；重送成功', async () => {
  const { storage, alice, call, stored, room } = await setup()
  storage.failNextPuts = 1
  const r = await call(alice, 'POST /name', { name: 'Alicia' }, 3000)
  assert.equal(r[0], 500)
  assert.equal(room.g.members[alice.memberId].name, 'Alice')
  assert.equal(stored().name, 'Alice')
  assert.equal((await call(alice, 'POST /name', { name: 'Alicia' }, 3000))[0], 200)
  assert.equal(stored().name, 'Alicia')
  assert.equal(room.g.members[alice.memberId].name, 'Alicia')
})

await check('④還原不動在線狀態：恢復失敗之後，另一位成員的 working 連線仍在、被測成員自己的連線也沒被洗掉', async () => {
  const { storage, alice, bob, call, view, room } = await setup()
  assert.equal((await call(bob, 'POST /status', { conn: 'convPersistBOB', state: 'working', action: 'learning', subject: 'game' }, 2000))[0], 200)
  assert.equal((await call(alice, 'POST /status', { conn: 'convPersist01', state: 'idle', paused: true }, 2100))[0], 200)
  storage.failNextPuts = 1
  assert.equal((await call(alice, 'POST /status', { ...WORK, paused: false }, 2200))[0], 500)
  const bobConns = room.g.members[bob.memberId].conns
  assert.equal(bobConns.convPersistBOB.state, 'working')
  assert.ok(room.g.members[alice.memberId].conns.convPersist01, '被測成員自己的心跳照樣記在記憶體')
  assert.equal((await view(2300)).presence, 'idle')
})

await check('⑤沒失敗時行為不變：一般心跳不寫資料庫、動態換了才寫', async () => {
  const { storage, alice, call } = await setup()
  const before = storage.puts
  assert.equal((await call(alice, 'POST /status', { conn: 'convPersist01', state: 'working' }, 2000))[0], 200)
  assert.equal(storage.puts, before, '只有心跳不寫')
  assert.equal((await call(alice, 'POST /status', { ...WORK }, 2100))[0], 200)
  assert.equal(storage.puts, before + 1)
})

console.log(`\n${passed} 通過，${failed.length} 失敗`)
process.exit(failed.length ? 1 : 0)
