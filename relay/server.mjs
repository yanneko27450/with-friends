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
const CHAT_TTL = Number(arg('--chat-ttl-ms', core.CHAT_TTL_MS))
const CHAT_MAX = Number(arg('--chat-max-messages', core.CHAT_MAX_MESSAGES))
const CHAT_SENDER = Number(arg('--chat-sender-max', core.CHAT_SENDER_MAX))
const DM_MAX = Number(arg('--dm-max-messages', core.DM_MAX_MESSAGES))
const DM_SENDER = Number(arg('--dm-sender-max', core.DM_SENDER_MAX))
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
// CHAT-5R：聊天總開關，預設關。FRIENDS_CHAT_ENABLED 只有 1 才開；關著時 /capability 回 chat.enabled:false，/chat/*、/dm/* 一律 403 chat-disabled
const CHAT_ENABLED = core.chatEnabledOf(process.env.FRIENDS_CHAT_ENABLED)
if (!CHAT_ENABLED && process.env.FRIENDS_CHAT_ENABLED) console.error('⚠ FRIENDS_CHAT_ENABLED 只認 1，其他值都當關')
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
if (!(db.chat && typeof db.chat === 'object' && !Array.isArray(db.chat))) db.chat = {}
// 私訊信箱：db.dm[群組代碼][信箱代碼] = mailbox（連結本身在群組資料 g.dm.links）
if (!(db.dm && typeof db.dm === 'object' && !Array.isArray(db.dm))) db.dm = {}
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
  for (const mailbox of Object.values(db.chat)) isDirty = core.expireChatMailbox(mailbox, Date.now()) || isDirty
  // 私訊：過期的等待請求連同信箱一起刪，信箱裡過期的訊息清掉，沒有連結的信箱丟掉
  for (const [groupId, g] of Object.entries(db.groups)) {
    const boxes = (db.dm[groupId] ??= {})
    const gone = core.dmExpire(g, Date.now())
    for (const code of gone) delete boxes[code]
    const { touched, removed } = core.dmExpireBoxes(g, boxes, Date.now())
    isDirty = gone.length > 0 || touched.length > 0 || removed.length > 0 || isDirty
    if (!Object.keys(boxes).length) delete db.dm[groupId]
  }
  for (const groupId of Object.keys(db.dm)) if (!Object.hasOwn(db.groups, groupId)) { delete db.dm[groupId]; isDirty = true }
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
setInterval(sweep, Math.min(60_000, TTL, CHAT_TTL)).unref()

// 聊天／私訊路由存檔失敗（已還原）：500 加 reason，跟 0.5.8 的規則一致；外掛看 reason 判斷能不能重試
const CHAT_SAVE_FAILED = core.CHAT_SAVE_FAILED

// 簡單限流：每個 IP 每分鐘 600 次；加入每小時 10 次
const limited = core.makeLimiter()

// X-Friends-Version 標頭，經 clientVersion 過濾（格式不對、沒帶＝空字串）
const ver = req => core.clientVersion(req.headers['x-friends-version'])

