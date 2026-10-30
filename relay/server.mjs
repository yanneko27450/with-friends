// Claude 好友動態：本機中繼（開發用，無套件）。正式版是 relay/worker（Cloudflare），兩邊共用 relay/core.mjs。
// 借鑑 SaharCarmel/claude-who（MIT）：邀請碼＋每人金鑰、中繼只存金鑰雜湊。
// 動態只收封閉詞彙的兩個代碼（action／subject），清單在 mod/hooks/taxonomy.ts，core.mjs 直接 import 同一份。
// 用法：node relay/server.mjs [--port 8789] [--data relay/data.json]（需要 Node 23.6+，直接讀 .ts）
import http from 'node:http'
import { readFileSync, renameSync, existsSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs'
import * as core from './core.mjs'
import { RESPONSE_NONCE_RE, responseSigner } from './response-signing.mjs'
import { activeMembershipCount, CAPACITY_BLOCK, CAPACITY_ERROR } from './capacity.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : dflt
}
const PORT = Number(arg('--port', process.env.PORT ?? 8789))
const DATA = arg('--data', '')
// 測試用：把 24 小時的動態保存期限縮短
const TTL = Number(arg('--activity-ttl-ms', core.ACTIVITY_TTL_MS))
// 測試用：限流測試要扮成不同的 IP（sec-2）。只有帶這個參數才讀 x-test-ip，正式啟動照舊用連線的 IP
const TEST_IP_HEADER = process.argv.includes('--test-ip-header')
if (TEST_IP_HEADER) console.error('⚠ --test-ip-header：x-test-ip 標頭可以假冒 IP、繞過限流，只能拿來跑測試')
const SIGNING_PRIVATE_KEY = process.env.RESPONSE_SIGNING_PRIVATE_KEY ?? ''
const SIGNING_KEY_ID = process.env.RESPONSE_SIGNING_KEY_ID ?? ''
if (!SIGNING_PRIVATE_KEY || !SIGNING_KEY_ID) throw new Error('Node 中繼需要 RESPONSE_SIGNING_PRIVATE_KEY 與 RESPONSE_SIGNING_KEY_ID；沒有簽章私鑰不啟動')
const signResponse = await responseSigner(SIGNING_PRIVATE_KEY, SIGNING_KEY_ID)
// ops-2a：每週活躍群組數，預設關（--weekly-stats 或 FRIENDS_WEEKLY_STATS=1 才開）。
// 查詢端點要另外設 FRIENDS_ADMIN_KEY（24～200 個非空白字元，例如 openssl rand -base64 32）；沒設或不合格就沒有這個端點
const WEEKLY = process.argv.includes('--weekly-stats') || process.env.FRIENDS_WEEKLY_STATS === '1'
if (!WEEKLY && process.env.FRIENDS_WEEKLY_STATS) console.error('⚠ FRIENDS_WEEKLY_STATS 只認 1，其他值都當關')
let ADMIN_KEY = process.env.FRIENDS_ADMIN_KEY ?? ''
if (ADMIN_KEY && !core.ADMIN_KEY_RE.test(ADMIN_KEY)) {
  console.error('⚠ FRIENDS_ADMIN_KEY 要 24～200 個字、不能有空白，查詢端點不開')
  ADMIN_KEY = ''
}
const PUBLIC_CAPACITY = process.env.FRIENDS_PUBLIC_CAPACITY === '1'
const CAPACITY_BLOCK_AT = Number(process.env.FRIENDS_CAP_BLOCK) || CAPACITY_BLOCK
let capacityReservations = 0

