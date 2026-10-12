// 中繼核心：本機開發版（server.mjs）和 Cloudflare Worker 版（worker/）共用同一份，API 才不會兩邊各寫各的。
// 只用 Web 標準（crypto.subtle、getRandomValues），Node 23.6+ 和 Workers 都能跑。
// 一個群組 g = { name, inviteHash, ownerId, members: { [id]: { name, keyHash, conns: { [conn]: { state, seenAt } }, action, subject, activityAt, seenAt } } }
import { isAction, isSubject } from '../mod/hooks/taxonomy.ts'
import { cleanName } from '../mod/hooks/text.ts'

// 心跳 60 秒一次（cost-2），漏一次不算離線
export const OFFLINE_MS = 150_000
export const MAX_MEMBERS = 10 // 主人 10-11 定案：免費額度內要 2 倍餘裕（relay/COST.md）
export const MAX_BODY = 4096
// 同一個人可能同時開好幾個 Code 對話，每個對話是一條連線（conn）。conn 是 mod 隨機產生的不透明 id，
// 只存在中繼、不回給好友；格式卡死，不能拿來夾帶文字給別人看
export const CONN_RE = /^[A-Za-z0-9_-]{8,64}$/
export const MAX_CONNS = 20
// 群組 id＝token(9)＝12 個 base64url 字元
export const GROUP_ID_RE = /^[A-Za-z0-9_-]{12}$/

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
  const mem = g?.members[memberId]
  if (!mem) return null
  return sameHex(await sha(key), mem.keyHash) ? mem : null
}

export async function addMember(g, name, now) {
  const memberId = token(6)
  const key = token(32)
  g.members[memberId] = { name, keyHash: await sha(key), conns: {}, action: '', subject: '', activityAt: 0, seenAt: now }
  return { memberId, key }
}

/** 新群組：建立者自動加入 */
export async function createGroup(b, now) {
  const name = clean(b.name, 20)
  const groupName = clean(b.groupName, 30) || `${name} 的群組`
  if (!name) return { error: [400, { error: '要給名字' }] }
  const groupId = token(9)
  const invite = newInvite(groupId)
  const g = { name: groupName, inviteHash: await sha(invite), ownerId: '', members: {} }
  const { memberId, key } = await addMember(g, name, now)
  g.ownerId = memberId
  return { groupId, g, reply: [200, { groupId, groupName, invite, memberId, memberKey: key, isOwner: true }] }
}

/** 用邀請碼加入（限流由呼叫端先做） */
export async function join(g, groupId, b, now) {
  const invite = clean(b.invite, 200)
  const name = clean(b.name, 20)
  if (!g || g.inviteHash !== (await sha(invite))) return [403, { error: '邀請碼不對或已失效' }]
  if (!name) return [400, { error: '要給名字' }]
  if (Object.keys(g.members).length >= MAX_MEMBERS) return [403, { error: '群組滿了' }]
  const { memberId, key } = await addMember(g, name, now)
  return [200, { groupId, groupName: g.name, invite, memberId, memberKey: key, isOwner: false }]
}

// 任一對話在工作就算工作中；所有對話都結束或 150 秒沒心跳才算離線
export function presence(mem, now) {
  const live = Object.values(mem.conns ?? {}).filter(c => now - c.seenAt <= OFFLINE_MS)
  if (live.length === 0) return 'offline'
  return live.some(c => c.state === 'working') ? 'working' : 'idle'
}

// 好友看得到的只有這 9 個欄位（連線 id、金鑰雜湊都不回）
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
  }))
  return { groupName: g.name, members }
}

/**
 * 送自己某一個對話的狀態（也是心跳）。回 [code, obj, isDirty]：
 * isDirty＝要寫進資料庫的東西變了（動態換了）；在線狀態只是心跳，不算（relay/COST.md：心跳不寫資料庫）
 */
export function status(g, meId, mem, b, now) {
  const extra = Object.keys(b).filter(k => !['state', 'action', 'subject', 'paused', 'conn'].includes(k))
  if (extra.length) return [400, { error: '不收的欄位：' + extra.join(',') }, false]
  const state = ['working', 'idle', 'offline'].includes(b.state) ? b.state : 'idle'
  // 動態只能是兩個清單內代碼，或兩個都不給（＝只是心跳，保留舊動態）；暫停分享要明確送 paused: true 才清
  const hasActivity = b.action !== undefined || b.subject !== undefined
  if (hasActivity && !(isAction(b.action) && isSubject(b.subject))) return [400, { error: '動態代碼不在清單裡' }, false]
  if (b.paused !== undefined && typeof b.paused !== 'boolean') return [400, { error: 'paused 要是 true 或 false' }, false]
  if (b.paused === true && hasActivity) return [400, { error: '暫停時不能帶動態' }, false]
  if (b.conn !== undefined && !(typeof b.conn === 'string' && CONN_RE.test(b.conn))) return [400, { error: '連線 id 格式不對' }, false]
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
  g.inviteHash = await sha(invite)
  return [200, { invite }]
}

/** 踢人（只有建立者）；踢完自動換邀請碼 */
export async function kick(g, groupId, meId, b) {
  if (meId !== g.ownerId) return [403, { error: '只有建立者能踢人' }]
  if (typeof b.memberId !== 'string' || !Object.hasOwn(g.members, b.memberId) || b.memberId === meId) return [400, { error: '找不到這個人' }]
  delete g.members[b.memberId]
  const invite = newInvite(groupId)
  g.inviteHash = await sha(invite)
  return [200, { ok: true, invite }]
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
