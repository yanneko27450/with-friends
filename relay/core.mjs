// 中繼核心：本機開發版（server.mjs）和 Cloudflare Worker 版（worker/）共用同一份，API 才不會兩邊各寫各的。
// 只用 Web 標準（crypto.subtle、getRandomValues），Node 23.6+ 和 Workers 都能跑。
// 一個群組 g = { name, inviteHash, ownerId, members: { [id]: { name, keyHash, conns: { [conn]: { state, seenAt } }, action, subject, activityAt, seenAt, version, avatar } } }
import { isAction, isAvatar, isSubject } from '../mod/hooks/taxonomy.ts'
import { cleanName, isValidNameInput } from '../mod/hooks/text.ts'
import { nobleEd25519Verify } from '../mod/hooks/noble-crypto.js'

// 心跳 60 秒一次（cost-2），漏一次不算離線
export const OFFLINE_MS = 150_000
// 主人 10-21 定「好友上限先以 5 人為限」（SEC064，原本 10-11 定的 10 人作廢）。舊群組已超過 5 人的不踢，只是不再收新人
export const MAX_MEMBERS = 5
// 建立者可以設的人數上限範圍（跟面板 mod/hooks/owner-settings.ts 的 OWNER_CAP_MIN／OWNER_CAP_MAX 同值）
export const OWNER_CAP_MIN = 2
export const OWNER_CAP_MAX = 5
// 需要建立者同意才能加入：等待中的人最多 10 個、10 分鐘過期；只有送 0.6.4 以上版本標頭的外掛會拿到「等待同意」的回應
export const PENDING_MAX = 10
export const PENDING_TTL_MS = 600_000
export const PENDING_MIN_VERSION = '0.6.4'
export const WHO_CAN_INVITE = ['owner', 'members']
export const MAX_BODY = 4096
export const MAX_NAME = 20
export const RENAME_COOLDOWN_MS = 60_000
export const RENAME_GLOBAL_MAX = 30
export const RENAME_GLOBAL_WINDOW_MS = 60_000
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

// 群組設定（SEC064）。舊群組沒有這些欄位：缺＝不改變原本行為（誰都有邀請碼、不用同意），人數上限一律不超過 MAX_MEMBERS
export const whoCanInviteOf = g => (g.whoCanInvite === 'owner' ? 'owner' : 'members')
export const needsApprovalOf = g => g.needsApproval === true
export const capOf = g => (Number.isInteger(g.maxMembers) && g.maxMembers >= OWNER_CAP_MIN && g.maxMembers <= OWNER_CAP_MAX ? g.maxMembers : MAX_MEMBERS)
const pendingOf = g => (g.pending && typeof g.pending === 'object' && !Array.isArray(g.pending) ? g.pending : (g.pending = {}))

/** x.y.z 比大小（只收 VERSION_RE 格式）：a >= b */
export function versionAtLeast(a, b) {
  if (!VERSION_RE.test(a ?? '') || !VERSION_RE.test(b ?? '')) return false
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return true
}

/** 0000～9999 的均勻亂數（拒絕取樣，不偏）；同一群組等待中的不重複，試 50 次還撞（不可能）就回 '' */
function newPairingCode(taken) {
  const limit = 4_294_967_296 - (4_294_967_296 % 10_000)
  for (let tries = 0; tries < 50; tries++) {
    const [r] = crypto.getRandomValues(new Uint32Array(1))
    if (r >= limit) continue
    const code = String(r % 10_000).padStart(4, '0')
    if (!taken.has(code)) return code
  }
  return ''
}

/** 清掉過期的等待者；回傳有沒有清（＝要寫回資料庫） */
export function expirePending(g, now) {
  const pending = pendingOf(g)
  let isDirty = false
  for (const [id, p] of Object.entries(pending)) {
    if (!(Number.isSafeInteger(p?.createdAt) && now - p.createdAt < PENDING_TTL_MS && now >= p.createdAt - 60_000)) {
      delete pending[id]
      isDirty = true
    }
  }
  return isDirty
}

/** 下一筆等待者過期的時間（沒有＝null），Worker 排鬧鐘用 */
export function nextPendingExpiry(g) {
  const times = Object.values(pendingOf(g)).map(p => p.createdAt + PENDING_TTL_MS + 1)
  return times.length ? Math.min(...times) : null
}

/** 寫入失敗時，在原物件上還原成請求前的樣子（before 是 structuredClone 的快照，用過就別再用） */
export function restoreGroup(g, before) {
  for (const k of Object.keys(g)) delete g[k]
  Object.assign(g, before)
}

/** 新群組：建立者自動加入 */
export async function createGroup(b, now, ver = '') {
  const name = clean(b.name, 20)
  const groupName = clean(b.groupName, 30) || `${name} 的群組`
  if (!name) return { error: [400, { error: '要給名字' }] }
  const groupId = token(9)
  const invite = newInvite(groupId)
  const g = { name: groupName, inviteHash: await sha(invite), inviteGeneration: 0, ownerId: '', whoCanInvite: 'members', needsApproval: false, maxMembers: MAX_MEMBERS, avatar: '', pending: {}, members: {} }
  const { memberId, key } = await addMember(g, name, now, ver)
  g.ownerId = memberId
  return { groupId, g, reply: [200, { groupId, groupName, invite, inviteGeneration: g.inviteGeneration, memberId, memberKey: key, isOwner: true }] }
}

/** 用邀請碼加入（限流由呼叫端先做） */
export async function join(g, groupId, b, now, ver = '') {
  const invite = clean(b.invite, 200)
  const name = clean(b.name, 20)
  // 會讓出控制權（await）的雜湊先全部算完；從這裡之後到寫入之前不能有 await，
  // 並行的兩個加入才不會同時通過「人數／邀請碼」檢查（SEC064）
  const inviteHash = await sha(invite)
  const memberId = token(6)
  const key = token(32)
  const keyHash = await sha(key)
  if (!g || !g.inviteHash || g.inviteHash !== inviteHash) return [403, { error: '邀請碼不對或已失效' }]
  if (!name) return [400, { error: '要給名字' }]
  expirePending(g, now)
  const pending = pendingOf(g)
  if (Object.keys(g.members).length >= capOf(g)) return [403, { error: '群組滿了' }]
  if (Object.hasOwn(g.members, memberId) || Object.hasOwn(pending, memberId)) return [503, { error: '請再試一次' }]
  const before = structuredClone(g) // 寫入失敗時交給 restoreGroup（第 4 個元素）
  if (needsApprovalOf(g)) {
    // 舊版外掛和網頁版看不懂「等待同意」：不發憑證，請它先更新
    if (!versionAtLeast(ver, PENDING_MIN_VERSION)) return [403, { error: '這個群組要先經過建立者同意，請先更新外掛' }]
    if (Object.keys(pending).length >= PENDING_MAX) return [429, { error: '等待同意的人太多' }]
    const pairingCode = newPairingCode(new Set(Object.values(pending).map(p => p.pairingCode)))
    if (!pairingCode) return [503, { error: '請再試一次' }]
    pending[memberId] = { name, keyHash, pairingCode, createdAt: now, ver }
    return [202, { pending: true, groupId, groupName: g.name, memberId, memberKey: key, pairingCode, expiresAt: now + PENDING_TTL_MS }, true, before]
  }
  g.members[memberId] = { name, keyHash, conns: {}, action: '', subject: '', activityAt: 0, seenAt: now, ver }
  const reply = { groupId, groupName: g.name, memberId, memberKey: key, isOwner: false }
  // 「只有建立者能邀請」：加入的回應不附邀請碼，成員手上就沒有可以轉傳的碼
  if (whoCanInviteOf(g) === 'members') {
    reply.invite = invite
    reply.inviteGeneration = Number.isSafeInteger(g.inviteGeneration) ? g.inviteGeneration : 0
  }
  return [200, reply, true, before]
}

/** 加入的人輪詢自己有沒有被同意：金鑰對的等待者／成員才有回應，其餘（被拒、過期、被換碼清掉、金鑰錯、不存在）一律 401，不分原因 */
export async function joinStatus(g, memberId, key, now) {
  const keyHash = typeof key === 'string' ? await sha(key) : ''
  const denied = [401, { error: '金鑰無效' }, false]
  if (!g || typeof memberId !== 'string') return denied
  const isDirty = expirePending(g, now)
  if (Object.hasOwn(g.members, memberId)) return sameHex(keyHash, g.members[memberId].keyHash) ? [200, { state: 'approved' }, isDirty] : [401, denied[1], isDirty]
  const pending = pendingOf(g)
  if (Object.hasOwn(pending, memberId) && sameHex(keyHash, pending[memberId].keyHash)) {
    return [200, { state: 'pending', pairingCode: pending[memberId].pairingCode, expiresAt: pending[memberId].createdAt + PENDING_TTL_MS }, isDirty]
  }
  return [401, denied[1], isDirty]
}

