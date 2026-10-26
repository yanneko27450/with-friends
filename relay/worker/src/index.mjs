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
const nowOf = (request, env) => env.FRIENDS_TEST_CLOCK === '1' && /^\d{1,16}$/.test(request.headers.get('x-friends-test-now') ?? '')
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
      if (route === 'GET /admin/stats') {
        if (!opsEnabled(env) || !core.ADMIN_KEY_RE.test(env.FRIENDS_ADMIN_KEY ?? '')) return await json(404, { error: 'not found' })
        if (!(await core.isAdmin(request.headers.get('authorization'), env.FRIENDS_ADMIN_KEY))) return await json(401, { error: '金鑰無效' })
        return await json(200, await statsOf(env).statsView(now))
      }
      if (request.method === 'POST' && !core.isJsonType(request.headers.get('content-type'))) return await json(415, { error: '要 application/json' })
      const b = request.method === 'POST' ? await readBody(request) : {}
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
      if (!AUTHED.has(route)) return await json(404, { error: 'not found' })
      const a = core.parseAuth(request.headers.get('authorization'))
      if (!a || !core.GROUP_ID_RE.test(a.groupId)) return await json(401, { error: '金鑰無效' })
      return await json(...(await groupOf(env, a.groupId).authed(route, a, b, ver, opsEnabled(env), now)))
    } catch {
      try { return await json(400, { error: '請求格式錯誤' }) } catch {
        return new Response('{"error":"response signing unavailable"}', { status: 503, headers: { 'content-type': 'application/json; charset=utf-8' } })
      }
    }
  },
}

const AUTHED = new Set(['POST /status', 'GET /friends', 'POST /invite/rotate', 'POST /kick', 'POST /leave'])

export class Group extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.g = undefined // undefined＝還沒讀；null＝這個群組不存在
    this.limited = core.makeLimiter()
    // 測試用：wrangler dev --var ACTIVITY_TTL_MS:3000 把 24 小時的保存期限縮短
    this.ttl = Number(env.ACTIVITY_TTL_MS) || core.ACTIVITY_TTL_MS
    this.env = env
    this.ops = undefined
  }

  // 動態到期：沒人來讀也會叫醒這個 Durable Object 清掉（sec-3）
  async alarm() {
    const g = await this.load()
    if (g && core.expireActivity(g, Date.now(), this.ttl)) await this.persist()
    else if (g) await this.scheduleExpiry()
  }

  async scheduleExpiry() {
    const t = core.nextExpiry(this.g, this.ttl)
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

  async persist() {
    const members = Object.fromEntries(Object.entries(this.g.members).map(([id, { conns, ...m }]) => [id, m]))
    const values = { group: { ...this.g, members } }
    if (this.ops) values.ops = this.ops
    await this.ctx.storage.put(values)
    await this.scheduleExpiry()
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

  async join(groupId, b, ip, ver, trackOps = false, now = Date.now()) {
    if (this.limited('join:' + ip, 10, 3_600_000)) return [429, { error: '嘗試太多次，一小時後再試' }]
    const g = await this.load()
    const r = await core.join(g, groupId, b, now, ver)
    if (r[0] === 200) {
      if (trackOps) {
        this.ops ??= newGroupOps(now)
        recordMembershipRequest(this.ops, g.members, g.members[r[1].memberId], now)
      }
      await this.persist()
      if (trackOps) await this.flushOps(groupId, now, true)
    }
    return r
  }

  async authed(route, a, b, ver, trackOps = false, now = Date.now()) {
    const g = await this.load()
    const mem = await core.findMember(g, a.memberId, a.key)
    if (!mem) return [401, { error: '金鑰無效' }]
    if (trackOps) {
      this.ops ??= newGroupOps(now)
      recordMembershipRequest(this.ops, g.members, mem, now)
      await this.flushOps(a.groupId, now)
    }
    // 要寫資料庫的事先記下來，最後同一個請求只寫一次（fix-6）：動態過期、版本要單獨存（一小時內最多一次，見 core.noteVer）、這個路由自己的變動
    const expired = core.expireActivity(g, now, this.ttl)
    const verWrite = core.noteVer(mem, ver, now)
    const dirty = expired || verWrite
    let saved = false
    const save = async () => {
      await this.persist()
      saved = true
    }
    try {
      if (route === 'POST /status') {
        const [code, obj, isDirty] = core.status(g, a.memberId, mem, b, now)
        if (isDirty) await save()
        return [code, obj]
      }
      if (route === 'GET /friends') return [200, core.friendsView(g, a.memberId, now)]
      if (route === 'POST /invite/rotate' || route === 'POST /kick') {
        const r = route === 'POST /kick' ? await core.kick(g, a.groupId, a.memberId, b) : await core.rotateInvite(g, a.groupId, a.memberId)
        if (r[0] === 200) await save()
        return r
      }
      // POST /leave：群組空了整組刪（sec-3）
      const { reply, isEmpty } = core.leave(g, a.memberId)
      if (isEmpty) {
        await this.ctx.storage.deleteAlarm()
        await this.ctx.storage.deleteAll()
        this.g = null
        saved = true // 整組都刪了，沒有東西要補存
      } else await save()
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
