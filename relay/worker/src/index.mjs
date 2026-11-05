// Claude 好友動態：Cloudflare Worker 版中繼（relay-2）。API 和 relay/server.mjs 一樣，邏輯共用 relay/core.mjs。
// 一個群組＝一個 SQLite 版 Durable Object（relay/COST.md）：在線狀態（每次心跳）只放記憶體，
// 只有建群組、加入、踢人、離開、換邀請碼、動態換了才寫入，免費額度的寫入量才夠。
// 本機：cd relay/worker && npx wrangler dev；測試：node relay/test.mjs --base http://127.0.0.1:8787
import { DurableObject } from 'cloudflare:workers'
import * as core from '../../core.mjs'
import { requestSigningContext, responseSigner } from '../../response-signing.mjs'
import { aggregateReports, groupOpsSummary, newGroupOps, OPS_FLUSH_MS, recordMembershipRequest, rollGroupOps } from '../ops-stats.mjs'
import { CAPACITY_BLOCK, CAPACITY_ERROR, CAPACITY_PUBLIC, CAPACITY_WARNING } from '../../capacity.mjs'

let cachedSigning
const signerFor = env => {
  const secret = env.RESPONSE_SIGNING_PRIVATE_KEY
  const keyId = env.RESPONSE_SIGNING_KEY_ID
  if (!secret || !keyId) throw new Error('response signing secret missing')
  if (!cachedSigning || cachedSigning.secret !== secret || cachedSigning.keyId !== keyId) {
    cachedSigning = { secret, keyId, signer: responseSigner(secret, keyId) }
  }
  return cachedSigning.signer
}

async function signedJson(request, env, code, obj) {
  const body = JSON.stringify(obj)
  const { nonce, origin } = requestSigningContext(request)
  const signer = await signerFor(env)
  const { keyId, signature } = await (await signer)({
    nonce, origin, method: request.method, path: new URL(request.url).pathname, status: code, body,
  })
  return new Response(body, { status: code, headers: {
    'content-type': 'application/json; charset=utf-8',
    'x-friends-nonce': nonce,
    'x-friends-key-id': keyId,
    'x-friends-signature': signature,
  } })
}

// 每個 isolate 各算各的，盡力而為；真要擋濫用用 Cloudflare 的 WAF／Rate Limiting 規則
const limited = core.makeLimiter()

async function readBody(request) {
  if (Number(request.headers.get('content-length') ?? 0) > core.MAX_BODY) throw new Error('too large')
  // 沒有 content-length（chunked 傳送）時也照位元組算，跟 Node 版一樣（L-9）
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length > core.MAX_BODY) throw new Error('too large')
  const raw = new TextDecoder().decode(bytes)
  return core.parseBody(raw)
}

const groupOf = (env, groupId) => env.GROUP.get(env.GROUP.idFromName(groupId))
const statsOf = env => groupOf(env, 'relay-stats-v1')
const opsEnabled = env => env.FRIENDS_OPS_STATS === '1' || env.FRIENDS_PUBLIC_CAPACITY === '1'
const capacityEnabled = env => env.FRIENDS_PUBLIC_CAPACITY === '1'
// 測試時鐘：跟 FRIENDS_TEST_FAULTS 一樣，環境變數之外還要求連的是本機主機名（誤在正式環境設了變數也打不到）；deploy-guard 同樣擋這個變數
const isLocalHost = request => { const host = new URL(request.url).hostname; return host === '127.0.0.1' || host === 'localhost' }
const nowOf = (request, env) => env.FRIENDS_TEST_CLOCK === '1' && isLocalHost(request) && /^\d{1,16}$/.test(request.headers.get('x-friends-test-now') ?? '')
  ? Number(request.headers.get('x-friends-test-now')) : Date.now()
const opsError = operation => console.error(`relay stats ${operation} failed; will retry`)