// 任一對話在工作就算工作中；所有對話都結束或 150 秒沒心跳才算離線
export function presence(mem, now) {
  const live = Object.values(mem.conns ?? {}).filter(c => now - c.seenAt <= OFFLINE_MS)
  if (live.length === 0) return 'offline'
  // 0.5.6：成員層級暫停旗標在身上時，不論連線各自記什麼都只算在線（讀的時候再擋一次，不靠寫入時有沒有降好）
  return !mem.paused && live.some(c => c.state === 'working') ? 'working' : 'idle'
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
  const view = {
    groupName: g.name,
    minVersion: MIN_VERSION,
    settings: { whoCanInvite: whoCanInviteOf(g), needsApproval: needsApprovalOf(g), maxMembers: capOf(g), avatar: isAvatar(g.avatar) ? g.avatar : '' },
    members,
  }
  // 等待同意的人（名字、配對數字）只給建立者看；成員的回應連這個鍵都沒有
  if (meId === g.ownerId) {
    view.pending = Object.entries(pendingOf(g))
      .filter(([, p]) => now - p.createdAt < PENDING_TTL_MS)
      .sort((x, y) => x[1].createdAt - y[1].createdAt)
      .map(([requestId, p]) => ({ requestId, name: p.name, pairingCode: p.pairingCode }))
  }
  return view
}

/** 0.5.8：帶序號的暫停／繼續之後多久內，不信沒帶序號的「繼續」（見 status）。0.6.0 由 60 秒縮到 20 秒：混版本時卡住的時間更短 */
export const LEGACY_RESUME_GRACE_MS = 20_000

/** 0.5.6 起的外掛會在繼續分享時明確送 paused: false（成員層級暫停旗標只認這個來解除） */
export const canSendResume = ver => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(ver)
  if (!m) return false
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return a > 0 || b > 5 || (b === 5 && c >= 6)
}

/**
 * 送自己某一個對話的狀態（也是心跳）。回 [code, obj, isDirty]：
 * isDirty＝要寫進資料庫的東西變了（動態換了）；在線狀態只是心跳，不算（relay/COST.md：心跳不寫資料庫）
 */
export function status(g, meId, mem, b, now, ver = '') {
  const extra = Object.keys(b).filter(k => !['state', 'action', 'subject', 'paused', 'pauseSeq', 'conn', 'version', 'avatar'].includes(k))
  // 固定句子，不回顯請求的鍵名（錯誤只能是固定句子，fix-8）
  if (extra.length) return [400, { error: '不收的欄位' }, false]
  let state = ['working', 'idle', 'offline'].includes(b.state) ? b.state : 'idle'
  // 動態只能是兩個清單內代碼，或兩個都不給（＝只是心跳，保留舊動態）；暫停分享要明確送 paused: true 才清
  const hasActivity = b.action !== undefined || b.subject !== undefined
  if (hasActivity && !(isAction(b.action) && isSubject(b.subject))) return [400, { error: '動態代碼不在清單裡' }, false]
  if (b.paused !== undefined && typeof b.paused !== 'boolean') return [400, { error: 'paused 要是 true 或 false' }, false]
  if (b.paused === true && hasActivity) return [400, { error: '暫停時不能帶動態' }, false]
  // 0.5.8：暫停序號。外掛每次按暫停／繼續產生一個單調遞增的正整數，paused 請求都帶它（見下面的 pausedIn）
  if (b.pauseSeq !== undefined && !(Number.isSafeInteger(b.pauseSeq) && b.pauseSeq > 0)) return [400, { error: '暫停序號格式不對' }, false]
  if (b.pauseSeq !== undefined && b.paused === undefined) return [400, { error: '暫停序號要和 paused 一起送' }, false]
  // __proto__ 符合格式，但拿來當物件的鍵會換掉原型、這筆連線就消失了（sec-9）
  if (b.conn !== undefined && !(typeof b.conn === 'string' && CONN_RE.test(b.conn) && b.conn !== '__proto__')) return [400, { error: '連線 id 格式不對' }, false]
  if (b.version !== undefined && !(typeof b.version === 'string' && VERSION_RE.test(b.version))) return [400, { error: '版本格式不對' }, false]
  // ui-22：頭像只收清單內代碼（不收網址、圖片、SVG、自由文字）
  if (b.avatar !== undefined && !isAvatar(b.avatar)) return [400, { error: '頭像不在清單裡' }, false]
  // 沒帶序號的明確 paused:false（0.5.6／0.5.7 外掛）在帶序號的暫停／繼續剛發生後的緩衝期內不收，並回 409 讓它下一輪重送：
  // 亂序延遲不會長到緩衝期那麼久；緩衝期一過，混著用舊版對話的人按的繼續就會生效（不會永遠卡在暫停，盲審（三）必修 1）
  // 只在成員現在是暫停的時候才擋：已經是繼續狀態，沒帶序號的 paused:false 是無害的空操作，照常收（不讓舊外掛無謂地紅字 60 秒）
  if (b.pauseSeq === undefined && b.paused === false && mem.paused === true && (mem.pauseSeq ?? 0) > 0 && now - (mem.pauseSeqAt ?? 0) < LEGACY_RESUME_GRACE_MS)
    return [409, { error: '暫停才剛改過，請稍後再試' }, false]
  let isDirty = false
  // 0.5.6：暫停是「這位成員」的狀態，不是某一個對話的狀態。任一對話送 paused: true，這位成員就一直是暫停，
  // 直到有對話明確送 paused: false（繼續）；沒帶 paused 的心跳（例如還沒讀到暫停的另一個對話）不會解除，也不會讓好友看到動態。
  // 以前只把「當下已有的」連線降成 idle，另一個對話的心跳晚到最多約 10 秒又會顯示 working（R056b 留下的空窗）
  // 舊版外掛（0.5.6 以前，或沒帶版本）從來不送 paused: false：它按「繼續」後只是不再帶 paused。對它們維持舊語意
  // （沒帶 paused ＝ 繼續），不然按過一次暫停就會永遠卡在暫停
  let pausedIn = b.paused ?? (canSendResume(ver) ? undefined : false)
  // 0.5.8 資安：暫停／恢復兩個請求先後顛倒（較早按的「恢復」網路慢、晚到）不能把新的暫停蓋回恢復。
  // 帶序號的 paused 請求只在序號比已存的大時才算，否則整個 paused 欄位忽略（心跳照收）；
  // 用過序號的成員，沒帶序號的 paused:false 在帶序號的暫停／繼續後 LEGACY_RESUME_GRACE_MS 內不解除——
  // 明確的 paused:false（0.5.6／0.5.7 外掛）上面已回 409 讓它重送；更舊外掛沒帶 paused ＝ 繼續，這裡只是忽略。
  // 緩衝期過後都照舊語意生效（混用舊版對話不會永遠卡在暫停）；沒帶序號的 paused:true 任何時候都生效
  const seenSeq = mem.pauseSeq ?? 0
  if (b.pauseSeq !== undefined) {
    if (b.pauseSeq > seenSeq) {
      mem.pauseSeq = b.pauseSeq
      mem.pauseSeqAt = now
      isDirty = true
    } else if (!(b.pauseSeq === seenSeq && pausedIn === true)) {
      // 序號相同時「暫停」仍然有效（偏向暫停）：兩個對話同一毫秒各按暫停與繼續會拿到同一個序號；
      // 重送同一個暫停本來就是冪等的。同序號的「繼續」不收
      pausedIn = undefined
    }
  } else if (pausedIn === false && seenSeq > 0 && now - (mem.pauseSeqAt ?? 0) < LEGACY_RESUME_GRACE_MS) pausedIn = undefined
  if (pausedIn === true && mem.paused !== true) {
    mem.paused = true
    isDirty = true
  } else if (pausedIn === false && mem.paused) {
    delete mem.paused
    isDirty = true
  }
  const isPaused = mem.paused === true
  // 暫停時中繼一律把 working 當 idle 記（offline 照舊，結束對話要能收掉連線）。放在中繼而不只在外掛：
  // Node 版與 Worker 版共用這段，舊版外掛（暫停時還送 working）也一併被擋住；外掛端同樣改送 idle（雙保險，見 statusBody）
  if (isPaused && state === 'working') state = 'idle'
  const conn = b.conn ?? '-'
  const conns = (mem.conns ??= {})
  for (const [id, c] of Object.entries(conns)) if (now - c.seenAt > OFFLINE_MS) delete conns[id]
  if (state === 'offline') delete conns[conn]
  else conns[conn] = { state, seenAt: now }
  if (isPaused) for (const c of Object.values(conns)) if (c.state === 'working') c.state = 'idle'
  const ids = Object.keys(conns)
  if (ids.length > MAX_CONNS) {
    ids.sort((x, y) => conns[x].seenAt - conns[y].seenAt)
    for (const id of ids.slice(0, ids.length - MAX_CONNS)) delete conns[id]
  }
  mem.seenAt = now
  // 版本只在換了的時候寫進資料庫（每個對話開始時送一次）
  if (b.version !== undefined && b.version !== mem.version) {
    mem.version = b.version
    isDirty = true
  }
  if (b.avatar !== undefined && b.avatar !== mem.avatar) {
    mem.avatar = b.avatar
    isDirty = true
  }
  // 暫停中，沒帶 paused: false 的動態一律不收（別的對話還沒讀到暫停就送來的動態），並把殘留的清掉
  if (isPaused || hasActivity) {
    const action = hasActivity && !isPaused ? b.action : ''
    const subject = hasActivity && !isPaused ? b.subject : ''
    if (action !== mem.action || subject !== mem.subject) {
      mem.action = action
      mem.subject = subject
      mem.activityAt = action ? now : 0
      isDirty = true
    }
  }
  // 順便回好友列表：pane 開著的對話一次請求做兩件事（relay/COST.md）
  // 0.6.0：回應帶「自己」的暫停狀態（paused、pauseSeq；只有 /status 的回應、只給本人，好友列表不帶），
  // 外掛看了才知道中繼有沒有忽略它送的序號——「繼續」要中繼確認過才算送達
  return [200, { ok: true, ...friendsView(g, meId, now), paused: mem.paused === true, pauseSeq: mem.pauseSeq ?? 0 }, isDirty]
}

