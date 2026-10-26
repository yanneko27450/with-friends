// 中繼核心：本機開發版（server.mjs）和 Cloudflare Worker 版（worker/）共用同一份，API 才不會兩邊各寫各的。
// 只用 Web 標準（crypto.subtle、getRandomValues），Node 23.6+ 和 Workers 都能跑。
// 一個群組 g = { name, inviteHash, ownerId, members: { [id]: { name, keyHash, conns: { [conn]: { state, seenAt } }, action, subject, activityAt, seenAt, version, avatar } } }
import { isAction, isAvatar, isSubject } from '../mod/hooks/taxonomy.ts'
import { cleanName } from '../mod/hooks/text.ts'

// 心跳 60 秒一次（cost-2），漏一次不算離線
export const OFFLINE_MS = 150_000
export const MAX_MEMBERS = 10 // 主人 10-11 定案：免費額度內要 2 倍餘裕（relay/COST.md）
export const MAX_BODY = 4096
// POST 一律要 application/json：別的網站用 no-cors＋text/plain 打不進來（會被瀏覽器預檢擋下），
// 就不能借瀏覽者的 IP 繞過加入限流、塞假成員（web-2 資安審查 4）
export const isJsonType = ct => /^application\/json\s*(;|$)/i.test(ct ?? '')
// 同一個人可能同時開好幾個 Code 對話，每個對話是一條連線（conn）。conn 是 mod 隨機產生的不透明 id，
// 只存在中繼、不回給好友；格式卡死，不能拿來夾帶文字給別人看
export const CONN_RE = /^[A-Za-z0-9_-]{8,64}$/
export const MAX_CONNS = 20
// 群組 id＝token(9)＝12 個 base64url 字元
export const GROUP_ID_RE = /^[A-Za-z0-9_-]{12}$/
// 外掛版本（ui-19f ②，主人 10-12 選「要，只送版本號」）：只收 x.y.z，不能拿來夾帶文字
export const VERSION_RE = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/
// ver-2：外掛最低版本。中繼改協定時調高，舊版外掛會在 pane 提示升級，而不是突然壞掉
export const MIN_VERSION = '0.3.0'
/**
 * ver-2b：請求標頭 X-Friends-Version 的值（外掛帶 plugin.json 的 x.y.z、網頁版帶 web）。
 * 格式不對（跟 body.version 同一個 VERSION_RE）、沒帶都當沒帶（回 ''）；先只用來分辨新舊版，不依它拒絕任何請求
 */
export const clientVersion = h => (typeof h === 'string' && (VERSION_RE.test(h) || h === 'web') ? h : '')
/**
 * 請求內文（fix-7，兩個中繼共用）：空的當 {}；解開來一定要是一般物件。null、陣列、數字、字串、布林都丟錯（呼叫端回固定的 400），
 * 免得路由拿到 null 才在 Object.keys(null) 這類地方丟 TypeError——那會讓已經改過記憶體的動作（過期動態、版本）沒存到
 */
export function parseBody(raw) {
  if (!raw) return {}
  const b = JSON.parse(raw)
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new Error('body must be an object')
  return b
}
/** fix-6：每個成員為了版本單獨寫一次資料庫，最少隔這麼久 */
export const VER_WRITE_MS = 3_600_000
// 每個成員物件的版本寫入狀態：at＝上次為了版本單獨寫成功的時間、pending＝有變動還沒寫成功。只放記憶體（WeakMap）：
// 重開之後從頭算，第一次變動就寫
const verState = new WeakMap()
/**
 * ver-2c／fix-6／fix-7：記下這個成員最後一次帶來的版本（clientVersion 的結果）。只存在伺服器端的成員資料（欄位 ver）：
 * 不放進任何回應、不依版本拒絕；將來 ops 要看「還有幾個人在用舊版」就從這裡算。
 * 版本一定先改記憶體；回 true＝呼叫端現在要為它單獨寫一次資料庫，**寫成功之後要呼叫 markVerWritten**（fix-7：
 * 寫之前路由丟例外、或儲存丟錯，就不會被記成已寫，下一個請求會再回 true 重試）：
 *   ① 這個成員第一次變動，或距離上次為版本單獨寫成功已滿一小時而且有變動；
 *   ② 變過但還沒寫成功（pending），而且現在可以寫了（沒寫過，或距上次寫成功已滿一小時；就算這次的版本跟記憶體裡一樣）。
 * 其他情況回 false：變動只留在記憶體，跟下一次本來就要寫的事（動態換了、加入、離開）一起存。
 * 這樣同一個人新舊版本並用、版本來回變時，每個成員每小時最多為版本單獨寫一次，也不會每次心跳都寫（relay/COST.md：心跳不寫資料庫）。
 * 時鐘倒退（now 比上次還早）當作已過期，照寫
 */
