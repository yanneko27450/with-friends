// Claude 好友動態：Cloudflare Worker 版中繼（relay-2）。API 和 relay/server.mjs 一樣，邏輯共用 relay/core.mjs。
// 一個群組＝一個 SQLite 版 Durable Object（relay/COST.md）：在線狀態（每次心跳）只放記憶體，
// 只有建群組、加入、踢人、離開、換邀請碼、動態換了才寫入，免費額度的寫入量才夠。
// 本機：cd relay/worker && npx wrangler dev；測試：node relay/test.mjs --base http://127.0.0.1:8787
import { DurableObject } from 'cloudflare:workers'
import * as core from '../../core.mjs'

const json = (code, obj) =>
  new Response(JSON.stringify(obj), { status: code, headers: { 'content-type': 'application/json; charset=utf-8' } })

// 每個 isolate 各算各的，盡力而為；真要擋濫用用 Cloudflare 的 WAF／Rate Limiting 規則
const limited = core.makeLimiter()

async function readBody(request) {
  if (Number(request.headers.get('content-length') ?? 0) > core.MAX_BODY) throw new Error('too large')
  const raw = await request.text()
  if (raw.length > core.MAX_BODY) throw new Error('too large')
  return raw ? JSON.parse(raw) : {}
}

const groupOf = (env, groupId) => env.GROUP.get(env.GROUP.idFromName(groupId))

export default {
  async fetch(request, env) {
    const ip = request.headers.get('cf-connecting-ip') ?? ''
    try {
      if (limited('ip:' + ip, 600, 60_000)) return json(429, { error: '請求太頻繁' })
      const route = `${request.method} ${new URL(request.url).pathname}`
      if (route === 'GET /health') return json(200, { ok: true })
      const b = request.method === 'POST' ? await readBody(request) : {}
      if (route === 'POST /groups') {
        const r = await core.createGroup(b, Date.now())
        if (r.error) return json(...r.error)
        await groupOf(env, r.groupId).init(r.g)
        return json(...r.reply)
      }
      if (route === 'POST /join') {
        const groupId = core.groupIdOfInvite(core.clean(b.invite, 200))
        if (!core.GROUP_ID_RE.test(groupId)) return json(403, { error: '邀請碼不對或已失效' })
        return json(...(await groupOf(env, groupId).join(groupId, b, ip)))
      }
      if (!AUTHED.has(route)) return json(404, { error: 'not found' })
      const a = core.parseAuth(request.headers.get('authorization'))
      if (!a || !core.GROUP_ID_RE.test(a.groupId)) return json(401, { error: '金鑰無效' })
      return json(...(await groupOf(env, a.groupId).authed(route, a, b)))
    } catch {
      return json(400, { error: '請求格式錯誤' })
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
      const g = (await this.ctx.storage.get('group')) ?? null
      // 連線（在線狀態）不存，重啟後等下一次心跳補回來
      if (g) for (const m of Object.values(g.members)) m.conns = {}
      this.g = g
    }
    return this.g
  }

  async persist() {
    const members = Object.fromEntries(Object.entries(this.g.members).map(([id, { conns, ...m }]) => [id, m]))
    await this.ctx.storage.put('group', { ...this.g, members })
    await this.scheduleExpiry()
  }

  async init(g) {
    if (await this.load()) throw new Error('群組 id 撞了')
    for (const m of Object.values(g.members)) m.conns ??= {}
    this.g = g
    await this.persist()
  }

  async join(groupId, b, ip) {
    if (this.limited('join:' + ip, 10, 3_600_000)) return [429, { error: '嘗試太多次，一小時後再試' }]
    const g = await this.load()
    const r = await core.join(g, groupId, b, Date.now())
    if (r[0] === 200) await this.persist()
    return r
  }

  async authed(route, a, b) {
    const g = await this.load()
    const mem = await core.findMember(g, a.memberId, a.key)
    if (!mem) return [401, { error: '金鑰無效' }]
    const now = Date.now()
    if (core.expireActivity(g, now, this.ttl)) await this.persist()
    if (route === 'POST /status') {
      const [code, obj, isDirty] = core.status(g, a.memberId, mem, b, now)
      if (isDirty) await this.persist()
      return [code, obj]
    }
    if (route === 'GET /friends') return [200, core.friendsView(g, a.memberId, now)]
    if (route === 'POST /invite/rotate' || route === 'POST /kick') {
      const r = route === 'POST /kick' ? await core.kick(g, a.groupId, a.memberId, b) : await core.rotateInvite(g, a.groupId, a.memberId)
      if (r[0] === 200) await this.persist()
      return r
    }
    // POST /leave：群組空了整組刪（sec-3）
    const { reply, isEmpty } = core.leave(g, a.memberId)
    if (isEmpty) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      this.g = null
    } else await this.persist()
    return reply
  }
}