// CHAT-2：中繼只驗證、暫存 CHAT-1 v2 密文信封，不解密。裝置公鑰由已通過 member bearer auth 的本人註冊。
export const CHAT_TTL_MS = 60 * 60_000
export const CHAT_MAX_MESSAGES = 50
// A7：每位寄件人在同一個信箱最多同時放這麼多則（＝總量 ÷ 群組上限 5，每個人都送滿也剛好裝得下，一個人灌不滿）。DM 信箱只有兩個人
export const CHAT_SENDER_MAX = 10
export const DM_MAX_MESSAGES = 50
export const DM_SENDER_MAX = 25
export const CHAT_MAX_DEVICES = 5
// 32-byte commitment opening + up to 2,000 UTF-8 text bytes + 16-byte Poly1305 tag
export const CHAT_MAX_CIPHERTEXT_BYTES = 2_048
const CHAT_MIN_CIPHERTEXT_BYTES = 49
const CHAT_TOKEN_RE = /^[A-Za-z0-9_-]{1,100}$/
const CHAT_MESSAGE_ID_RE = /^[A-Za-z0-9_-]{22}$/
const CHAT_NONCE_RE = /^[A-Za-z0-9_-]{32}$/
const CHAT_PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/
const CHAT_SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/
const CHAT_COMMIT_RE = /^[A-Za-z0-9_-]{43}$/
const chatEncoder = new TextEncoder()

const chatToken = value => typeof value === 'string' && CHAT_TOKEN_RE.test(value)
const chatPlain = (value, keys) => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null
    const own = Reflect.ownKeys(value)
    if (own.length !== keys.length || own.some(key => typeof key !== 'string') || keys.some(key => !own.includes(key))) return null
    const copy = {}
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) return null
      copy[key] = descriptor.value
    }
    return Object.freeze(copy)
  } catch { return null }
}

const chatB64 = (value, bytes) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4))
    const decoded = Uint8Array.from(binary, character => character.charCodeAt(0))
    if (decoded.length !== bytes) return null
    let raw = ''
    for (const byte of decoded) raw += String.fromCharCode(byte)
    return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === value ? decoded : null
  } catch { return null }
}

const CHAT_ENVELOPE_KEYS = ['ciphertext', 'commit', 'deviceId', 'epoch', 'groupId', 'messageId', 'nonce', 'senderId', 'sentAt', 'signature', 'version']
// 中繼收的信封版本（也是 GET /capability 的 chat.wire）：只有 2
export const CHAT_WIRE_VERSIONS = Object.freeze([2])

const chatEnvelope = value => {
  const raw = chatPlain(value, CHAT_ENVELOPE_KEYS)
  if (!raw || !CHAT_WIRE_VERSIONS.includes(raw.version) || !chatToken(raw.groupId) || !chatToken(raw.senderId)
    || !chatToken(raw.deviceId) || !CHAT_MESSAGE_ID_RE.test(raw.messageId ?? '') || !chatB64(raw.messageId, 16)
    || !Number.isSafeInteger(raw.sentAt) || raw.sentAt <= 0 || !Number.isSafeInteger(raw.epoch) || raw.epoch < 0 || Object.is(raw.epoch, -0)
    || !CHAT_NONCE_RE.test(raw.nonce ?? '') || !chatB64(raw.nonce, 24)
    || !CHAT_COMMIT_RE.test(raw.commit ?? '') || !chatB64(raw.commit, 32)
    || typeof raw.ciphertext !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw.ciphertext)
    || !CHAT_SIGNATURE_RE.test(raw.signature ?? '') || !chatB64(raw.signature, 64)) return null
  const ciphertextBytes = chatB64(raw.ciphertext, Math.floor(raw.ciphertext.length * 3 / 4))
  if (!ciphertextBytes || ciphertextBytes.length < CHAT_MIN_CIPHERTEXT_BYTES || ciphertextBytes.length > CHAT_MAX_CIPHERTEXT_BYTES) return null
  return Object.freeze({ version: raw.version, groupId: raw.groupId, senderId: raw.senderId, deviceId: raw.deviceId,
    messageId: raw.messageId, sentAt: raw.sentAt, epoch: raw.epoch, nonce: raw.nonce, commit: raw.commit,
    ciphertext: raw.ciphertext, signature: raw.signature })
}

export const chatSignatureBytes = envelope => chatEncoder.encode(JSON.stringify([
  'friends-chat/signature/v2', envelope.version, envelope.groupId, envelope.senderId, envelope.deviceId,
  envelope.messageId, envelope.sentAt, envelope.epoch, envelope.nonce, envelope.commit, envelope.ciphertext,
]))

export const newChatMailbox = () => ({ nextSequence: 1, messages: [] })

export function registerChatDevice(mem, body) {
  const raw = chatPlain(body, ['deviceId', 'publicKey'])
  if (!raw || !chatToken(raw.deviceId) || !CHAT_PUBLIC_KEY_RE.test(raw.publicKey ?? '') || !chatB64(raw.publicKey, 32)) {
    return [400, { error: '聊天裝置格式不對', reason: 'invalid' }, false]
  }
  // 成員放了裝置清單之後，只能登記清單裡有、而且簽章公鑰跟清單一致的裝置（撤銷在中繼端也生效）
  if (mem.roster?.list && !mem.roster.list.devices.some(d => d.deviceId === raw.deviceId && d.signKey === raw.publicKey)) return [403, { error: '裝置不在你的裝置清單裡', reason: 'forbidden' }, false]
  const devices = (mem.chatDevices ??= {})
  if (!Object.hasOwn(devices, raw.deviceId) && Object.keys(devices).length >= CHAT_MAX_DEVICES) return [403, { error: '聊天裝置已滿', reason: 'forbidden' }, false]
  if (devices[raw.deviceId] === raw.publicKey) return [200, { ok: true }, false]
  if (Object.hasOwn(devices, raw.deviceId)) return [409, { error: '聊天裝置已登記', reason: 'conflict' }, false]
  devices[raw.deviceId] = raw.publicKey
  return [200, { ok: true }, true]
}

export function expireChatMailbox(mailbox, now) {
  const before = mailbox.messages.length
  mailbox.messages = mailbox.messages.filter(message => Number.isSafeInteger(message.expiresAt) && message.expiresAt > now)
  return mailbox.messages.length !== before
}

export const nextChatExpiry = mailbox => mailbox.messages.length ? Math.min(...mailbox.messages.map(message => message.expiresAt)) : null

export async function publishChatEnvelope(groupId, meId, mem, body, mailbox, now, ttl = CHAT_TTL_MS, maximum = CHAT_MAX_MESSAGES, perSender = CHAT_SENDER_MAX) {
  const request = chatPlain(body, ['envelope'])
  const envelope = request && chatEnvelope(request.envelope)
  if (!envelope) return [400, { error: '聊天信封格式不對', reason: 'invalid' }, false]
  if (envelope.groupId !== groupId || envelope.senderId !== meId) return [403, { error: '聊天信封信任資料不對', reason: 'forbidden' }, false]
  const publicKey = mem.chatDevices && Object.hasOwn(mem.chatDevices, envelope.deviceId) ? mem.chatDevices[envelope.deviceId] : ''
  const publicKeyBytes = chatB64(publicKey, 32)
  if (!publicKeyBytes) return [403, { error: '聊天裝置未登記', reason: 'forbidden' }, false]
  // 有裝置清單的成員：寄件裝置必須在清單裡、而且登記的公鑰就是清單的簽章公鑰，否則視為已撤銷
  if (mem.roster?.list && !mem.roster.list.devices.some(d => d.deviceId === envelope.deviceId && d.signKey === publicKey)) {
    return [403, { error: '這台裝置已不在裝置清單裡', reason: 'device-revoked' }, false]
  }
  if (envelope.sentAt <= now - ttl || envelope.sentAt > now + 60_000) return [400, { error: '聊天信封時間不對', reason: 'invalid' }, false]
  let verified
  try { verified = nobleEd25519Verify(chatB64(envelope.signature, 64), chatSignatureBytes(envelope), publicKeyBytes) }
  catch { return [403, { error: '聊天簽章不對', reason: 'forbidden' }, false] }
  if (verified !== true) return [403, { error: '聊天簽章不對', reason: 'forbidden' }, false]
  const expired = expireChatMailbox(mailbox, now)
  if (mailbox.messages.some(message => message.envelope.messageId === envelope.messageId
    || (message.envelope.epoch === envelope.epoch && message.envelope.nonce === envelope.nonce))) {
    return [409, { error: '聊天信封重複', reason: 'duplicate' }, expired]
  }
  // A7：這位寄件人自己的未過期訊息已達上限 → 429（比「信箱滿」先判斷：灌信箱的人拿到的是自己的上限，別人看到的才是滿）
  const senderCap = Number.isSafeInteger(perSender) && perSender >= 1 ? perSender : CHAT_SENDER_MAX // 設定壞掉時用預設，不能變成沒有上限
  if (mailbox.messages.filter(message => message.envelope.senderId === meId).length >= senderCap) {
    return [429, { error: '你送得太快了，請稍後再送', reason: 'sender-limit' }, expired]
  }
  if (!Number.isSafeInteger(maximum) || maximum < 1 || mailbox.messages.length >= maximum) return [503, { error: '聊天信箱已滿', reason: 'mailbox-full' }, expired]
  if (!Number.isSafeInteger(ttl) || ttl < 1 || now > Number.MAX_SAFE_INTEGER - ttl) return [503, { error: '聊天信箱暫時不能寫入', reason: 'mailbox-unwritable' }, expired]
  const sequence = Number.isSafeInteger(mailbox.nextSequence) && mailbox.nextSequence > 0 ? mailbox.nextSequence : 1
  if (sequence >= Number.MAX_SAFE_INTEGER) return [503, { error: '聊天信箱暫時不能寫入', reason: 'mailbox-unwritable' }, expired]
  const expiresAt = now + ttl
  mailbox.nextSequence = sequence + 1
  mailbox.messages.push(Object.freeze({ sequence, expiresAt, envelope }))
  return [200, { ok: true, sequence, expiresAt }, true]
}