// db.groups[groupId] = core.mjs 開頭寫的群組格式
// relay-9：資料檔壞了（不是 JSON、空檔、型別不對）不要崩：壞檔改名成 .broken-<時間> 留著，用空資料開起來
function loadData() {
  if (!DATA || !existsSync(DATA)) return { groups: {} }
  // 讀不到（是資料夾、沒權限、被別的程序鎖住）不是「壞檔」：不動使用者的檔案，直接說清楚、不開
  let raw
  try {
    raw = readFileSync(DATA, 'utf8')
  } catch (err) {
    throw new Error(`讀不到資料檔 ${DATA}（${err.code ?? err.message}），中繼沒有開`)
  }
  let reason
  try {
    // Windows 記事本存的 UTF-8 會帶 BOM
    const d = JSON.parse(raw.replace(/^\uFEFF/, ''))
    const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v)
    if (isObj(d) && isObj(d.groups) && Object.values(d.groups).every(g => isObj(g) && isObj(g.members) && Object.values(g.members).every(isObj))) return d
    reason = '格式不對'
  } catch {
    reason = '不是 JSON（或是空檔）'
  }
  const broken = `${DATA}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`
  renameSync(DATA, broken)
  console.error(`⚠ 資料檔${reason}，改名成 ${broken} 留著，用空資料開起來`)
  return { groups: {} }
}
let db = loadData()
// 沒開就連舊的統計一起丟掉：資料檔是整份寫回，不清會一直留著
// 統計的格式不對（手改過、舊版）就重新開始記，不讓每次 /status 都出錯
if (WEEKLY && !(typeof db.weekly === 'object' && db.weekly !== null && Array.isArray(db.weekly.groups) && Number.isInteger(db.weekly.week))) db.weekly = core.newWeeklyStats()
else delete db.weekly
// 群組代碼是請求給的：__proto__、constructor、toString 這種名字不能摸到物件內建的東西，當成沒這個群組（sec-10）。
// db.groups 維持一般物件，資料檔格式不變、舊檔照讀
const groupOf = groupId => (typeof groupId === 'string' && Object.hasOwn(db.groups, groupId) ? db.groups[groupId] : undefined)
// 先寫暫存檔、確定寫到磁碟（fsync）再改名：寫到一半斷電也只會留下舊檔或新檔，不會是半個檔
// 呼叫 save() 的次數（fix-6：同一個請求已經存過，就不為了版本再存一次）
let saves = 0
function save() {
  if (!DATA) {
    saves++
    return
  }
  const fd = openSync(DATA + '.tmp', 'w')
  try {
    writeSync(fd, JSON.stringify(db))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(DATA + '.tmp', DATA)
  saves++ // 寫成功才算（fix-7）
}

// 過期動態：沒人來讀也要從資料檔清掉（sec-3）
function sweep() {
  let isDirty = false
  for (const g of Object.values(db.groups)) isDirty = core.expireActivity(g, Date.now(), TTL) || isDirty
  // 計時器裡出錯沒人接會讓整個中繼掛掉（例如 Windows 上資料檔被別的程序開著，存檔改名失敗）：印一行，下次再試
  if (isDirty) {
    try {
      save()
    } catch (err) {
      console.error(`⚠ 存資料檔失敗（${err.code ?? err.message}），下次再試`)
    }
  }
}
sweep()
setInterval(sweep, Math.min(60_000, TTL)).unref()

// 簡單限流：每個 IP 每分鐘 600 次；加入每小時 10 次
const limited = core.makeLimiter()

// X-Friends-Version 標頭，經 clientVersion 過濾（格式不對、沒帶＝空字串）
const ver = req => core.clientVersion(req.headers['x-friends-version'])

async function findMember(req) {
  const a = core.parseAuth(req.headers.authorization)
  if (!a) return null
  const g = groupOf(a.groupId)
  // 過期動態和版本都只改記憶體，要不要存檔交給 authed 一次決定（同一個請求只存一次，fix-6）。金鑰不對時沒有 authed 可交，過期的那次當場存
  const expired = g ? core.expireActivity(g, Date.now(), TTL) : false
  const mem = await core.findMember(g, a.memberId, a.key)
  if (!mem) {
    if (expired) save()
    return null
  }
  // ver-2c／fix-6：記下這個成員最後帶來的版本；noteVer 回 true＝這個請求要為版本單獨存一次
  const verWrite = core.noteVer(mem, ver(req), Date.now())
  return { g, groupId: a.groupId, memberId: a.memberId, mem, verWrite, ver: ver(req), needsSave: expired || verWrite }
}

// 要登入的路由：金鑰不對一律 401
const authed = fn => async (req, b, ip) => {
  const who = await findMember(req)
  if (!who) return [401, { error: '金鑰無效' }]
  const before = saves
  try {
    return await fn(who, b, ip)
  } finally {
    // 過期動態或版本要存，而路由自己沒存成功（GET /friends 之類，或路由丟了例外）才補存一次（fix-7：用 finally，丟例外也補）；
    // 路由存的時候已經帶到記憶體裡最新的內容。版本單獨寫成功之後才記成已寫，存檔丟錯就不記，下個請求再試
    // 最後一個人離開、群組已經沒有成員就不補存（fix-8，跟 Worker 版一致）
    if (who.needsSave && saves === before && Object.keys(who.g.members).length > 0) {
      try { save() } catch (err) { console.error(`⚠ 存資料檔失敗（${err.code ?? err.message}），下次再試`) }
    }
    if (who.verWrite && saves !== before) core.markVerWritten(who.mem, Date.now())
  }
}

const routes = {
  'POST /groups': async (req, b) => {
    if (PUBLIC_CAPACITY && activeMembershipCount(db.groups) + capacityReservations >= CAPACITY_BLOCK_AT) return [503, { error: CAPACITY_ERROR }]
    if (PUBLIC_CAPACITY) capacityReservations += 1
    try {
      const r = await core.createGroup(b, Date.now(), ver(req))
      if (r.error) return r.error
      db.groups[r.groupId] = r.g
      save()
      return r.reply
    } finally { if (PUBLIC_CAPACITY) capacityReservations -= 1 }
  },
  'POST /join': async (req, b, ip) => {
    if (limited('join:' + ip, 10, 3_600_000)) return [429, { error: '嘗試太多次，一小時後再試' }]
    if (PUBLIC_CAPACITY && activeMembershipCount(db.groups) + capacityReservations >= CAPACITY_BLOCK_AT) return [503, { error: CAPACITY_ERROR }]
    if (PUBLIC_CAPACITY) capacityReservations += 1
    try {
      const groupId = core.groupIdOfInvite(core.clean(b.invite, 200))
      const r = await core.join(groupOf(groupId), groupId, b, Date.now(), ver(req))
      if (r[0] === 200) save()
      return r
    } finally { if (PUBLIC_CAPACITY) capacityReservations -= 1 }
  },
  'POST /status': authed(async (who, b) => {
    const now = Date.now()
    const [code, obj] = core.status(who.g, who.memberId, who.mem, b, now, who.ver)
    if (WEEKLY && code === 200) await core.recordWeekly(db.weekly, who.groupId, now)
    // 開發版連在線狀態一起存（示範中繼重開不掉人）；Worker 版只在動態換了才寫
    if (code === 200) save()
    return [code, obj]
  }),
  // 拉好友列表（舊版 mod 用；新版從 /status 的回應拿）
  'GET /friends': authed(who => [200, core.friendsView(who.g, who.memberId, Date.now())]),
  'POST /invite/rotate': authed(async who => {
    const r = await core.rotateInvite(who.g, who.groupId, who.memberId)
    if (r[0] === 200) save()
    return r
  }),
  'POST /kick': authed(async (who, b) => {
    const r = await core.kick(who.g, who.groupId, who.memberId, b)
    if (r[0] === 200) save()
    return r
  }),
  'POST /name': async (req, b, ip) => {
    const invalid = core.renameInputError(b)
    if (invalid) return invalid
    return await authed(who => {
      if (limited('rename:' + ip, core.RENAME_GLOBAL_MAX, core.RENAME_GLOBAL_WINDOW_MS)) return [429, { error: '改名太頻繁' }]
      const r = core.rename(who.mem, b, Date.now())
      if (r[0] === 200) save()
      return r
    })(req, b, ip)
  },
  'POST /leave': authed(who => {
    const { reply, isEmpty } = core.leave(who.g, who.memberId)
    if (isEmpty) delete db.groups[who.groupId]
    save()
    return reply
  }),
  'GET /health': async () => [200, { ok: true }],
}
if (WEEKLY && ADMIN_KEY) {
  routes['GET /admin/weekly'] = async req =>
    (await core.isAdmin(req.headers.authorization, ADMIN_KEY)) ? [200, core.weeklyView(db.weekly, Date.now())] : [401, { error: '金鑰無效' }]
}

// 大小算位元組（跟 Worker 版的 content-length 一樣，L-6）；整段收完再一次解碼，中文字被切在兩個 chunk 中間也不會壞
async function body(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > core.MAX_BODY) throw new Error('too large')
    chunks.push(chunk)
  }
  // 開頭的 UTF-8 BOM 去掉，跟 Worker 版的 TextDecoder 一致（fix-5）
  const raw = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
  return core.parseBody(raw)
}

