// Claude 好友動態：本機中繼（開發用，無套件）。正式版是 relay/worker（Cloudflare），兩邊共用 relay/core.mjs。
// 借鑑 SaharCarmel/claude-who（MIT）：邀請碼＋每人金鑰、中繼只存金鑰雜湊。
// 動態只收封閉詞彙的兩個代碼（action／subject），清單在 mod/hooks/taxonomy.ts，core.mjs 直接 import 同一份。
// 用法：node relay/server.mjs [--port 8789] [--data relay/data.json]（需要 Node 23.6+，直接讀 .ts）
import http from 'node:http'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import * as core from './core.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : dflt
}
const PORT = Number(arg('--port', process.env.PORT ?? 8789))
const DATA = arg('--data', '')
// 測試用：把 24 小時的動態保存期限縮短
const TTL = Number(arg('--activity-ttl-ms', core.ACTIVITY_TTL_MS))

// db.groups[groupId] = core.mjs 開頭寫的群組格式
let db = { groups: {} }
if (DATA && existsSync(DATA)) db = JSON.parse(readFileSync(DATA, 'utf8'))
function save() {
  if (!DATA) return
  writeFileSync(DATA + '.tmp', JSON.stringify(db))
  renameSync(DATA + '.tmp', DATA)
}

// 過期動態：沒人來讀也要從資料檔清掉（sec-3）
function sweep() {
  let isDirty = false
  for (const g of Object.values(db.groups)) isDirty = core.expireActivity(g, Date.now(), TTL) || isDirty
  if (isDirty) save()
}
sweep()
setInterval(sweep, Math.min(60_000, TTL)).unref()

// 簡單限流：每個 IP 每分鐘 600 次；加入每小時 10 次
const limited = core.makeLimiter()

async function findMember(req) {
  const a = core.parseAuth(req.headers.authorization)
  if (!a) return null
  const g = db.groups[a.groupId]
  if (g && core.expireActivity(g, Date.now(), TTL)) save()
  const mem = await core.findMember(g, a.memberId, a.key)
  return mem ? { g, groupId: a.groupId, memberId: a.memberId, mem } : null
}

// 要登入的路由：金鑰不對一律 401
const authed = fn => async (req, b) => {
  const who = await findMember(req)
  return who ? fn(who, b) : [401, { error: '金鑰無效' }]
}

const routes = {
  'POST /groups': async (req, b) => {
    const r = await core.createGroup(b, Date.now())
    if (r.error) return r.error
    db.groups[r.groupId] = r.g
    save()
    return r.reply
  },
  'POST /join': async (req, b, ip) => {
    if (limited('join:' + ip, 10, 3_600_000)) return [429, { error: '嘗試太多次，一小時後再試' }]
    const groupId = core.groupIdOfInvite(core.clean(b.invite, 200))
    const r = await core.join(db.groups[groupId], groupId, b, Date.now())
    if (r[0] === 200) save()
    return r
  },
  'POST /status': authed((who, b) => {
    const [code, obj] = core.status(who.g, who.memberId, who.mem, b, Date.now())
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
  'POST /leave': authed(who => {
    const { reply, isEmpty } = core.leave(who.g, who.memberId)
    if (isEmpty) delete db.groups[who.groupId]
    save()
    return reply
  }),
  'GET /health': async () => [200, { ok: true }],
}

async function body(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > core.MAX_BODY) throw new Error('too large')
  }
  return raw ? JSON.parse(raw) : {}
}

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress ?? ''
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  try {
    if (limited('ip:' + ip, 600, 60_000)) return send(429, { error: '請求太頻繁' })
    const path = new URL(req.url, 'http://x').pathname
    const route = routes[`${req.method} ${path}`]
    if (!route) return send(404, { error: 'not found' })
    const b = req.method === 'POST' ? await body(req) : {}
    const [code, obj] = await route(req, b, ip)
    send(code, obj)
  } catch (err) {
    send(400, { error: '請求格式錯誤' })
  }
})

server.listen(PORT, '127.0.0.1', () => console.log(`friends relay on http://127.0.0.1:${PORT}`))