export function pollChatMailbox(body, mailbox, now) {
  const request = chatPlain(body, ['after'])
  if (!request || !Number.isSafeInteger(request.after) || request.after < 0 || Object.is(request.after, -0)) {
    return [400, { error: '聊天游標格式不對', reason: 'invalid' }, false]
  }
  const dirty = expireChatMailbox(mailbox, now)
  return [200, { messages: mailbox.messages.filter(message => message.sequence > request.after) }, dirty]
}

export function clearChatForMember(mailbox, memberId) {
  const before = mailbox.messages.length
  mailbox.messages = mailbox.messages.filter(message => message.envelope.senderId !== memberId)
  return mailbox.messages.length !== before
}

// ── CHAT3-RELAY：群組內的私訊（DM）信箱 ──
// 「好友」＝同一個群組裡、彼此都按過同意的兩位成員。連結資料放在群組資料 g.dm.links（隨群組一起存、一起還原）：
//   links[code] = { a, b, state: 'pending'|'active', requester, declined, blockedBy: [memberId…], createdAt }
// 信箱內容（訊息）另外放在 boxes（code → mailbox），由呼叫端（Node 資料檔／Worker 儲存）保管。
// code 是 128 位元隨機值，不由成員代號推導，只有那一對的兩個人拿得到（B5）。
export const DM_PENDING_TTL_MS = 7 * 86_400_000
export const DM_POLL_MAX_BOXES = 10
const DM_CODE_RE = /^[A-Za-z0-9_-]{22}$/
const MEMBER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const dmOf = g => {
  if (!(g.dm && typeof g.dm === 'object' && !Array.isArray(g.dm) && g.dm.links && typeof g.dm.links === 'object' && !Array.isArray(g.dm.links))) g.dm = { links: {} }
  return g.dm
}
const dmFail = (status, error, reason) => [status, { error, reason }, false, []]
const dmOk = (obj, changed = false, removed = [], touched = []) => [200, { ok: true, ...obj }, changed, removed, touched]
const linkBetween = (g, x, y) => Object.entries(dmOf(g).links).find(([, l]) => (l.a === x && l.b === y) || (l.a === y && l.b === x))
const peerOf = (l, me) => (l.a === me ? l.b : l.a)
const blockedList = l => (Array.isArray(l.blockedBy) ? l.blockedBy : [])

function dmPeer(g, meId, body) {
  const req = chatPlain(body, ['memberId'])
  if (!req || typeof req.memberId !== 'string' || !MEMBER_ID_RE.test(req.memberId) || req.memberId === meId || !Object.hasOwn(g.members, req.memberId)) return null
  return req.memberId
}

/** 清掉過期的等待中請求（7 天）；回傳有改動的連結代碼（刪掉的要連信箱一起刪；封鎖中的連結改成降級，沒有信箱） */
export function dmExpire(g, now) {
  const removed = []
  const { links } = dmOf(g)
  for (const [code, l] of Object.entries(links)) {
    if (l.state !== 'pending' || (Number.isSafeInteger(l.createdAt) && now - l.createdAt < DM_PENDING_TTL_MS && now >= l.createdAt - 60_000)) continue
    if (blockedList(l).length === 0) {
      delete links[code]
      removed.push(code)
    } else if (l.requester) {
      // 有封鎖記號的連結不能刪（不然封鎖失效），但等待中的請求跟沒被封鎖的世界一樣 7 天後消失：降成「純封鎖記號」。
      // 降級的連結沒有信箱；也放進回傳的清單（呼叫端刪不存在的信箱沒有影響），這樣「有改動」的判斷不用改（盲審必修 M-1）
      Object.assign(l, { requester: '', declined: true, createdAt: now })
      removed.push(code)
    }
  }
  return removed
}

/** 成員離開或被踢：這位成員所有的連結與信箱都刪掉 */
export function dmDropMember(g, memberId) {
  const removed = []
  const { links } = dmOf(g)
  for (const [code, l] of Object.entries(links)) {
    if (l.a === memberId || l.b === memberId) {
      delete links[code]
      removed.push(code)
    }
  }
  return removed
}

/**
 * 私訊連結的規則（盲審之後的簡化版）：封鎖**不改連結本身的資料**，只加一個 blockedBy 記號。
 *  - 封鎖的人：清單只顯示 blocked；不能請求／同意／送訊息（409「先解除封鎖」）；從這個信箱收不到任何東西。
 *  - 被封鎖的人：所有動作都照原本的連結資料進行（請求、同意、拒絕、送訊息、輪詢，回應跟沒被封鎖時一模一樣），
 *    只是封鎖的人看不到、收不到。連結資料照常被他的動作改變（例如對方封鎖前發過的請求，他同意之後連結就是 active）。
 *  - 解除封鎖：好友連結整筆刪掉（舊代碼永遠死掉，要重新請求、同意拿全新代碼）；等待中的請求原樣留著（對方的請求這時才被封鎖的人看到）。
 * 回傳 [status, body, changed, removedCodes, touchedCodes]；boxes＝這個群組的 code→mailbox（呼叫端給的工作複本，會被原地修改）。
 */
const newCode = links => {
  for (let i = 0; i < 5; i++) { const c = token(16); if (!Object.hasOwn(links, c)) return c }
  return ''
}

/** 請求成為私訊好友 */
export function dmRequest(g, meId, body, now) {
  const removed = dmExpire(g, now)
  const peer = dmPeer(g, meId, body)
  if (!peer) return [400, { error: '找不到這個人', reason: 'invalid' }, removed.length > 0, removed]
  const found = linkBetween(g, meId, peer)
  const { links } = dmOf(g)
  if (!found) {
    const code = newCode(links)
    if (!code) return dmFail(500, '請再試一次', 'unreachable')
    links[code] = { a: meId, b: peer, state: 'pending', requester: meId, declined: false, blockedBy: [], createdAt: now }
    return dmOk({ state: 'requested' }, true, removed)
  }
  const [, l] = found
  if (blockedList(l).includes(meId)) return dmFail(409, '先解除封鎖', 'stale') // 我自己封鎖了他：要先解除
  if (l.state === 'active') return dmOk({ state: 'active' }, removed.length > 0, removed)
  if (l.requester === meId) return dmOk({ state: 'requested' }, removed.length > 0, removed) // 冪等；對方拒絕過也一樣回已送出
  if (!l.requester) {
    // 只有封鎖記號、從沒有人請求過的連結：我成為請求人
    Object.assign(l, { requester: meId, declined: false, createdAt: now })
    return dmOk({ state: 'requested' }, true, removed)
  }
  // 對方早就對我發過請求：兩邊都想 → 直接成為好友
  l.state = 'active'
  l.declined = false
  return dmOk({ state: 'active' }, true, removed)
}

/** 同意對方發給我的請求 → 回信箱代碼給我 */
export function dmAccept(g, meId, body, now) {
  const removed = dmExpire(g, now)
  const peer = dmPeer(g, meId, body)
  if (!peer) return [400, { error: '找不到這個人', reason: 'invalid' }, removed.length > 0, removed]
  const found = linkBetween(g, meId, peer)
  if (!found) return [409, { error: '這個請求已經不在了', reason: 'stale' }, removed.length > 0, removed]
  const [code, l] = found
  if (blockedList(l).includes(meId)) return [409, { error: '先解除封鎖', reason: 'stale' }, removed.length > 0, removed]
  if (l.state === 'active') return dmOk({ code }, removed.length > 0, removed)
  if (l.requester !== peer) return [409, { error: '這個請求已經不在了', reason: 'stale' }, removed.length > 0, removed]
  l.state = 'active'
  l.declined = false
  return dmOk({ code }, true, removed)
}