async function findMember(req) {
  const a = core.parseAuth(req.headers.authorization)
  if (!a) return null
  const g = groupOf(a.groupId)
  // 過期動態和版本都只改記憶體，要不要存檔交給 authed 一次決定（同一個請求只存一次，fix-6）。金鑰不對時沒有 authed 可交，過期的那次當場存
  // 等待同意的人過期也一併清（SEC064），清了就要存；兩個都要跑，不能短路
  const expiredActivity = g ? core.expireActivity(g, Date.now(), TTL) : false
  const expiredPending = g ? core.expirePending(g, Date.now()) : false
  const expired = expiredActivity || expiredPending
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

// 改到私訊連結的路由：連結在群組資料裡、信箱訊息另外放；存檔失敗就兩邊一起還原成請求之前，回 500（沒有任何改動）
function dmLink(fn) {
  return authed((who, b) => {
    const gBefore = structuredClone(who.g)
    const boxesBefore = db.dm[who.groupId] ? structuredClone(db.dm[who.groupId]) : undefined
    const boxes = db.dm[who.groupId] ?? {}
    const [code, obj, changed, removed] = fn(who.g, who.memberId, b, Date.now(), boxes)
    if (changed) {
      for (const c of removed) delete boxes[c]
      if (Object.keys(boxes).length) db.dm[who.groupId] = boxes
      else delete db.dm[who.groupId]
      try { save() } catch {
        for (const key of Object.keys(who.g)) delete who.g[key]
        Object.assign(who.g, gBefore)
        if (boxesBefore === undefined) delete db.dm[who.groupId]
        else db.dm[who.groupId] = boxesBefore
        return CHAT_SAVE_FAILED
      }
    }
    return [code, obj]
  })
}

// 改到成員紀錄裡的聊天狀態（裝置清單、epoch 封包）的路由：存檔失敗就整個群組還原成請求之前，回 500（沒有任何改動）
function chatState(fn) {
  return authed((who, b) => {
    const gBefore = structuredClone(who.g)
    const [code, obj, changed] = fn(who.g, who.memberId, who.mem, b, Date.now())
    if (changed) {
      try { save() } catch {
        for (const key of Object.keys(who.g)) delete who.g[key]
        Object.assign(who.g, gBefore)
        return CHAT_SAVE_FAILED
      }
    }
    return [code, obj]
  })
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
      const g = groupOf(groupId)
      const r = await core.join(g, groupId, b, Date.now(), ver(req))
      if (r[0] === 200 || r[0] === 202) { // 202＝建立了等待同意的要求（SEC064）
        // 存檔失敗：還原成加入之前，不留下沒人拿得到憑證的成員或等待要求
        try { save() } catch { core.restoreGroup(g, r[3]); return [500, { error: '儲存暫時不可用，請再試一次', reason: 'unreachable' }] }
      }
      return [r[0], r[1]]
    } finally { if (PUBLIC_CAPACITY) capacityReservations -= 1 }
  },
  // SEC064：加入的人問自己有沒有被同意（金鑰是加入時拿到的；等待者還不是成員，所以不走 authed）
  'POST /join/status': async req => {
    const a = core.parseAuth(req.headers.authorization)
    if (!a) return [401, { error: '金鑰無效' }]
    const [code, obj, isDirty] = await core.joinStatus(groupOf(a.groupId), a.memberId, a.key, Date.now())
    if (isDirty) try { save() } catch (err) { console.error(`⚠ 存資料檔失敗（${err.code ?? err.message}），下次再試`) }
    return [code, obj]
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
  'POST /chat/device': authed((who, b) => {
    const previous = who.mem.chatDevices ? structuredClone(who.mem.chatDevices) : undefined
    const [code, obj, dirty] = core.registerChatDevice(who.mem, b)
    if (dirty) try { save() } catch {
      if (previous === undefined) delete who.mem.chatDevices
      else who.mem.chatDevices = previous
      return CHAT_SAVE_FAILED
    }
    return [code, obj]
  }),
  'POST /chat/publish': authed(async (who, b) => {
    const mailbox = structuredClone(db.chat[who.groupId] ?? core.newChatMailbox())
    const [code, obj, dirty] = await core.publishChatEnvelope(who.groupId, who.memberId, who.mem, b, mailbox, Date.now(), CHAT_TTL, CHAT_MAX, CHAT_SENDER)
    if (dirty) {
      const previous = db.chat[who.groupId]
      db.chat[who.groupId] = mailbox
      try { save() } catch {
        if (previous === undefined) delete db.chat[who.groupId]
        else db.chat[who.groupId] = previous
        return CHAT_SAVE_FAILED
      }
    }
    return [code, obj]
  }),
  'POST /chat/poll': authed((who, b) => {
    const mailbox = structuredClone(db.chat[who.groupId] ?? core.newChatMailbox())
    const [code, obj, dirty] = core.pollChatMailbox(b, mailbox, Date.now())
    if (dirty) {
      const previous = db.chat[who.groupId]
      db.chat[who.groupId] = mailbox
      try { save() } catch {
        if (previous === undefined) delete db.chat[who.groupId]
        else db.chat[who.groupId] = previous
        return CHAT_SAVE_FAILED
      }
    }
    return [code, obj]
  }),
  // ── 裝置清單與 epoch 金鑰封包（CHAT3b-RELAY）──
  'POST /chat/roster/put': chatState((g, me, mem, b, now) => core.putRoster(g, me, mem, b, now)),
  'POST /chat/roster/get': chatState((g, _me, _mem, _b, now) => core.getRosters(g, now)),
  'POST /chat/epoch/put': chatState((g, me, _mem, b, now) => core.putEpochPackets(g, me, b, now)),
  'POST /chat/epoch/get': chatState((g, me, mem, b, now) => core.getEpochPackets(g, me, mem, b, now)),
  'POST /chat/join/put': chatState((g, me, mem, b, now) => core.putJoinProof(g, me, mem, b, now)),
  'POST /chat/join/get': chatState((g, me) => core.getJoinProofs(g, me)),
  'POST /chat/members/put': chatState((g, me, _mem, b, now) => core.putMemberList(g, me, b, now)),
  'POST /chat/members/get': chatState((g, _me, _mem, _b, now) => core.getMemberList(g, now)),
  // ── 私訊（CHAT3-RELAY，設計見 docs/drafts/chat3-relay-design.md）──
  'POST /dm/request': dmLink(core.dmRequest),
  'POST /dm/accept': dmLink(core.dmAccept),
  'POST /dm/decline': dmLink(core.dmDecline),
  'POST /dm/block': dmLink(core.dmBlock),
  'POST /dm/unblock': dmLink(core.dmUnblock),
  'POST /dm/list': dmLink((g, me, _b, now) => core.dmList(g, me, now)),
  'POST /dm/send': authed(async (who, b) => {
    const boxes = structuredClone(db.dm[who.groupId] ?? {})
    const [code, obj, dirty] = await core.dmSend(who.g, who.groupId, who.memberId, who.mem, b, boxes, Date.now(), CHAT_TTL, DM_MAX, DM_SENDER)
    if (dirty) {
      const previous = db.dm[who.groupId]
      db.dm[who.groupId] = boxes
      try { save() } catch {
        if (previous === undefined) delete db.dm[who.groupId]
        else db.dm[who.groupId] = previous
        return CHAT_SAVE_FAILED
      }
    }
    return [code, obj]
  }),
  'POST /dm/poll': authed((who, b) => {
    const boxes = structuredClone(db.dm[who.groupId] ?? {})
    const [code, obj, touched] = core.dmPoll(who.g, who.memberId, b, boxes, Date.now())
    if (touched.length) {
      const previous = db.dm[who.groupId]
      db.dm[who.groupId] = boxes
      try { save() } catch {
        if (previous === undefined) delete db.dm[who.groupId]
        else db.dm[who.groupId] = previous
        return CHAT_SAVE_FAILED
      }
    }
    return [code, obj]
  }),
  // 寫入失敗就還原成請求前的樣子再回 500：「沒有改到任何東西」要真的做到（SEC064）
  'POST /invite/rotate': authed(async who => {
    const r = await core.rotateInvite(who.g, who.groupId, who.memberId)
    if (r[0] === 200) {
      try { save() } catch { core.restoreGroup(who.g, r[3]); return [500, { error: '儲存暫時不可用，沒有任何改動', reason: 'unreachable' }] }
    }
    return [r[0], r[1]]
  }),
  'POST /kick': authed(async (who, b) => {
    const r = await core.kick(who.g, who.groupId, who.memberId, b)
    if (r[0] === 200) {
      const previousChat = db.chat[who.groupId]
      if (previousChat) db.chat[who.groupId] = structuredClone(previousChat)
      if (db.chat[who.groupId]) core.clearChatForMember(db.chat[who.groupId], b.memberId)
      const previousDm = db.dm[who.groupId]
      if (previousDm) db.dm[who.groupId] = structuredClone(previousDm)
      for (const code of core.dmDropMember(who.g, b.memberId)) delete db.dm[who.groupId]?.[code]
      try { save() } catch {
        core.restoreGroup(who.g, r[3])
        if (previousChat) db.chat[who.groupId] = previousChat
        if (previousDm) db.dm[who.groupId] = previousDm
        return [500, { error: '儲存暫時不可用，沒有任何改動', reason: 'unreachable' }]
      }
    }
    return [r[0], r[1]]
  }),
  'POST /owner/act': authed(async (who, b) => {
    const r = await core.ownerAct(who.g, who.groupId, who.memberId, b, Date.now())
    if (r[2]) {
      try { save() } catch {
        core.restoreGroup(who.g, r[3])
        const [code, obj] = core.ownerFailure('unreachable')
        return [code, obj]
      }
    }
    return [r[0], r[1]]
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
    // 存檔失敗就還原成離開之前（含建立者離開時的換人、撤銷邀請），回 500
    const groupBefore = structuredClone(who.g)
    const chatBefore = db.chat[who.groupId]
    if (chatBefore) db.chat[who.groupId] = structuredClone(chatBefore)
    if (db.chat[who.groupId]) core.clearChatForMember(db.chat[who.groupId], who.memberId)
    const dmBefore = db.dm[who.groupId]
    if (dmBefore) db.dm[who.groupId] = structuredClone(dmBefore)
    for (const code of core.dmDropMember(who.g, who.memberId)) delete db.dm[who.groupId]?.[code]
    const { reply, isEmpty } = core.leave(who.g, who.memberId)
    if (isEmpty) { delete db.groups[who.groupId]; delete db.chat[who.groupId]; delete db.dm[who.groupId] }
    try { save() } catch {
      core.restoreGroup(who.g, groupBefore)
      db.groups[who.groupId] = who.g
      if (chatBefore) db.chat[who.groupId] = chatBefore
      if (dmBefore) db.dm[who.groupId] = dmBefore
      return [500, { error: '儲存暫時不可用，請再試一次', reason: 'unreachable' }]
    }
    return reply
  }),
  'GET /health': async () => [200, { ok: true }],
  // CHAT-5R：外掛先問這條再決定要不要顯示聊天。不需要 Bearer、不含任何群組資料；簽章走 send()（跟其他路由同一個簽章，含 404）
  'GET /capability': async () => [200, core.capabilityBody(CHAT_ENABLED)],
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
    // 內文太大或不是合法 JSON 才是 400；路由裡其他例外（存檔失敗…）回 500。
    // 外掛把「帶 pauseSeq 的請求收到 400」當成中繼不認得這個欄位，暫時性的內部錯誤不能冒充成 400
    let b
    try { b = req.method === 'POST' ? await body(req) : {} } catch { return await send(400, { error: '請求格式錯誤' }) }
    // 總開關關著：對不合作的外掛也有效（不能只靠外掛自覺不呼叫）
    if (!CHAT_ENABLED && core.isChatPath(path)) { const [code, obj] = core.chatDisabledReply(); return await send(code, obj) }
    const [code, obj] = await route(req, b, ip)
    await send(code, obj)
  } catch (err) {
    if (!res.headersSent) await send(500, { error: '中繼暫時出錯，請稍後再試' })
  }
})

server.listen(PORT, '127.0.0.1', () => console.log(`friends relay on http://127.0.0.1:${PORT}`))