const server = http.createServer(async (req, res) => {
  const testIp = TEST_IP_HEADER ? req.headers['x-test-ip'] : undefined
  const ip = (typeof testIp === 'string' && testIp) || (req.socket.remoteAddress ?? '')
  const send = async (code, obj) => {
    const body = JSON.stringify(obj)
    const nonceHeader = req.headers['x-friends-nonce']
    const originHeader = req.headers['x-friends-origin']
    const nonce = typeof nonceHeader === 'string' && RESPONSE_NONCE_RE.test(nonceHeader) ? nonceHeader : ''
    const origin = typeof originHeader === 'string' && /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(originHeader) ? originHeader : ''
    const path = new URL(req.url, 'http://x').pathname
    const { keyId, signature } = await signResponse({ nonce, origin, method: req.method, path, status: code, body })
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'x-friends-nonce': nonce,
      'x-friends-key-id': keyId,
      'x-friends-signature': signature,
    })
    res.end(body)
  }
  try {
    if (limited('ip:' + ip, 600, 60_000)) return await send(429, { error: '請求太頻繁' })
    const path = new URL(req.url, 'http://x').pathname
    const route = routes[`${req.method} ${path}`]
    if (!route) return await send(404, { error: 'not found' })
    if (req.method === 'POST' && !core.isJsonType(req.headers['content-type'])) return await send(415, { error: '要 application/json' })
    const b = req.method === 'POST' ? await body(req) : {}
    const [code, obj] = await route(req, b, ip)
    await send(code, obj)
  } catch (err) {
    if (!res.headersSent) await send(400, { error: '請求格式錯誤' })
  }
})

server.listen(PORT, '127.0.0.1', () => console.log(`friends relay on http://127.0.0.1:${PORT}`))