/** 拒絕：只做記號（對方看起來永遠是「已送出」），回應一律 ok，不洩漏有沒有這筆 */
export function dmDecline(g, meId, body, now) {
  const removed = dmExpire(g, now)
  const peer = dmPeer(g, meId, body)
  if (!peer) return [400, { error: '找不到這個人', reason: 'invalid' }, removed.length > 0, removed]
  const found = linkBetween(g, meId, peer)
  let changed = removed.length > 0
  if (found && !blockedList(found[1]).includes(meId) && found[1].state === 'pending' && found[1].requester === peer && !found[1].declined) {
    found[1].declined = true
    changed = true
  }
  return dmOk({}, changed, removed)
}

/** 封鎖：只加封鎖記號，並清掉**我自己**寄在這個信箱裡的訊息（信箱本身和序號保留，被封鎖的人看到的信箱不會被重設） */
export function dmBlock(g, meId, body, now, boxes = {}) {
  const removed = dmExpire(g, now)
  const peer = dmPeer(g, meId, body)
  if (!peer) return [400, { error: '找不到這個人', reason: 'invalid' }, removed.length > 0, removed]
  const found = linkBetween(g, meId, peer)
  const { links } = dmOf(g)
  if (!found) {
    const code = newCode(links)
    if (!code) return dmFail(500, '請再試一次', 'unreachable')
    // 從沒有過來往就先封鎖：只有封鎖記號、沒有請求人的連結（對方的清單裡不顯示，他也不會知道）
    links[code] = { a: meId, b: peer, state: 'pending', requester: '', declined: true, blockedBy: [meId], createdAt: now }
    return dmOk({}, true, removed)
  }
  const [code, l] = found
  const blocked = blockedList(l)
  if (blocked.includes(meId)) return dmOk({}, removed.length > 0, removed)
  l.blockedBy = [...blocked, meId]
  const touched = Object.hasOwn(boxes, code) && clearChatForMember(boxes[code], meId) ? [code] : []
  return dmOk({}, true, removed, touched)
}

/** 解除封鎖：好友連結整筆刪掉（舊代碼永遠死掉；要再聊必須重新請求、同意，拿到全新代碼）；等待中的請求原樣留著 */
export function dmUnblock(g, meId, body, now) {
  const removed = dmExpire(g, now)
  const peer = dmPeer(g, meId, body)
  if (!peer) return [400, { error: '找不到這個人', reason: 'invalid' }, removed.length > 0, removed]
  const found = linkBetween(g, meId, peer)
  if (!found || !blockedList(found[1]).includes(meId)) return dmOk({}, removed.length > 0, removed)
  const [code, l] = found
  l.blockedBy = blockedList(l).filter(id => id !== meId)
  if (l.blockedBy.length === 0) {
    if (l.state === 'pending' && l.requester) {
      // 等待中的請求原樣留著，**不**重算期限：期限照原本的請求時間（重算會讓請求比沒被封鎖的世界活得更久，洩漏封鎖又解除過）
      return dmOk({}, true, removed)
    }
    delete dmOf(g).links[code]
    return dmOk({}, true, [...removed, code])
  }
  return dmOk({}, true, removed)
}

/** 我的連結清單：只回我自己的；第三位成員的關係一個字都不會出現。封鎖的人只看到 blocked；被封鎖的人看到的跟沒被封鎖時一樣 */
export function dmList(g, meId, now) {
  const removed = dmExpire(g, now)
  const out = []
  for (const [code, l] of Object.entries(dmOf(g).links)) {
    if (l.a !== meId && l.b !== meId) continue
    const peer = peerOf(l, meId)
    if (blockedList(l).includes(meId)) out.push({ peer, state: 'blocked' })
    else if (l.state === 'active') out.push({ peer, state: 'active', code })
    else if (l.requester === meId) out.push({ peer, state: 'requested' })
    else if (l.requester && !l.declined) out.push({ peer, state: 'incoming' })
  }
  out.sort((x, y) => (x.peer < y.peer ? -1 : x.peer > y.peer ? 1 : 0))
  return [200, { links: out }, removed.length > 0, removed]
}

/** 這個人對這個信箱代碼是什麼角色：null＝不存在或不是參與者（兩種情況呼叫端必須回一模一樣的東西） */
function boxRole(g, meId, code) {
  if (typeof code !== 'string' || !DM_CODE_RE.test(code)) return null
  const links = dmOf(g).links
  if (!Object.hasOwn(links, code)) return null
  const l = links[code]
  if (l.a !== meId && l.b !== meId) return null
  if (l.state !== 'active') return null // 還沒同意：代碼沒發出去過，當作不存在
  const blocked = blockedList(l)
  if (blocked.includes(meId)) return 'blocker'
  return blocked.length ? 'blocked' : 'friend' // 被封鎖的人照一般的信箱流程走（序號、重複、上限都一樣），只是封鎖的人不會從這個代碼收
}

/** 寄一則 DM。boxes 是這個群組的 code→mailbox（呼叫端給的工作複本）；回 [status, body, changed, touchedCode] */
export async function dmSend(g, groupId, meId, mem, body, boxes, now, ttl = CHAT_TTL_MS, maximum = DM_MAX_MESSAGES, perSender = DM_SENDER_MAX) {
  const req = chatPlain(body, ['code', 'envelope'])
  if (!req) return [400, { error: '聊天信封格式不對', reason: 'invalid' }, false, '']
  const role = boxRole(g, meId, req.code)
  const unknown = [404, { error: '找不到這個信箱', reason: 'unknown-box' }, false, '']
  if (!role) return unknown
  if (role === 'blocker') return [409, { error: '先解除封鎖', reason: 'stale' }, false, '']
  const mailbox = Object.hasOwn(boxes, req.code) ? boxes[req.code] : (boxes[req.code] = newChatMailbox())
  const [code, obj, dirty] = await publishChatEnvelope(groupId, meId, mem, { envelope: req.envelope }, mailbox, now, ttl, maximum, perSender)
  return [code, obj, dirty, req.code]
}

/** 批次輪詢（B9）。回 [status, body, touchedCodes[]]；不屬於我的代碼直接省略 */
export function dmPoll(g, meId, body, boxes, now) {
  const req = chatPlain(body, ['boxes'])
  if (!req || !Array.isArray(req.boxes) || req.boxes.length < 1 || req.boxes.length > DM_POLL_MAX_BOXES) return [400, { error: '聊天游標格式不對', reason: 'invalid' }, []]
  const wanted = []
  for (const item of req.boxes) {
    const one = chatPlain(item, ['code', 'after'])
    if (!one || typeof one.code !== 'string' || !DM_CODE_RE.test(one.code) || !Number.isSafeInteger(one.after) || one.after < 0 || Object.is(one.after, -0)) {
      return [400, { error: '聊天游標格式不對', reason: 'invalid' }, []]
    }
    wanted.push(one)
  }
  const out = {}
  const touched = []
  for (const { code, after } of wanted) {
    const role = boxRole(g, meId, code)
    if (!role || role === 'blocker') continue
    const mailbox = Object.hasOwn(boxes, code) ? boxes[code] : null
    if (!mailbox) { out[code] = { messages: [] }; continue }
    if (expireChatMailbox(mailbox, now)) touched.push(code)
    out[code] = { messages: mailbox.messages.filter(message => message.sequence > after) }
  }
  return [200, { boxes: out }, touched]
}

/** 清掉所有 DM 信箱過期的訊息，並丟掉沒有對應連結的信箱；回傳要寫回的代碼與要刪的代碼 */
export function dmExpireBoxes(g, boxes, now) {
  const touched = []
  const removed = []
  const links = dmOf(g).links
  for (const [code, mailbox] of Object.entries(boxes)) {
    if (!Object.hasOwn(links, code)) { delete boxes[code]; removed.push(code); continue }
    if (expireChatMailbox(mailbox, now)) touched.push(code)
  }
  return { touched, removed }
}

export function dmNextExpiry(boxes) {
  const times = Object.values(boxes).map(nextChatExpiry).filter(Boolean)
  return times.length ? Math.min(...times) : null
}

// ── CHAT3b-RELAY：裝置清單與 epoch 金鑰封包的傳輸（設計見 docs/drafts/chat3b-relay-design.md）──
// 中繼只收、存、轉不透明的東西：清單的簽章（身分金鑰）和封包的簽章（群主的裝置）都由用戶端驗；這裡只做格式、大小、單調性、誰能寫。
// 資料放在成員紀錄裡（mem.roster、mem.epochPackets），離開或被踢時一起消失，Worker 的快照還原照舊適用。
export const ROSTER_MAX_DEVICES = CHAT_MAX_DEVICES // CHAT-5R：裝置清單與 epoch 封包的上限跟聊天裝置上限同為 5 台（以前清單收 8 台）
export const ROSTER_MAX_JUMP = 64
export const ROSTER_ISSUED_WINDOW_MS = 3_600_000
export const EPOCH_MAX = 2_000_000_000
export const EPOCH_PACKET_MAX_CHARS = 1_400
export const EPOCH_PUT_MAX = 2 // 請求本文上限 4 KB，一次放不了更多
export const EPOCH_PACKET_TTL_MS = 8 * 86_400_000
const ROSTER_SIG_RE = /^[A-Za-z0-9_-]{86}$/
const PACKET_RE = /^[A-Za-z0-9_-]+$/
const rosterFail = (status, error, reason) => [status, { error, reason }, false]