export default {
  async fetch(request, env) {
    const ip = request.headers.get('cf-connecting-ip') ?? ''
    const json = (code, obj) => signedJson(request, env, code, obj)
    try {
      // 沒有私鑰時 API 一律不起作用；不產生未簽章的降級回應。
      await signerFor(env)
      if (limited('ip:' + ip, 600, 60_000)) return await json(429, { error: '請求太頻繁' })
      const route = `${request.method} ${new URL(request.url).pathname}`
      const now = nowOf(request, env)
      if (route === 'GET /health') return await json(200, { ok: true })
      // CHAT-5R：外掛先問這條再決定要不要顯示聊天。不需要 Bearer、不含任何群組資料；簽章走 signedJson（跟其他路由同一個簽章，含 404）
      if (route === 'GET /capability') return await json(200, core.capabilityBody(core.chatEnabledOf(env.FRIENDS_CHAT_ENABLED)))
      if (route === 'GET /admin/stats') {
        if (!opsEnabled(env) || !core.ADMIN_KEY_RE.test(env.FRIENDS_ADMIN_KEY ?? '')) return await json(404, { error: 'not found' })
        if (!(await core.isAdmin(request.headers.get('authorization'), env.FRIENDS_ADMIN_KEY))) return await json(401, { error: '金鑰無效' })
        return await json(200, await statsOf(env).statsView(now))
      }
      // 測試專用路由：只有 FRIENDS_TEST_FAULTS=1 才存在（正式部署沒有這個變數 → 404）
      if (route === 'POST /__test/fault' || route === 'POST /__test/reload') {
        // 環境變數之外再要求連的是本機（wrangler dev）：就算有人誤在正式環境設了變數，這兩條路由也打不到
        const host = new URL(request.url).hostname
        if (env.FRIENDS_TEST_FAULTS !== '1' || !(host === '127.0.0.1' || host === 'localhost')) return await json(404, { error: 'not found' })
        const t = await readBody(request)
        if (!core.GROUP_ID_RE.test(t.groupId ?? '')) return await json(400, { error: '請求格式錯誤' })
        if (route === 'POST /__test/fault') await groupOf(env, t.groupId).testFault(t.mode)
        else await groupOf(env, t.groupId).testReload()
        return await json(200, { ok: true })
      }
      if (request.method === 'POST' && !core.isJsonType(request.headers.get('content-type'))) return await json(415, { error: '要 application/json' })
      // 內文太大或不是合法 JSON 才是 400；其他內部例外（storage、Durable Object 重置…）在最外層回 503。
      // 外掛會把「帶 pauseSeq 的請求收到 400」當成中繼不認得這個欄位，暫時性的內部錯誤不能冒充成 400
      let b
      try { b = request.method === 'POST' ? await readBody(request) : {} } catch { return await json(400, { error: '請求格式錯誤' }) }
      // ver-2c：X-Friends-Version 經 clientVersion 過濾（格式不對、沒帶＝空字串），存進成員資料，不放進回應
      const ver = core.clientVersion(request.headers.get('x-friends-version'))
      if (route === 'POST /groups') {
        let reservation = ''
        if (capacityEnabled(env)) {
          try { reservation = await statsOf(env).admit(now, Number(env.FRIENDS_CAP_BLOCK) || CAPACITY_BLOCK) }
          catch { opsError('admission'); return await json(503, { error: CAPACITY_ERROR }) }
        }
        if (capacityEnabled(env) && !reservation) return await json(503, { error: CAPACITY_ERROR })
        const r = await core.createGroup(b, now, ver)
        if (r.error) { if (reservation) try { await statsOf(env).cancelReservation(reservation) } catch { opsError('reservation cleanup') }; return await json(...r.error) }
        try {
          await groupOf(env, r.groupId).init(r.groupId, r.g, opsEnabled(env), now)
          if (reservation) try { await statsOf(env).cancelReservation(reservation) } catch { opsError('reservation cleanup') }
          return await json(...r.reply)
        } catch (error) {
          if (reservation) try { await statsOf(env).cancelReservation(reservation) } catch { opsError('reservation cleanup') }
          throw error
        }
      }
      if (route === 'POST /join') {
        const groupId = core.groupIdOfInvite(core.clean(b.invite, 200))
        if (!core.GROUP_ID_RE.test(groupId)) return await json(403, { error: '邀請碼不對或已失效' })
        let reservation = ''
        if (capacityEnabled(env)) {
          try { reservation = await statsOf(env).admit(now, Number(env.FRIENDS_CAP_BLOCK) || CAPACITY_BLOCK) }
          catch { opsError('admission'); return await json(503, { error: CAPACITY_ERROR }) }
        }
        if (capacityEnabled(env) && !reservation) return await json(503, { error: CAPACITY_ERROR })
        try {
          const reply = await groupOf(env, groupId).join(groupId, b, ip, ver, opsEnabled(env), now)
          if (reservation) try { await statsOf(env).cancelReservation(reservation) } catch { opsError('reservation cleanup') }
          return await json(...reply)
        } catch (error) {
          if (reservation) try { await statsOf(env).cancelReservation(reservation) } catch { opsError('reservation cleanup') }
          throw error
        }
      }
      // SEC064：加入的人問自己有沒有被同意（金鑰是加入時拿到的；等待者還不是成員，所以不走 authed）
      if (route === 'POST /join/status') {
        const a = core.parseAuth(request.headers.get('authorization'))
        if (!a || !core.GROUP_ID_RE.test(a.groupId)) return await json(401, { error: '金鑰無效' })
        return await json(...(await groupOf(env, a.groupId).joinStatus(a, now)))
      }
      if (!AUTHED.has(route)) return await json(404, { error: 'not found' })
      // 總開關關著：對不合作的外掛也有效（不能只靠外掛自覺不呼叫）
      if (!core.chatEnabledOf(env.FRIENDS_CHAT_ENABLED) && core.isChatPath(new URL(request.url).pathname)) return await json(...core.chatDisabledReply())
      if (route === 'POST /name') {
        const invalid = core.renameInputError(b)
        if (invalid) return await json(...invalid)
      }
      const a = core.parseAuth(request.headers.get('authorization'))
      if (!a || !core.GROUP_ID_RE.test(a.groupId)) return await json(401, { error: '金鑰無效' })
      return await json(...(await groupOf(env, a.groupId).authed(route, a, b, ip, ver, opsEnabled(env), now)))
    } catch (error) {
      console.error('relay internal error', error?.name) // 只記錯誤種類，不記內容
      // 聊天／私訊路由的內部錯誤（例如讀信箱失敗）也帶 reason，外掛才能照 reason 判斷（盲審建議 S4）
      const path = new URL(request.url).pathname
      try { return await json(...(core.isChatPath(path) ? CHAT_SAVE_FAILED : SAVE_FAILED)) } catch {
        return new Response('{"error":"response signing unavailable"}', { status: 503, headers: { 'content-type': 'application/json; charset=utf-8' } })
      }
    }
  },
}