export function noteVer(mem, ver, now = Date.now()) {
  const v = ver ?? ''
  const changed = (mem.ver ?? '') !== v
  if (changed) mem.ver = v
  let st = verState.get(mem)
  if (!st) verState.set(mem, (st = { at: undefined, pending: false }))
  if (!changed && !st.pending) return false
  st.pending = true
  return st.at === undefined || now < st.at || now - st.at >= VER_WRITE_MS
}
/** 版本單獨寫成功之後呼叫（fix-7）：記下時間、清掉待補寫 */
export function markVerWritten(mem, now = Date.now()) {
  verState.set(mem, { at: now, pending: false })
}

const hex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('')
export const sha = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))

export function token(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// 群組 id 是 base64url，本身可能含 '-'，所以邀請碼用 base64url 不會出現的 '.' 分隔
export const newInvite = groupId => `${groupId}.${token(16)}`
export const groupIdOfInvite = invite => invite.split('.')[0]

// 兩個等長 hex 字串的固定時間比較
function sameHex(a, b) {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

// 名字清理和外掛共用一份（mod/hooks/text.ts）：控制字元、零寬字元、方向控制字元都擋
export const clean = cleanName

/** Authorization: Bearer <groupId>.<memberId>.<key> → 三段，格式不對回 null */
export function parseAuth(header) {
  const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(header ?? '')
  return m ? { groupId: m[1], memberId: m[2], key: m[3] } : null
}

/** 金鑰對才回成員 */
export async function findMember(g, memberId, key) {
  // 只認自己的欄位：memberId 是請求給的，__proto__、constructor 這種名字不能摸到物件內建的東西（sec-9）
  const mem = g && typeof memberId === 'string' && Object.hasOwn(g.members, memberId) ? g.members[memberId] : null
  if (!mem || typeof key !== 'string') return null
  return sameHex(await sha(key), mem.keyHash) ? mem : null
}

export async function addMember(g, name, now, ver = '') {
  const memberId = token(6)
  const key = token(32)
  g.members[memberId] = { name, keyHash: await sha(key), conns: {}, action: '', subject: '', activityAt: 0, seenAt: now, ver }
  return { memberId, key }
}

/** 新群組：建立者自動加入 */
export async function createGroup(b, now, ver = '') {
  const name = clean(b.name, 20)
  const groupName = clean(b.groupName, 30) || `${name} 的群組`
  if (!name) return { error: [400, { error: '要給名字' }] }
  const groupId = token(9)
  const invite = newInvite(groupId)
  const g = { name: groupName, inviteHash: await sha(invite), inviteGeneration: 0, ownerId: '', members: {} }
  const { memberId, key } = await addMember(g, name, now, ver)
  g.ownerId = memberId
  return { groupId, g, reply: [200, { groupId, groupName, invite, inviteGeneration: g.inviteGeneration, memberId, memberKey: key, isOwner: true }] }
}

/** 用邀請碼加入（限流由呼叫端先做） */
export async function join(g, groupId, b, now, ver = '') {
  const invite = clean(b.invite, 200)
  const name = clean(b.name, 20)
  if (!g || g.inviteHash !== (await sha(invite))) return [403, { error: '邀請碼不對或已失效' }]
  if (!name) return [400, { error: '要給名字' }]
  if (Object.keys(g.members).length >= MAX_MEMBERS) return [403, { error: '群組滿了' }]
  const { memberId, key } = await addMember(g, name, now, ver)
  return [200, { groupId, groupName: g.name, invite, inviteGeneration: Number.isSafeInteger(g.inviteGeneration) ? g.inviteGeneration : 0, memberId, memberKey: key, isOwner: false }]
}

// 任一對話在工作就算工作中；所有對話都結束或 150 秒沒心跳才算離線
export function presence(mem, now) {
  const live = Object.values(mem.conns ?? {}).filter(c => now - c.seenAt <= OFFLINE_MS)
  if (live.length === 0) return 'offline'
  return live.some(c => c.state === 'working') ? 'working' : 'idle'
}

// 好友看得到的只有這 10 個欄位（連線 id、金鑰雜湊都不回）
export function friendsView(g, meId, now) {
  const members = Object.entries(g.members).map(([id, m]) => ({
    id,
    name: m.name,
    isMe: id === meId,
    isOwner: id === g.ownerId,
    presence: presence(m, now),
    action: m.action,
    subject: m.subject,
    activityAgoSec: m.activityAt ? Math.round((now - m.activityAt) / 1000) : null,
    seenAgoSec: Math.round((now - m.seenAt) / 1000),
    version: m.version ?? '',
    avatar: m.avatar ?? '',
  }))
  return { groupName: g.name, minVersion: MIN_VERSION, members }
}

/**
 * 送自己某一個對話的狀態（也是心跳）。回 [code, obj, isDirty]：
 * isDirty＝要寫進資料庫的東西變了（動態換了）；在線狀態只是心跳，不算（relay/COST.md：心跳不寫資料庫）
 */
export function status(g, meId, mem, b, now) {
  const extra = Object.keys(b).filter(k => !['state', 'action', 'subject', 'paused', 'conn', 'version', 'avatar'].includes(k))
  // 固定句子，不回顯請求的鍵名（錯誤只能是固定句子，fix-8）
  if (extra.length) return [400, { error: '不收的欄位' }, false]
  const state = ['working', 'idle', 'offline'].includes(b.state) ? b.state : 'idle'
  // 動態只能是兩個清單內代碼，或兩個都不給（＝只是心跳，保留舊動態）；暫停分享要明確送 paused: true 才清
  const hasActivity = b.action !== undefined || b.subject !== undefined
  if (hasActivity && !(isAction(b.action) && isSubject(b.subject))) return [400, { error: '動態代碼不在清單裡' }, false]
  if (b.paused !== undefined && typeof b.paused !== 'boolean') return [400, { error: 'paused 要是 true 或 false' }, false]
  if (b.paused === true && hasActivity) return [400, { error: '暫停時不能帶動態' }, false]
  // __proto__ 符合格式，但拿來當物件的鍵會換掉原型、這筆連線就消失了（sec-9）
  if (b.conn !== undefined && !(typeof b.conn === 'string' && CONN_RE.test(b.conn) && b.conn !== '__proto__')) return [400, { error: '連線 id 格式不對' }, false]
  if (b.version !== undefined && !(typeof b.version === 'string' && VERSION_RE.test(b.version))) return [400, { error: '版本格式不對' }, false]
  // ui-22：頭像只收清單內代碼（不收網址、圖片、SVG、自由文字）
  if (b.avatar !== undefined && !isAvatar(b.avatar)) return [400, { error: '頭像不在清單裡' }, false]
  const conn = b.conn ?? '-'
  const conns = (mem.conns ??= {})
  for (const [id, c] of Object.entries(conns)) if (now - c.seenAt > OFFLINE_MS) delete conns[id]
  if (state === 'offline') delete conns[conn]
  else conns[conn] = { state, seenAt: now }
  const ids = Object.keys(conns)
  if (ids.length > MAX_CONNS) {
    ids.sort((x, y) => conns[x].seenAt - conns[y].seenAt)
    for (const id of ids.slice(0, ids.length - MAX_CONNS)) delete conns[id]
  }
  mem.seenAt = now
  let isDirty = false
  // 版本只在換了的時候寫進資料庫（每個對話開始時送一次）
  if (b.version !== undefined && b.version !== mem.version) {
    mem.version = b.version
    isDirty = true
  }
  if (b.avatar !== undefined && b.avatar !== mem.avatar) {
    mem.avatar = b.avatar
    isDirty = true
  }
  if (b.paused === true || hasActivity) {
    const action = hasActivity ? b.action : ''
    const subject = hasActivity ? b.subject : ''
    if (action !== mem.action || subject !== mem.subject) {
      mem.action = action
      mem.subject = subject
      mem.activityAt = action ? now : 0
      isDirty = true
    }
  }
  // 順便回好友列表：pane 開著的對話一次請求做兩件事（relay/COST.md）
  return [200, { ok: true, ...friendsView(g, meId, now) }, isDirty]
}

// 動態只保存 24 小時（sec-3：資料最小化）；過期就從資料庫清掉，不只是不顯示
export const ACTIVITY_TTL_MS = 24 * 3_600_000

/** 清掉超過保存期限的動態；回傳有沒有清（＝要寫回資料庫） */
export function expireActivity(g, now, ttl = ACTIVITY_TTL_MS) {
  let isDirty = false
  for (const m of Object.values(g.members)) {
    if (m.activityAt && now - m.activityAt > ttl) {
      m.action = ''
      m.subject = ''
      m.activityAt = 0
      isDirty = true
    }
  }
  return isDirty
}

/** 下一筆動態到期的時間（沒有動態＝null），Worker 用來排 alarm */
export function nextExpiry(g, ttl = ACTIVITY_TTL_MS) {
  const times = Object.values(g.members).filter(m => m.activityAt).map(m => m.activityAt + ttl + 1)
  return times.length ? Math.min(...times) : null
}

/** 換邀請碼（只有建立者）；回 [code, obj] */
export async function rotateInvite(g, groupId, meId) {
  if (meId !== g.ownerId) return [403, { error: '只有建立者能換邀請碼' }]
  const invite = newInvite(groupId)
  const inviteHash = await sha(invite)
  // sha 會 yield；必須在它回來後才讀／推進世代，並行請求才不會拿到同一個數字。
  const generation = Number.isSafeInteger(g.inviteGeneration) ? g.inviteGeneration : 0
  if (generation >= Number.MAX_SAFE_INTEGER) return [409, { error: '邀請碼世代已用完' }]
  g.inviteHash = inviteHash
  g.inviteGeneration = generation + 1
  return [200, { invite, inviteGeneration: g.inviteGeneration }]
}

/** 踢人（只有建立者）；踢完自動換邀請碼 */
export async function kick(g, groupId, meId, b) {
  if (meId !== g.ownerId) return [403, { error: '只有建立者能踢人' }]
  if (typeof b.memberId !== 'string' || !Object.hasOwn(g.members, b.memberId) || b.memberId === meId) return [400, { error: '找不到這個人' }]
  const invite = newInvite(groupId)
  const inviteHash = await sha(invite)
  const generation = Number.isSafeInteger(g.inviteGeneration) ? g.inviteGeneration : 0
  if (generation >= Number.MAX_SAFE_INTEGER) return [409, { error: '邀請碼世代已用完' }]
  delete g.members[b.memberId]
  g.inviteHash = inviteHash
  g.inviteGeneration = generation + 1
  return [200, { ok: true, invite, inviteGeneration: g.inviteGeneration }]
}

/** 離開；回 isEmpty＝群組空了要整組刪 */
export function leave(g, meId) {
  delete g.members[meId]
  const ids = Object.keys(g.members)
  if (ids.length > 0 && meId === g.ownerId) g.ownerId = ids[0]
  return { reply: [200, { ok: true }], isEmpty: ids.length === 0 }
}

/** 簡單限流（記憶體裡、各自的程序或 isolate 各算各的） */
export function makeLimiter() {
  const hits = new Map()
  return (key, max, windowMs, now = Date.now()) => {
    const h = hits.get(key)
    if (!h || now - h.at > windowMs) {
      if (hits.size > 10_000) hits.clear()
      hits.set(key, { at: now, n: 1 })
      return false
    }
    h.n += 1
    return h.n > max
  }
}

// ops-2a：營運者自己開的「每週活躍群組數」（這週有送過狀態的群組有幾個）。預設關：伺服器沒開就不呼叫這些，什麼都不記、不回。
// 只存週次和群組代碼的雜湊，不存群組名、成員、動態；週次＝從 1970 起第幾個 7 天（UTC），不是日曆週
export const WEEK_MS = 7 * 86_400_000
export const weekOf = now => Math.floor(now / WEEK_MS)
export const newWeeklyStats = () => ({ week: -1, groups: [], lastWeek: null })

function rollWeek(stats, now) {
  const week = weekOf(now)
  if (stats.week === week) return false
  // 上一週有記錄就留它的數字；中間空了好幾週，上一週就是 0；剛開始記（week -1）上一週不知道，留 null
  if (stats.week >= 0) stats.lastWeek = { week: week - 1, activeGroups: stats.week === week - 1 ? stats.groups.length : 0 }
  stats.week = week
  stats.groups = []
  return true
}

export const weeklyHash = (week, groupId) => sha(`weekly:${week}:${groupId}`)

/** 記一次「這個群組這週有活動」；回傳要不要寫回 */
export async function recordWeekly(stats, groupId, now) {
  let isDirty = rollWeek(stats, now)
  // 雜湊帶週次：同一個群組每週的雜湊都不一樣，留著舊備份也串不起跨週
  const h = await weeklyHash(stats.week, groupId)
  if (!stats.groups.includes(h)) {
    stats.groups.push(h)
    isDirty = true
  }
  return isDirty
}

/** 給營運者看的數字：只有週次和群組數 */
export function weeklyView(stats, now) {
  rollWeek(stats, now)
  return { week: stats.week, activeGroups: stats.groups.length, lastWeek: stats.lastWeek }
}

/** 管理金鑰的格式：24～200 個非空白字元（伺服器啟動時檢查，不合格就不開查詢端點） */
export const ADMIN_KEY_RE = /^\S{24,200}$/

/** 管理金鑰：只收 Bearer <金鑰>，跟設定的金鑰比雜湊（固定時間）；沒設金鑰一律 false */
export async function isAdmin(header, adminKey) {
  if (!adminKey || typeof header !== 'string') return false
  const m = /^Bearer (\S{1,200})$/.exec(header)
  return !!m && sameHex(await sha(m[1]), await sha(adminKey))
}