/** 檢查並正規化一份裝置清單（V1 或 V2＝多簽章內的 issuedAt）；不合格回 null。不驗簽名 */
function normalizeRoster(list, meId, now) {
  const version = list && typeof list === 'object' ? list.version : undefined
  if (version !== 1 && version !== 2) return null
  const base = ['devices', 'listVersion', 'signature', 'userId', 'version']
  const L = chatPlain(list, version === 2 ? [...base, 'issuedAt'] : base)
  if (!L || L.userId !== meId) return null
  if (!Number.isSafeInteger(L.listVersion) || L.listVersion < 1 || L.listVersion > 2_147_483_647) return null
  if (typeof L.signature !== 'string' || !ROSTER_SIG_RE.test(L.signature) || !chatB64(L.signature, 64)) return null
  if (version === 2 && (!Number.isSafeInteger(L.issuedAt) || Math.abs(L.issuedAt - now) > ROSTER_ISSUED_WINDOW_MS)) return null
  if (!Array.isArray(L.devices) || L.devices.length < 1 || L.devices.length > ROSTER_MAX_DEVICES) return null
  const devices = []
  for (const item of L.devices) {
    const d = chatPlain(item, ['deviceId', 'encKey', 'signKey'])
    if (!d || !CHAT_TOKEN_RE.test(d.deviceId ?? '') || d.deviceId === '__proto__' || !CHAT_PUBLIC_KEY_RE.test(d.signKey ?? '') || !CHAT_PUBLIC_KEY_RE.test(d.encKey ?? '')
      || !chatB64(d.signKey, 32) || !chatB64(d.encKey, 32)) return null
    // 按 deviceId 嚴格遞增（排序且不重複）
    if (devices.length && !(devices[devices.length - 1].deviceId < d.deviceId)) return null
    devices.push({ deviceId: d.deviceId, signKey: d.signKey, encKey: d.encKey })
  }
  const out = { version, userId: L.userId, listVersion: L.listVersion, devices, signature: L.signature }
  if (version === 2) out.issuedAt = L.issuedAt
  return out
}

/** 放自己的裝置清單。回 [status, body, changed] */
export function putRoster(g, meId, mem, body, now) {
  const req = chatPlain(body, ['list'])
  const list = req && normalizeRoster(req.list, meId, now)
  if (!list) return rosterFail(400, '裝置清單格式不對', 'invalid')
  const stored = mem.roster?.list
  // 版本一次最多往上跳 ROSTER_MAX_JUMP：中繼不驗簽名，拿到成員金鑰的人不能靠放一份天文數字版本把這位成員的清單永遠凍死（盲審建議）
  if (list.listVersion > (stored ? stored.listVersion : 0) + ROSTER_MAX_JUMP) return rosterFail(400, '裝置清單格式不對', 'invalid')
  // 已經放過 V2（有簽章內的 issuedAt）就不收 V1，不然有人可以拿舊格式蓋掉有新鮮度的清單
  if (stored && stored.version === 2 && list.version === 1) return rosterFail(409, '清單版本比已存的舊', 'rollback')
  const same = stored && JSON.stringify(stored) === JSON.stringify(list)
  if (stored && stored.listVersion > list.listVersion) return rosterFail(409, '清單版本比已存的舊', 'rollback')
  if (stored && stored.listVersion === list.listVersion) {
    return same ? [200, { ok: true, listVersion: list.listVersion, serverTime: now }, false] : rosterFail(409, '同一個版本有兩份不同的清單', 'conflict')
  }
  mem.roster = { list, storedAt: now }
  // 撤銷在中繼端也立刻生效：不在新清單裡、或登記的公鑰跟清單的簽章公鑰對不上的裝置，登記刪掉
  const listed = new Map(list.devices.map(d => [d.deviceId, d.signKey]))
  if (mem.chatDevices) for (const [id, key] of Object.entries(mem.chatDevices)) if (listed.get(id) !== key) delete mem.chatDevices[id]
  // 不在新清單裡的裝置，寄給它的換鑰封包也清掉（不然舊裝置佔著名額，新裝置收不到金鑰）
  if (mem.epochPackets) {
    for (const id of Object.keys(mem.epochPackets)) if (!listed.has(id)) delete mem.epochPackets[id]
    if (!Object.keys(mem.epochPackets).length) delete mem.epochPackets
  }
  const body2 = { ok: true, listVersion: list.listVersion, serverTime: now }
  if (list.version === 1) body2.warning = 'v1-no-issuedAt'
  return [200, body2, true]
}

/** 群組裡所有成員放過的清單（公開資訊，任何成員都能讀）。storedAt 是中繼收下的時間——中繼的話，不是簽章 */
export function getRosters(g, now) {
  const rosters = []
  for (const [memberId, m] of Object.entries(g.members)) if (m.roster?.list) rosters.push({ memberId, list: m.roster.list, storedAt: m.roster.storedAt })
  return [200, { rosters, serverTime: now }, false]
}

/** 清掉超過保存期限的 epoch 封包；回傳有沒有清 */
export function expireEpochPackets(g, now) {
  let changed = false
  for (const m of Object.values(g.members)) {
    if (!m.epochPackets) continue
    for (const [deviceId, p] of Object.entries(m.epochPackets)) {
      if (!(Number.isSafeInteger(p?.at) && now - p.at < EPOCH_PACKET_TTL_MS)) { delete m.epochPackets[deviceId]; changed = true }
    }
    if (!Object.keys(m.epochPackets).length) delete m.epochPackets
  }
  return changed
}

/** 群主放 epoch 金鑰封包（每台目標裝置一份，不透明）。回 [status, body, changed] */
export function putEpochPackets(g, meId, body, now) {
  if (meId !== g.ownerId || !Object.hasOwn(g.members, meId)) return rosterFail(403, '只有群主能放換鑰封包', 'not-owner')
  const expired = expireEpochPackets(g, now) // 先清過期的，不然過期的封包還佔名額、還擋住較低的 epoch
  const req = chatPlain(body, ['packets'])
  if (!req || !Array.isArray(req.packets) || req.packets.length < 1 || req.packets.length > EPOCH_PUT_MAX) return rosterFail(400, '換鑰封包格式不對', 'invalid')
  const items = []
  for (const raw of req.packets) {
    const p = chatPlain(raw, ['epoch', 'packet', 'toDevice', 'toMember'])
    if (!p || typeof p.toMember !== 'string' || !Object.hasOwn(g.members, p.toMember) || !CHAT_TOKEN_RE.test(p.toDevice ?? '') || p.toDevice === '__proto__'
      || !Number.isSafeInteger(p.epoch) || p.epoch < 0 || p.epoch > EPOCH_MAX || Object.is(p.epoch, -0)
      || typeof p.packet !== 'string' || p.packet.length < 1 || p.packet.length > EPOCH_PACKET_MAX_CHARS || !PACKET_RE.test(p.packet)) {
      return rosterFail(400, '換鑰封包格式不對', 'invalid')
    }
    items.push(p)
  }
  // 先全部檢查完再寫（任何一筆不合格＝整個請求不動）；每位成員最多 5 台（ROSTER_MAX_DEVICES）裝置的封包，防止拿亂編的裝置代號灌爆
  const added = new Map() // 這個請求會新增的（成員，裝置）：要合起來算，不能一筆一筆各自檢查
  for (const p of items) {
    const box = g.members[p.toMember].epochPackets ?? {}
    if (!Object.hasOwn(box, p.toDevice)) added.set(p.toMember, new Set([...(added.get(p.toMember) ?? []), p.toDevice]))
  }
  for (const [memberId, devices] of added) {
    if (Object.keys(g.members[memberId].epochPackets ?? {}).length + devices.size > ROSTER_MAX_DEVICES) return rosterFail(400, '換鑰封包格式不對', 'invalid')
  }
  let stored = 0
  for (const p of items) {
    const m = g.members[p.toMember]
    const box = (m.epochPackets ??= {})
    const old = Object.hasOwn(box, p.toDevice) ? box[p.toDevice] : null
    if (old && old.epoch > p.epoch) continue // 較低的 epoch 不蓋掉較高的
    box[p.toDevice] = { epoch: p.epoch, packet: p.packet, at: now }
    stored += 1
  }
  return [200, { ok: true, stored }, stored > 0 || expired]
}

/** 取寄給自己的 epoch 封包（只回自己的；after 給了只回 epoch 更大的）。回 [status, body, changed] */
export function getEpochPackets(g, meId, mem, body, now) {
  const changed = expireEpochPackets(g, now)
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null
  if (!keys || keys.some(k => k !== 'after') || (Object.hasOwn(body, 'after') && !(Number.isSafeInteger(body.after) && body.after >= 0 && body.after <= EPOCH_MAX))) {
    return [400, { error: '換鑰封包格式不對', reason: 'invalid' }, changed]
  }
  const after = Object.hasOwn(body, 'after') ? body.after : -1
  const own = g.members[meId]?.epochPackets ?? {}
  const packets = Object.entries(own).filter(([, p]) => p.epoch > after).map(([toDevice, p]) => ({ toDevice, epoch: p.epoch, packet: p.packet, at: p.at }))
    .sort((x, y) => (x.toDevice < y.toDevice ? -1 : x.toDevice > y.toDevice ? 1 : 0))
  void mem
  return [200, { packets, serverTime: now }, changed]
}