// 存檔失敗（Durable Object 的 storage 丟錯）：回 500 讓外掛稍後重試。不要混成 400（外掛會把 400 當成「中繼不認得這個欄位」而退讓），
// 也不要用 503（外掛把 503 顯示成「公開中繼已滿，請自己架一個」）
const SAVE_FAILED = [500, { error: '存檔暫時失敗，請稍後再試' }]

// 聊天／私訊路由存檔失敗（已還原）：500 加 reason，外掛看 reason 判斷能不能重試（CHAT3-RELAY；以前是 503 「聊天儲存暫時不可用」）
const CHAT_SAVE_FAILED = core.CHAT_SAVE_FAILED

const AUTHED = new Set(['POST /status', 'GET /friends', 'POST /invite/rotate', 'POST /kick', 'POST /name', 'POST /leave', 'POST /owner/act',
  'POST /chat/device', 'POST /chat/publish', 'POST /chat/poll',
  'POST /chat/roster/put', 'POST /chat/roster/get', 'POST /chat/epoch/put', 'POST /chat/epoch/get',
  'POST /chat/join/put', 'POST /chat/join/get', 'POST /chat/members/put', 'POST /chat/members/get',
  'POST /dm/request', 'POST /dm/accept', 'POST /dm/decline', 'POST /dm/block', 'POST /dm/unblock', 'POST /dm/list', 'POST /dm/send', 'POST /dm/poll'])

// 改到成員紀錄裡的聊天狀態（裝置清單、epoch 封包）的路由（CHAT3b-RELAY）
const CHAT_STATE_FNS = {
  'POST /chat/roster/put': (g, me, mem, b, now) => core.putRoster(g, me, mem, b, now),
  'POST /chat/roster/get': (g, _me, _mem, _b, now) => core.getRosters(g, now),
  'POST /chat/epoch/put': (g, me, _mem, b, now) => core.putEpochPackets(g, me, b, now),
  'POST /chat/epoch/get': (g, me, mem, b, now) => core.getEpochPackets(g, me, mem, b, now),
  'POST /chat/join/put': (g, me, mem, b, now) => core.putJoinProof(g, me, mem, b, now),
  'POST /chat/join/get': (g, me) => core.getJoinProofs(g, me),
  'POST /chat/members/put': (g, me, _mem, b, now) => core.putMemberList(g, me, b, now),
  'POST /chat/members/get': (g, _me, _mem, _b, now) => core.getMemberList(g, now),
}

// 改到私訊連結的路由（連結在群組資料裡，信箱訊息另外存）
const DM_LINK_FNS = {
  'POST /dm/request': core.dmRequest, 'POST /dm/accept': core.dmAccept, 'POST /dm/decline': core.dmDecline,
  'POST /dm/block': core.dmBlock, 'POST /dm/unblock': core.dmUnblock,
  'POST /dm/list': (g, me, _b, now) => core.dmList(g, me, now),
}