// ── CHAT-6：加入證明與群主簽的成員身分清單（設計：docs/drafts/chat6-trust-design.md §3A、§6）──
// 中繼只存、只轉送，不驗也不解：加入證明是用中繼拿不到的邀請秘密算的 HMAC，成員清單是群主身分金鑰簽的；外掛不信中繼說的任何一個字。
// 加入證明放在成員紀錄裡（離開或被踢就跟著消失）；成員清單放在群組資料裡（只有一份，群主才能放）。
export const MEMBER_LIST_MAX_CHARS = 3_000
export const MEMBER_LIST_MAX_JUMP = 64

/** 成員放自己的加入證明 { proof: { n, identityKey, mac } }（群主不用）。同一位成員再放一次就換掉舊的。回 [status, body, changed] */
export function putJoinProof(g, meId, mem, body, now) {
  const req = chatPlain(body, ['proof'])
  const p = req && chatPlain(req.proof, ['identityKey', 'mac', 'n'])
  if (!p || !chatB64(p.n, 16) || !chatB64(p.identityKey, 32) || !chatB64(p.mac, 32)) return rosterFail(400, '加入證明格式不對', 'invalid')
  if (meId === g.ownerId) return rosterFail(403, '群主不需要加入證明', 'owner')
  const old = mem.joinProof
  if (old && old.n === p.n && old.identityKey === p.identityKey && old.mac === p.mac) return [200, { ok: true }, false]
  mem.joinProof = { n: p.n, identityKey: p.identityKey, mac: p.mac, at: now }
  return [200, { ok: true }, true]
}

/** 群主讀所有成員的加入證明。回 [status, body, changed] */
export function getJoinProofs(g, meId) {
  if (meId !== g.ownerId || !Object.hasOwn(g.members, meId)) return rosterFail(403, '只有群主能讀加入證明', 'not-owner')
  const proofs = []
  for (const [memberId, m] of Object.entries(g.members)) {
    if (m.joinProof) proofs.push({ memberId, proof: { n: m.joinProof.n, identityKey: m.joinProof.identityKey, mac: m.joinProof.mac } })
  }
  return [200, { proofs }, false]
}

/** 群主放成員身分清單 { list }。只看形狀與版本（不驗簽章：中繼不知道也不需要知道群主的身分金鑰）。回 [status, body, changed] */
export function putMemberList(g, meId, body, now) {
  if (meId !== g.ownerId || !Object.hasOwn(g.members, meId)) return rosterFail(403, '只有群主能放成員清單', 'not-owner')
  const req = chatPlain(body, ['list'])
  const list = req && req.list
  let text = ''
  try { text = JSON.stringify(list) } catch { text = '' }
  if (!list || typeof list !== 'object' || Array.isArray(list) || Object.getPrototypeOf(list) !== Object.prototype || !text || text.length > MEMBER_LIST_MAX_CHARS
    || list.version !== 1 || !Number.isSafeInteger(list.listVersion) || list.listVersion < 1 || list.listVersion > 2_147_483_647) return rosterFail(400, '成員清單格式不對', 'invalid')
  const stored = g.chatMembers?.list
  const before = stored ? stored.listVersion : 0
  if (list.listVersion > before + MEMBER_LIST_MAX_JUMP) return rosterFail(400, '成員清單格式不對', 'invalid')
  if (stored && list.listVersion < before) return rosterFail(409, '清單版本比已存的舊', 'rollback')
  if (stored && list.listVersion === before) {
    return JSON.stringify(stored) === text ? [200, { ok: true }, false] : rosterFail(409, '同一個版本有兩份不同的清單', 'conflict')
  }
  g.chatMembers = { list: JSON.parse(text), at: now }
  return [200, { ok: true }, true]
}

/** 任何成員讀成員身分清單（沒有就是 null）。回 [status, body, changed] */
export function getMemberList(g, now) {
  return [200, { list: g.chatMembers?.list ?? null, serverTime: now }, false]
}

// ── CHAT-5R：GET /capability 與聊天總開關（設計：docs/drafts/chat5-gate-design.md）──
// 聊天路由存檔失敗（已還原）：500 加 reason，外掛看 reason 判斷能不能重試。Node 與 Worker 共用這一份（features 的 save-500 就看它）
export const CHAT_SAVE_FAILED = Object.freeze([500, Object.freeze({ error: '存檔暫時失敗，請稍後再試', reason: 'unreachable' })])
export const CAPABILITY_TTL_SEC = 600
/** 總開關：環境變數 FRIENDS_CHAT_ENABLED 只有 '1' 才開，其他值（沒設、'true'、' 1'…）一律關 */
export const chatEnabledOf = value => value === '1'
/** 聊天與私訊的路徑（關閉時整批拒收）；用前綴判斷，新增路由不會漏掉 */
export const isChatPath = path => typeof path === 'string' && (path.startsWith('/chat/') || path.startsWith('/dm/'))
export const chatDisabledReply = () => [403, { error: '聊天功能目前關閉', reason: 'chat-disabled' }]

/** features 是從「實際存在的東西」組出來的，不是寫死的字串清單：拿掉那個東西，代號就跟著消失（測試用 parts 參數換掉零件驗證） */
export const chatParts = Object.freeze({
  envelopeKeys: CHAT_ENVELOPE_KEYS,
  wire: CHAT_WIRE_VERSIONS,
  maxCiphertextBytes: CHAT_MAX_CIPHERTEXT_BYTES,
  senderMax: CHAT_SENDER_MAX,
  dmSenderMax: DM_SENDER_MAX,
  saveFailed: CHAT_SAVE_FAILED,
  mailbox: Object.freeze([registerChatDevice, publishChatEnvelope, pollChatMailbox]),
  dmPairs: Object.freeze([dmRequest, dmAccept, dmDecline, dmBlock, dmUnblock, dmList, dmSend, dmPoll]),
  memberList: Object.freeze([putJoinProof, getJoinProofs, putMemberList, getMemberList]),
})

export function chatFeatures(parts = chatParts) {
  const functions = list => Array.isArray(list) && list.length > 0 && list.every(f => typeof f === 'function')
  const limit = n => Number.isSafeInteger(n) && n >= 1
  const out = []
  if (functions(parts.mailbox)) out.push('mailbox') // CHAT-2：裝置登記、發信、輪詢
  if (Array.isArray(parts.envelopeKeys) && parts.envelopeKeys.includes('commit')) out.push('commit') // A4：信封有承諾值欄位
  if (limit(parts.senderMax) && limit(parts.dmSenderMax)) out.push('sender-limit') // A7：429 sender-limit
  if (functions(parts.dmPairs)) out.push('dm-pairs') // B4／B5：成對私訊信箱
  if (Array.isArray(parts.saveFailed) && parts.saveFailed[0] === 500 && parts.saveFailed[1]?.reason === 'unreachable') out.push('save-500')
  if (functions(parts.memberList)) out.push('member-list') // CHAT-6：加入證明與群主簽的成員清單
  return out
}