export class Group extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.g = undefined // undefined＝還沒讀；null＝這個群組不存在
    this.limited = core.makeLimiter()
    // 測試用：wrangler dev --var ACTIVITY_TTL_MS:3000 把 24 小時的保存期限縮短
    this.ttl = Number(env.ACTIVITY_TTL_MS) || core.ACTIVITY_TTL_MS
    this.chatTtl = Number(env.CHAT_TTL_MS) || core.CHAT_TTL_MS
    this.chatMaximum = Number(env.CHAT_MAX_MESSAGES) || core.CHAT_MAX_MESSAGES
    this.chatSenderMax = Number(env.CHAT_SENDER_MAX) || core.CHAT_SENDER_MAX
    this.dmMaximum = Number(env.DM_MAX_MESSAGES) || core.DM_MAX_MESSAGES
    this.dmSenderMax = Number(env.DM_SENDER_MAX) || core.DM_SENDER_MAX
    this.dm = undefined // 私訊信箱：{ 信箱代碼: mailbox }，每個存在 dm:<代碼> 這個鍵
    this.fault = '' // 測試專用，見 testFault
    this.env = env
    this.ops = undefined
    this.chat = undefined
    // 記憶體裡有還沒寫進資料庫的「暫停」（暫停那一次存檔失敗，記憶體保留暫停以免好友看到動態）：記是哪幾位成員。之後每個請求都先補存
    this.unsavedBy = new Set()
    this.tail = Promise.resolve()
    this.alarmDirty = false // 存檔時排到期鬧鐘失敗過（存檔本身成功）：之後的請求再排
  }

  // 一次只處理一個 join／authed／alarm。這幾個方法在 await（雜湊、存檔）的空檔會讓別的請求插進來；
  // 存檔失敗時要把記憶體還原成「這個請求開始前」，中間插進來並且已成功存檔的變更會被一起抹掉（盲審必修 2）
  async serial(fn) {
    const prev = this.tail
    let release
    this.tail = new Promise(resolve => { release = resolve })
    await prev
    try { return await fn() } finally { release() }
  }

  // 動態到期：沒人來讀也會叫醒這個 Durable Object 清掉（sec-3）
  alarm() { return this.serial(() => this.alarmNow()) }

  async alarmNow() {
    const g = await this.load()
    if (g) {
      const now = Date.now()
      const activityDirty = core.expireActivity(g, now, this.ttl)
      const pendingDirty = core.expirePending(g, now) // 等待同意的人過期（SEC064）
      const groupDirty = activityDirty || pendingDirty
      const chat = await this.loadChat()
      const chatDirty = core.expireChatMailbox(chat, now)
      // 私訊：過期的等待請求連信箱一起刪、信箱裡過期的訊息清掉、沒有連結的信箱丟掉（連結在群組資料裡，所以一起存）
      const dm = await this.loadDm()
      const gone = core.dmExpire(g, now)
      for (const code of gone) delete dm[code]
      const { touched, removed } = core.dmExpireBoxes(g, dm, now)
      const dmDirty = gone.length > 0 || touched.length > 0 || removed.length > 0
      if (dmDirty) await this.persistDm(touched, [...gone, ...removed])
      else if (groupDirty) await this.persist()
      if (chatDirty) await this.persistChat()
      if (!groupDirty && !chatDirty && !dmDirty) await this.scheduleExpiry()
    }
    if (this.alarmDirty) {
      await this.scheduleExpiry() // 這裡失敗就丟錯，讓 Cloudflare 重試這次 alarm
      this.alarmDirty = false
    }
  }

  async scheduleExpiry() {
    if (this.fault === 'alarm') throw new Error('test alarm fault')
    const chat = await this.loadChat()
    const dm = await this.loadDm()
    const times = [core.nextExpiry(this.g, this.ttl), core.nextChatExpiry(chat), core.dmNextExpiry(dm), core.dmNextPendingExpiry(this.g), core.nextPendingExpiry(this.g)].filter(Boolean)
    const t = times.length ? Math.min(...times) : null
    if (t) await this.ctx.storage.setAlarm(t)
    else await this.ctx.storage.deleteAlarm()
  }

  async load() {
    if (this.g === undefined) {
      const stored = await this.ctx.storage.get(['group', 'ops'])
      const g = stored.get('group') ?? null
      // 連線（在線狀態）不存，重啟後等下一次心跳補回來
      if (g) for (const m of Object.values(g.members)) m.conns = {}
      this.g = g
      this.ops = stored.get('ops')
      // 0.5.4 發布前草稿曾在 ops.members 另存一份 memberId 索引；搬回既有 member record 後刪掉副本。
      if (g && this.ops?.members) {
        for (const [id, value] of Object.entries(this.ops.members)) if (g.members[id]) {
          g.members[id].opsDays = value.days ?? 0
          g.members[id].opsTodayRequests = value.todayRequests ?? 0
        }
        delete this.ops.members
        this.ops.lastToken ??= ''
      }
    }
    return this.g
  }

  async loadChat() {
    if (this.chat === undefined) this.chat = (await this.ctx.storage.get('chatMailbox')) ?? core.newChatMailbox()
    return this.chat
  }

  async loadDm() {
    if (this.dm === undefined) {
      const stored = await this.ctx.storage.list({ prefix: 'dm:' })
      this.dm = Object.fromEntries([...stored].map(([key, value]) => [key.slice(3), value]))
    }
    return this.dm
  }

  // 群組資料的所有寫入都走這裡（測試可以注入失敗）；要連帶刪的鍵跟寫入放在同一個交易裡，一起成功或一起不算
  async putStore(values, deleteKeys = []) {
    if (this.fault === 'put') throw new Error('test storage fault')
    if (deleteKeys.length) {
      await this.ctx.storage.transaction(async txn => {
        await txn.put(values)
        await txn.delete(deleteKeys)
      })
    } else await this.ctx.storage.put(values)
  }

  // 私訊連結（在群組資料裡）和信箱一起存；touched＝要寫的信箱代碼，removed＝要刪的
  async persistDm(touched, removed) {
    const values = { group: this.storedGroup() }
    if (this.ops) values.ops = this.ops
    for (const code of touched) values['dm:' + code] = this.dm[code]
    await this.putStore(values, removed.map(code => 'dm:' + code))
    this.unsavedBy.clear()
    try {
      await this.scheduleExpiry()
      this.alarmDirty = false
    } catch { this.alarmDirty = true }
  }

  // 測試專用（FRIENDS_TEST_FAULTS=1 才可能被呼叫到，入口在 fetch）：注入下一次寫入失敗／排鬧鐘失敗；丟掉記憶體重讀儲存
  testFault(mode) {
    if (this.env.FRIENDS_TEST_FAULTS !== '1') throw new Error('test faults disabled')
    this.fault = mode === 'put' || mode === 'alarm' ? mode : ''
  }

  async testReload() {
    if (this.env.FRIENDS_TEST_FAULTS !== '1') throw new Error('test faults disabled')
    this.g = undefined
    this.chat = undefined
    this.dm = undefined
    this.ops = undefined
    await this.load()
  }

  async persistChat() {
    await this.putStore({ chatMailbox: this.chat })
    // put 成功才算存好；排鬧鐘失敗不能讓呼叫端以為存檔失敗而還原記憶體（那會讓記憶體落後資料庫，盲審建議 S2）
    try {
      await this.scheduleExpiry()
      this.alarmDirty = false
    } catch { this.alarmDirty = true }
  }

  storedGroup() {
    const members = Object.fromEntries(Object.entries(this.g.members).map(([id, { conns, ...m }]) => [id, m]))
    return { ...this.g, members }
  }

  async persistGroupAndChat(dmRemoved = []) {
    const values = { group: this.storedGroup(), chatMailbox: this.chat }
    if (this.ops) values.ops = this.ops
    await this.putStore(values, dmRemoved.map(code => 'dm:' + code))
    this.unsavedBy.clear()
    try {
      await this.scheduleExpiry()
      this.alarmDirty = false
    } catch { this.alarmDirty = true }
  }

  async persist() {
    const members = Object.fromEntries(Object.entries(this.g.members).map(([id, { conns, ...m }]) => [id, m]))
    const values = { group: { ...this.g, members } }
    if (this.ops) values.ops = this.ops
    await this.putStore(values)
    this.unsavedBy.clear()
    // put 成功才算存好；排鬧鐘失敗不能讓呼叫端以為存檔失敗而還原記憶體（那會讓記憶體落後資料庫）。
    // 鬧鐘沒排成的後果只是動態晚點清，下一個請求會再清、再排
    try {
      await this.scheduleExpiry()
      this.alarmDirty = false
    } catch { this.alarmDirty = true }
  }

  // 存檔失敗時還原用：只含會存進資料庫的欄位。conns（在線狀態）只放記憶體，不複製、也不還原（心跳是真的收到了）
  snapshot() {
    const { members, ...rest } = this.g
    return {
      rest: structuredClone(rest),
      members: Object.fromEntries(Object.entries(members).map(([id, { conns, ...m }]) => [id, { m: structuredClone(m), conns }])),
    }
  }

  // 保持同一個物件（authed 手上的 g、mem 參照不會失效），內容還原成 snapshot 當時的樣子
  restore(snap) {
    // 成員物件原地還原（不換新物件）：core 裡以成員物件為鍵的狀態（版本寫入頻率）才不會失效
    const old = this.g.members
    const members = {}
    for (const [id, { m, conns }] of Object.entries(snap.members)) {
      const cur = old[id]
      if (cur) for (const key of Object.keys(cur)) if (key !== 'conns') delete cur[key]
      members[id] = Object.assign(cur ?? { conns }, structuredClone(m))
    }
    for (const key of Object.keys(this.g)) delete this.g[key]
    Object.assign(this.g, structuredClone(snap.rest), { members })
  }

  async init(groupId, g, trackOps = false, now = Date.now()) {
    if (await this.load()) throw new Error('群組 id 撞了')
    for (const m of Object.values(g.members)) m.conns ??= {}
    this.g = g
    this.groupId = groupId
    if (trackOps) {
      this.ops = newGroupOps(now)
      recordMembershipRequest(this.ops, g.members, g.members[g.ownerId], now)
    }
    await this.persist()
    if (trackOps) await this.flushOps(groupId, now, true)
  }

  join(...args) { return this.serial(() => this.joinNow(...args)) }

  async joinNow(groupId, b, ip, ver, trackOps = false, now = Date.now()) {
    if (this.limited('join:' + ip, 10, 3_600_000)) return [429, { error: '嘗試太多次，一小時後再試' }]
    const g = await this.load()
    const r = await core.join(g, groupId, b, now, ver)
    if (r[0] === 200 || r[0] === 202) { // 202＝等待同意的要求要存下來，建立者才看得到（SEC064）
      // 提交點是一次 put；失敗就還原成加入之前，不留下沒人拿得到憑證的成員或等待要求。用量統計等提交成功後才記（失敗還原不會讓統計錯位）
      const joined = r[0] === 200 && trackOps ? g.members[r[1].memberId] : undefined
      try { await this.persist() } catch { core.restoreGroup(g, r[3]); return [500, { error: '儲存暫時不可用，請再試一次', reason: 'unreachable' }] }
      if (joined) {
        this.ops ??= newGroupOps(now)
        recordMembershipRequest(this.ops, g.members, joined, now)
        await this.flushOps(groupId, now, true)
      }
    }
    return [r[0], r[1]]
  }

  // SEC064：加入的人輪詢自己有沒有被同意。跟 join／authed 一樣排進 serial：它會 await 再 persist 整個 this.g，
  // 不排隊的話會把別人「寫入失敗、待還原」的半套狀態（例如還沒提交的新成員）一起寫進儲存（INT060d 盲審必修）
  joinStatus(...args) { return this.serial(() => this.joinStatusNow(...args)) }

  async joinStatusNow(a, now = Date.now()) {
    const g = await this.load()
    const [code, obj, isDirty] = await core.joinStatus(g, a.memberId, a.key, now)
    if (isDirty) try { await this.persist() } catch {}
    return [code, obj]
  }

  authed(...args) { return this.serial(() => this.authedNow(...args)) }

  async authedNow(route, a, b, ip, ver, trackOps = false, now = Date.now()) {
    const g = await this.load()
    const mem = await core.findMember(g, a.memberId, a.key)
    if (!mem) return [401, { error: '金鑰無效' }]
    // 上一個請求的暫停存檔失敗、記憶體先暫停了：這個請求順便補存（不論是誰送來的）
    if (this.unsavedBy.size) try { await this.persist() } catch {}
    if (this.alarmDirty) try { await this.scheduleExpiry(); this.alarmDirty = false } catch {}
    // 名字格式先在入口驗；IP 額度只讓通過 member key 的請求消耗，跟 Node 順序一致。
    if (route === 'POST /name' && limited('rename:' + ip, core.RENAME_GLOBAL_MAX, core.RENAME_GLOBAL_WINDOW_MS, now))
      return [429, { error: '改名太頻繁' }]
    if (trackOps) {
      this.ops ??= newGroupOps(now)
      recordMembershipRequest(this.ops, g.members, mem, now)
      await this.flushOps(a.groupId, now)
    }
    // 要寫資料庫的事先記下來，最後同一個請求只寫一次（fix-6）：動態過期、版本要單獨存（一小時內最多一次，見 core.noteVer）、這個路由自己的變動
    // 兩個都要跑（不能短路）；等待同意的人過期也順手清（SEC064）
    const expiredActivity = core.expireActivity(g, now, this.ttl)
    const expiredPending = core.expirePending(g, now)
    const expired = expiredActivity || expiredPending
    const verWrite = core.noteVer(mem, ver, now)
    const dirty = expired || verWrite
    let saved = false
    const save = async () => {
      await this.persist()
      saved = true
    }
    // 0.5.8：先存檔成功，記憶體才算數。路由已經在記憶體改了東西、存檔卻失敗 → 還原成這個請求開始前的樣子（跟資料庫一致），
    // 回 503 讓外掛重試。以前記憶體改了、資料庫沒改：之後 Durable Object 被回收，旗標會倒回舊值（暫停被悄悄解除或恢復又變回暫停）
    const snap = this.snapshot()
    const failed = () => {
      this.restore(snap)
      return SAVE_FAILED
    }
    try {
      if (route === 'POST /status') {
        const wasPaused = mem.paused === true
        const [code, obj, isDirty] = core.status(g, a.memberId, mem, b, now, ver)
        if (isDirty) {
          try { await save() } catch {
            // 暫停是例外：隱私承諾比一致性重要，記憶體維持「已暫停」（好友只看得到在線），等補存；其他一律還原
            if (mem.paused === true && !wasPaused) {
              try { await save(); return [code, obj] } catch {} // 先立刻再試一次（短暫失敗）；還是不行才留著等補存
              this.unsavedBy.add(a.memberId)
              return SAVE_FAILED
            }
            return failed()
          }
        } else if (code === 200 && this.unsavedBy.has(a.memberId)) return SAVE_FAILED // 200＝已經寫進資料庫；只有這位成員的暫停還沒存好才回 503，別人的心跳照常
        return [code, obj]
      }
      if (route === 'GET /friends') return [200, core.friendsView(g, a.memberId, now)]
      if (route === 'POST /chat/device') {
        const previous = mem.chatDevices ? structuredClone(mem.chatDevices) : undefined
        const [code, obj, isDirty] = core.registerChatDevice(mem, b)
        if (isDirty) try { await save() } catch {
          if (previous === undefined) delete mem.chatDevices
          else mem.chatDevices = previous
          return CHAT_SAVE_FAILED
        }
        return [code, obj]
      }
      if (route === 'POST /chat/publish') {
        const original = await this.loadChat()
        const working = structuredClone(original)
        const [code, obj, isDirty] = await core.publishChatEnvelope(a.groupId, a.memberId, mem, b, working, now, this.chatTtl, this.chatMaximum, this.chatSenderMax)
        if (isDirty) {
          this.chat = working
          try { await this.persistChat() } catch { this.chat = original; return CHAT_SAVE_FAILED }
        }
        return [code, obj]
      }
      if (route === 'POST /chat/poll') {
        const original = await this.loadChat()
        const working = structuredClone(original)
        const [code, obj, isDirty] = core.pollChatMailbox(b, working, now)
        if (isDirty) {
          this.chat = working
          try { await this.persistChat() } catch { this.chat = original; return CHAT_SAVE_FAILED }
        }
        return [code, obj]
      }
      if (Object.hasOwn(CHAT_STATE_FNS, route)) {
        let result
        try { result = CHAT_STATE_FNS[route](g, a.memberId, mem, b, now) } catch {
          this.restore(snap)
          return CHAT_SAVE_FAILED
        }
        const [code, obj, changed] = result
        if (changed) try { await save(); saved = true } catch { this.restore(snap); return CHAT_SAVE_FAILED }
        return [code, obj]
      }
      if (Object.hasOwn(DM_LINK_FNS, route)) {
        const boxes = await this.loadDm()
        const boxesBefore = structuredClone(boxes)
        let result
        try { result = DM_LINK_FNS[route](g, a.memberId, b, now, boxes) } catch {
          this.dm = boxesBefore // 純函式丟例外（資料壞掉）：連結可能改到一半，整個還原
          this.restore(snap)
          return CHAT_SAVE_FAILED
        }
        const [code, obj, changed, removed, touched = []] = result
        if (changed) {
          for (const c of removed) delete boxes[c]
          try { await this.persistDm(touched, removed); saved = true } catch {
            this.dm = boxesBefore
            this.restore(snap)
            return CHAT_SAVE_FAILED
          }
        }
        return [code, obj]
      }
      if (route === 'POST /dm/send') {
        const boxes = await this.loadDm()
        const working = structuredClone(boxes)
        const [code, obj, dirty, touched] = await core.dmSend(g, a.groupId, a.memberId, mem, b, working, now, this.chatTtl, this.dmMaximum, this.dmSenderMax)
        if (dirty) {
          this.dm = working
          try { await this.persistDm([touched], []); saved = true } catch { this.dm = boxes; return CHAT_SAVE_FAILED }
        }
        return [code, obj]
      }
      if (route === 'POST /dm/poll') {
        const boxes = await this.loadDm()
        const working = structuredClone(boxes)
        const [code, obj, touched] = core.dmPoll(g, a.memberId, b, working, now)
        if (touched.length) {
          this.dm = working
          try { await this.persistDm(touched, []); saved = true } catch { this.dm = boxes; return CHAT_SAVE_FAILED }
        }
        return [code, obj]
      }
      if (route === 'POST /invite/rotate') {
        const r = await core.rotateInvite(g, a.groupId, a.memberId)
        if (r[0] === 200) try { await save() } catch { core.restoreGroup(g, r[3]); return [500, { error: '儲存暫時不可用，沒有任何改動', reason: 'unreachable' }] }
        return [r[0], r[1]]
      }
      if (route === 'POST /owner/act') {
        const r = await core.ownerAct(g, a.groupId, a.memberId, b, now)
        if (r[2]) {
          try { await save() } catch {
            core.restoreGroup(g, r[3])
            const [code, obj] = core.ownerFailure('unreachable')
            return [code, obj]
          }
        }
        return [r[0], r[1]]
      }
      if (route === 'POST /name') {
        const r = core.rename(mem, b, now)
        if (r[0] === 200) try { await save() } catch { return failed() }
        return r
      }
      if (route === 'POST /kick') {
        await this.loadChat()
        await this.loadDm()
        const r = await core.kick(g, a.groupId, a.memberId, b)
        if (r[0] === 200) {
          // 信箱的複本在 kick 的 await 之後才拍（中間進來的聊天請求不會被蓋掉）
          const originalChat = this.chat
          const workingChat = structuredClone(originalChat)
          core.clearChatForMember(workingChat, b.memberId)
          this.chat = workingChat
          const originalDm = this.dm
          const dmGone = core.dmDropMember(g, b.memberId)
          this.dm = structuredClone(originalDm)
          for (const code of dmGone) delete this.dm[code]
          try { await this.persistGroupAndChat(dmGone); saved = true } catch {
            core.restoreGroup(g, r[3]) // 在原物件上還原（核心回的快照是改動前一刻拍的，早於 dmDropMember）
            this.chat = originalChat
            this.dm = originalDm
            return [500, { error: '儲存暫時不可用，沒有任何改動', reason: 'unreachable' }]
          }
        }
        return [r[0], r[1]]
      }
      // POST /leave：群組空了整組刪（sec-3）
      const originalChat = await this.loadChat()
      const workingChat = structuredClone(originalChat)
      const originalDm = await this.loadDm()
      const originalGroup = structuredClone(g) // 這之後到 leave 之間沒有 await（含 dmDropMember 的改動）
      const dmGone = core.dmDropMember(g, a.memberId)
      this.dm = structuredClone(originalDm)
      for (const code of dmGone) delete this.dm[code]
      const { reply, isEmpty } = core.leave(g, a.memberId)
      try {
        if (isEmpty) {
          await this.ctx.storage.deleteAlarm()
          await this.ctx.storage.deleteAll()
          this.g = null
          saved = true // 整組都刪了，沒有東西要補存
        } else {
          core.clearChatForMember(workingChat, a.memberId)
          this.chat = workingChat
          try { await this.persistGroupAndChat(dmGone); saved = true } catch {
            core.restoreGroup(g, originalGroup)
            this.chat = originalChat
            this.dm = originalDm
            return [500, { error: '儲存暫時不可用，沒有任何改動', reason: 'unreachable' }]
          }
        }
      } catch { this.chat = originalChat; this.dm = originalDm; return failed() }
      return reply
    } finally {
      // 順便要存的（過期動態、版本）一律在這裡補存一次（fix-7／fix-8）：路由自己沒存成功（沒有要存、非 200 的回應、或丟了例外）都算；
      // 補存丟錯就接住，回應碼照路由原本的（跟 Node 版一致）。群組已經沒有成員（最後一個人離開，刪儲存時丟錯）就不補存，免得把零成員的群組寫回去
      if (dirty && !saved && this.g && Object.keys(this.g.members).length > 0) {
        try { await save() } catch {}
      }
      // 版本單獨寫成功之後才記成已寫（存檔丟錯就不記，下個請求再試）
      if (verWrite && saved) core.markVerWritten(mem, now)
    }
  }

  async flushOps(groupId, now, force = false) {
    if (!this.ops || (!force && now - this.ops.lastReportedAt < OPS_FLUSH_MS)) return
    rollGroupOps(this.ops, this.g.members, now)
    const token = await core.weeklyHash(core.weekOf(now), groupId)
    const previous = { lastToken: this.ops.lastToken, lastReportedAt: this.ops.lastReportedAt, dirtySince: this.ops.dirtySince }
    try {
      await statsOf(this.env).report(this.ops.lastToken, token, { ...groupOpsSummary(this.ops, this.g.members), reportedAt: now })
      this.ops.lastToken = token
      this.ops.lastReportedAt = now
      this.ops.dirtySince = 0
      await this.ctx.storage.put({ group: { ...this.g, members: Object.fromEntries(Object.entries(this.g.members).map(([id, { conns, ...m }]) => [id, m])) }, ops: this.ops })
    } catch {
      Object.assign(this.ops, previous)
      this.ops.dirtySince ||= now
      opsError('report')
    }
  }

  // 保留名稱的單一 GROUP instance 充當 RelayStats DO；DO RPC 保證 report／admission 序列化。
  async report(previousToken, token, summary) {
    if (this.env.FRIENDS_TEST_STATS_FAULT === 'report') throw new Error('test report fault')
    const reports = (await this.ctx.storage.get('reports')) ?? {}
    if (previousToken && previousToken !== token) delete reports[previousToken]
    reports[token] = summary
    await this.ctx.storage.put('reports', reports)
  }

  async statsView(now) {
    const reports = (await this.ctx.storage.get('reports')) ?? {}
    const reservations = (await this.ctx.storage.get('reservations')) ?? {}
    const view = aggregateReports(reports, reservations, now)
    await this.ctx.storage.put({ reports, reservations })
    const dataUpdatedAt = Object.values(reports).reduce((latest, report) => Math.max(latest, report?.reportedAt ?? 0), 0)
    return {
      ...view, dataUpdatedAt,
      requestHistogram: Object.fromEntries(['1', '2-5', '6-20', '21-100', '101-500', '501+'].map((label, i) => [label, view.requestHistogram[i]])),
      capacity: this.env.FRIENDS_PUBLIC_CAPACITY === '1' ? (() => {
        const warningAt = Number(this.env.FRIENDS_CAP_WARNING) || CAPACITY_WARNING
        return { unit: 'rolling7ActiveMemberships', warningAt, warning: view.rolling7ActiveMemberships >= warningAt,
          blockNewAt: Number(this.env.FRIENDS_CAP_BLOCK) || CAPACITY_BLOCK, publicCapacity: Number(this.env.FRIENDS_CAP_PUBLIC) || CAPACITY_PUBLIC }
      })() : undefined,
    }
  }

  async admit(now, blockAt) {
    if (this.env.FRIENDS_TEST_STATS_FAULT === 'admit') throw new Error('test admission fault')
    const reports = (await this.ctx.storage.get('reports')) ?? {}
    const reservations = (await this.ctx.storage.get('reservations')) ?? {}
    const view = aggregateReports(reports, reservations, now)
    if (view.rolling7ActiveMemberships + view.reservationCount >= blockAt) return ''
    const id = core.token(12)
    reservations[id] = now + (Number(this.env.FRIENDS_TEST_RESERVATION_MS) || 5 * 60_000)
    await this.ctx.storage.put({ reports, reservations })
    return id
  }

  async cancelReservation(id) {
    if (this.env.FRIENDS_TEST_STATS_FAULT === 'cancel') throw new Error('test cancel fault')
    const reservations = (await this.ctx.storage.get('reservations')) ?? {}
    delete reservations[id]
    await this.ctx.storage.put('reservations', reservations)
  }
}