/** GET /capability 的回應本文（Node 與 Worker 同一個函式；位元組相同）。沒有群組資料，不需要 Bearer */
export function capabilityBody(enabled, parts = chatParts) {
  return {
    v: 1,
    chat: { enabled: enabled === true, wire: [...parts.wire], maxCiphertextBytes: parts.maxCiphertextBytes, features: chatFeatures(parts) },
    ttlSec: CAPABILITY_TTL_SEC,
  }
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

// 新的邀請世代（同步）：先檢查會不會溢位再改，改了就清掉等待中的人（用舊邀請碼提出的要求跟著作廢）。回 false＝沒改
const canAdvance = g => !((Number.isSafeInteger(g.inviteGeneration) ? g.inviteGeneration : 0) >= Number.MAX_SAFE_INTEGER)
function advanceInvite(g, inviteHash) {
  g.inviteHash = inviteHash
  g.inviteGeneration = (Number.isSafeInteger(g.inviteGeneration) ? g.inviteGeneration : 0) + 1
  g.pending = {}
}

/**
 * 換邀請碼（只有建立者）；回 [code, obj, changed, before]。
 * sha 會讓出控制權：雜湊先算好，之後「檢查建立者→改世代」之間不能有 await，並行請求才不會拿到同一個數字或過期的身分判斷。
 * before＝改之前的快照（structuredClone），寫入失敗時交給 restoreGroup
 */
export async function rotateInvite(g, groupId, meId) {
  const invite = newInvite(groupId)
  const inviteHash = await sha(invite)
  if (meId !== g.ownerId || !Object.hasOwn(g.members, meId)) return [403, { error: '只有建立者能換邀請碼' }, false]
  if (!canAdvance(g)) return [409, { error: '邀請碼世代已用完' }, false]
  const before = structuredClone(g)
  advanceInvite(g, inviteHash)
  return [200, { invite, inviteGeneration: g.inviteGeneration }, true, before]
}

/** 踢人（只有建立者）；踢完自動換邀請碼；回 [code, obj, changed, before] */
export async function kick(g, groupId, meId, b) {
  const invite = newInvite(groupId)
  const inviteHash = await sha(invite)
  if (meId !== g.ownerId || !Object.hasOwn(g.members, meId)) return [403, { error: '只有建立者能踢人' }, false]
  if (typeof b.memberId !== 'string' || b.memberId === meId) return [400, { error: '要給別人的成員 id' }, false]
  // 0.5.6：找不到這個人回 404（不是 400）。用戶端重試一次已經成功的踢人時會走到這裡：404＝「他已經不在群組」，
  // 400 則是請求本身有問題，兩者不能混在一起（以前混在 400，重試會被誤報成「沒移除」）
  if (!Object.hasOwn(g.members, b.memberId)) return [404, { error: '找不到這個人' }, false]
  if (!canAdvance(g)) return [409, { error: '邀請碼世代已用完' }, false]
  const before = structuredClone(g)
  delete g.members[b.memberId]
  advanceInvite(g, inviteHash)
  return [200, { ok: true, invite, inviteGeneration: g.inviteGeneration }, true, before]
}

/** 改名輸入先完整驗證；固定錯誤不回顯欄位或名字。 */
export function renameInputError(b) {
  if (Object.keys(b).some(k => k !== 'name')) return [400, { error: '不收的欄位' }]
  if (!isValidNameInput(b.name, MAX_NAME)) return [400, { error: '名字格式不對' }]
  return null
}

/** 只能改 authorization 對應的自己；同名沿用 join 政策（允許）。 */
export function rename(mem, b, now = Date.now()) {
  const invalid = renameInputError(b)
  if (invalid) return invalid
  const last = Number.isFinite(mem.renamedAt) ? mem.renamedAt : undefined
  if (last !== undefined && now >= last && now - last < RENAME_COOLDOWN_MS) return [429, { error: '改名太頻繁' }]
  // 所有檢查（包含限速）都先完成，才動成員資料。
  mem.name = b.name.trim()
  mem.renamedAt = now
  return [200, { ok: true }]
}

// ── 群主設定（SEC064）：POST /owner/act，本文就是面板的 OwnerActionRequest ──
const OWNER_REQUEST_KEYS = {
  rename: ['name'], 'set-avatar': ['avatar'], 'set-who-invites': ['value'], 'set-approval': ['value'], 'set-max-members': ['value'],
  approve: ['requestId'], reject: ['requestId'], 'rotate-invite': [], 'revoke-invites': [], 'transfer-owner': ['memberId'],
}
export const OWNER_FAILURES = {
  'not-owner': [403, '只有建立者能這樣做'],
  invalid: [400, '要求的格式或值不對'],
  limit: [400, '超過可以設定的範圍'],
  stale: [409, '這個要求已經過期或對象不存在'],
  unreachable: [500, '儲存暫時不可用，沒有任何改動'],
}
export const ownerFailure = reason => [OWNER_FAILURES[reason][0], { error: OWNER_FAILURES[reason][1], reason }, false]
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * 群主動作。回 [code, obj, changed, before]；changed＝要寫回資料庫（before 是快照，寫入失敗時 restoreGroup）。
 * 授權在前（不是建立者一律 not-owner，不管本文對不對）；會 await 的雜湊都在最前面算完，之後到修改之前是同步的
 */
export async function ownerAct(g, groupId, meId, b, now) {
  const type = typeof b?.type === 'string' && Object.hasOwn(OWNER_REQUEST_KEYS, b.type) ? b.type : ''
  const fresh = type === 'rotate-invite' || type === 'set-who-invites' ? newInvite(groupId) : ''
  const freshHash = fresh ? await sha(fresh) : ''
  // ── 以下沒有 await ──
  if (meId !== g.ownerId || !Object.hasOwn(g.members, meId)) return ownerFailure('not-owner')
  const keys = Object.keys(b ?? {})
  if (!type || keys.length !== OWNER_REQUEST_KEYS[type].length + 1 || !OWNER_REQUEST_KEYS[type].every(k => Object.hasOwn(b, k))) return ownerFailure('invalid')
  const before = structuredClone(g)
  const done = (obj = {}) => [200, { ok: true, ...obj }, true, before]
  switch (type) {
    case 'rename': {
      if (typeof b.name !== 'string' || !b.name || clean(b.name, 30) !== b.name) return ownerFailure('invalid')
      g.name = b.name
      return done()
    }
    case 'set-avatar': {
      if (!isAvatar(b.avatar)) return ownerFailure('invalid')
      g.avatar = b.avatar
      return done()
    }
    case 'set-who-invites': {
      if (!WHO_CAN_INVITE.includes(b.value)) return ownerFailure('invalid')
      if (b.value === whoCanInviteOf(g)) return [200, { ok: true }, false]
      // 改成「只有建立者」＝成員手上的邀請碼不能再用：換新碼（只回給建立者）
      if (b.value === 'owner') {
        if (!canAdvance(g)) return ownerFailure('stale')
        g.whoCanInvite = 'owner'
        advanceInvite(g, freshHash)
        return done({ invite: fresh, inviteGeneration: g.inviteGeneration })
      }
      g.whoCanInvite = 'members'
      return done()
    }
    case 'set-approval': {
      if (typeof b.value !== 'boolean') return ownerFailure('invalid')
      if (b.value === needsApprovalOf(g)) return [200, { ok: true }, false]
      g.needsApproval = b.value
      if (!b.value) g.pending = {}
      return done()
    }
    case 'set-max-members': {
      if (typeof b.value !== 'number' || !Number.isInteger(b.value)) return ownerFailure('invalid')
      if (b.value < OWNER_CAP_MIN || b.value > OWNER_CAP_MAX || b.value < Object.keys(g.members).length) return ownerFailure('limit')
      g.maxMembers = b.value
      return done()
    }
    case 'approve':
    case 'reject': {
      const pending = pendingOf(g)
      if (typeof b.requestId !== 'string' || !REQUEST_ID_RE.test(b.requestId)) return ownerFailure('invalid')
      expirePending(g, now) // 過期的不能同意
      if (!Object.hasOwn(pending, b.requestId)) return ownerFailure('stale')
      if (type === 'approve') {
        if (Object.keys(g.members).length >= capOf(g)) return ownerFailure('limit')
        const p = pending[b.requestId]
        g.members[b.requestId] = { name: p.name, keyHash: p.keyHash, conns: {}, action: '', subject: '', activityAt: 0, seenAt: now, ver: p.ver ?? '' }
      }
      delete pending[b.requestId]
      return done()
    }
    case 'rotate-invite': {
      if (!canAdvance(g)) return ownerFailure('stale')
      advanceInvite(g, freshHash)
      return done({ invite: fresh, inviteGeneration: g.inviteGeneration })
    }
    case 'revoke-invites': {
      if (!canAdvance(g)) return ownerFailure('stale')
      advanceInvite(g, '')
      return done({ inviteGeneration: g.inviteGeneration })
    }
    case 'transfer-owner': {
      if (typeof b.memberId !== 'string' || !REQUEST_ID_RE.test(b.memberId)) return ownerFailure('invalid')
      if (b.memberId === meId || !Object.hasOwn(g.members, b.memberId) || !canAdvance(g)) return ownerFailure('stale')
      // 舊建立者手上的邀請碼不能再用：撤銷全部邀請，新建立者要用再換
      g.ownerId = b.memberId
      advanceInvite(g, '')
      return done({ inviteGeneration: g.inviteGeneration })
    }
  }
  return ownerFailure('invalid')
}

/** 離開；回 isEmpty＝群組空了要整組刪 */
export function leave(g, meId) {
  delete g.members[meId]
  const ids = Object.keys(g.members)
  if (ids.length > 0 && meId === g.ownerId) {
    // 建立者離開＝換人接任（跟轉讓一樣）：撤銷全部邀請、清掉等待中的人，新建立者沒討論過的要求不能留給他
    g.ownerId = ids[0]
    g.inviteHash = ''
    g.pending = {}
    if (canAdvance(g)) g.inviteGeneration = (Number.isSafeInteger(g.inviteGeneration) ? g.inviteGeneration : 0) + 1
  }
  return { reply: [200, { ok: true }], isEmpty: ids.length === 0 }
}

/** 簡單限流（記憶體裡、各自的程序或 isolate 各算各的） */
export function makeLimiter() {
  const hits = new Map()
  return (key, max, windowMs, now = Date.now()) => {
    const h = hits.get(key)
    if (!h || now - h.at >= windowMs) {
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

/** 下一筆等待中的私訊請求到期的時間（沒有＝null），Worker 排 alarm 用 */
export function dmNextPendingExpiry(g) {
  const times = Object.values(dmOf(g).links).filter(l => l.state === 'pending' && (blockedList(l).length === 0 || l.requester) && Number.isSafeInteger(l.createdAt)).map(l => l.createdAt + DM_PENDING_TTL_MS + 1)
  return times.length ? Math.min(...times) : null
}
