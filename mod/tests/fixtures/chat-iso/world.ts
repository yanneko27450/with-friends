// mod/tests/fixtures/chat-iso/world.ts
// CHAT4-ISO：測試用的假引擎。用 on('*') 攔下外掛發出的每一個 op，逐一記錄，再依 exits.ts 的歸類掃描標記。
//
// 用法（chat-iso.test.ts）：
//   const w = isoWorld(on)                       // 先於任何外掛動作呼叫
//   await subject.deliver($, message)            // 把帶標記的訊息放進記憶體 atom
//   ...跑各種情境...
//   expect(w.violations(markers)).toEqual([])    // 任何出口出現標記就失敗
//
// 這裡不改外掛行為：只觀察、並用記憶體回答 $.store 和 $.clock。

import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { classifyOp, ruleOf } from './exits'
import type { Channel } from './exits'
import { needlesOf, scanValue } from './markers'
import type { Hit, Marker, Needle } from './markers'

/** 聊天的記憶體 atom：唯一允許存放聊天文字的 state 項（設計短文 §3）。CHAT-4 照這個名字做 */
export const CHAT_ATOM = { plugin: 'with-friends', key: 'chat' } as const

export type Rec = Readonly<{
  /** 事件名，例如 ui.toast */
  op: string
  /** 序號，從 1 起 */
  n: number
  /** 呼叫的參數（原樣引用，不複製） */
  input: unknown
  /** 回應（render 類是畫面樹；出錯記在 error） */
  result?: unknown
  error?: unknown
}>

export type Violation = Readonly<{
  marker: string
  channel: Channel | 'unknown-op' | 'extra-atom'
  op: string
  n: number
  /** 在參數（input）還是回應（result）裡 */
  where: 'input' | 'result'
  path: string
  variant: Hit['variant']
  via: string
  window: string
}>

export type IsoOptions = Readonly<{
  /** 一開始 $.store 裡有的東西（例如已加入群組的資料） */
  store?: Readonly<Record<string, unknown>>
  /** 時鐘起點 */
  now?: number
  /** 允許出現聊天文字的畫面（ui.render 的 requestId）；預設 'chat' */
  renderId?: string
  /**
   * 聊天分頁和別的分頁共用同一個 requestId 時（例如真外掛只有一個 'friends' 面板）：只有 props.key 以這個前綴開頭的子樹算聊天分頁，
   * 其餘部分照「別的畫面」處理。沒給＝整棵 renderId 的樹都算聊天分頁。建議聊天分頁用獨立的 requestId，這個只是退路
   */
  chatKeyPrefix?: string
  /** 允許存放聊天文字的記憶體 atom；預設 CHAT_ATOM */
  atom?: Readonly<{ plugin: string; key: string }>
  /** 外掛自己有登記、本來就會出現的 op（例如 CHAT-4 加了新 op 要先歸類）；一般不要用 */
  tolerateUnknownOps?: boolean
}>

/** A6 的網路白名單：「只是看」的情境裡，外掛只准對中繼的這幾條路徑、帶這幾個欄位的 body 發請求 */
export type NetworkAllow = Readonly<{
  origin: string
  paths: readonly string[]
  /** 每條路徑 body（JSON）允許的欄位；沒列＝body 必須是空的或 {} */
  bodyKeys?: Readonly<Record<string, readonly string[]>>
  /** 允許出現的其他 op（例如外掛平常會跑的 process.run 更新檢查）；一般不要用 */
  allowOps?: readonly string[]
}>

export type IsoWorld = Readonly<{
  records: readonly Rec[]
  clock: ReturnType<typeof mock.clock>
  store: Record<string, unknown>
  /** 把「外層 hook 答掉、on('*') 看不到」的結果補記進來：指令回傳文字、畫面樹（$.ui.mount().drawn()）、hook 的回答。框架自測也用它塞合成紀錄 */
  observe: (op: string, input: unknown, result?: unknown) => Rec
  /** 看過、但 exits.ts 沒歸類的 op（新增的出口） */
  unknownOps: () => string[]
  /** 到目前為止，出口的紀錄（不含聊天分頁的畫面） */
  exits: () => Rec[]
  /**
   * 掃描：任何出口（參數，以及外掛自己產生的回應）、別的畫面、聊天 atom 以外的 state 裡出現標記的地方。
   */
  violations: (markers: readonly Marker[]) => Violation[]
  /** A6：一段紀錄裡有沒有「看」的時候發出的對外請求（連結預覽、已讀回條、子行程、MCP、模型），不管有沒有文字 */
  networkEscapes: (recs: readonly Rec[], allow: NetworkAllow) => string[]
  /** 聊天分頁的畫面樹裡有沒有不該有的元素（Markdown、Link、Image、Client…）或網址屬性（href／src…） */
  treeProblems: () => string[]
  /** 在聊天分頁的畫面樹裡找得到標記嗎（正向對照：證明測試不是空轉） */
  rendered: (markers: readonly Marker[]) => Hit[]
  /** 目前紀錄數，給「只看這一段」用 */
  mark: () => number
  since: (mark: number) => Rec[]
  /** 外掛 hook 拿到的 $（測試本身的 $ 沒有 ui.toast 這類外掛專用呼叫） */
  hook$: () => any
  /** 目前開著的面板 id（$.ui.panes() 的答案）。測試裡 $.ui.mount 不算 open，所以由情境自己加進去、拿掉 */
  panes: Set<string>
  /** 假中繼：決定 $.http.fetch 的回應（預設 200 {"ok":true}） */
  fetch: { handler: (url: string, init: unknown) => { status: number; text: string; headers?: Record<string, string> } }
}>

const sameAtom = (e: unknown, atom: Readonly<{ plugin: string; key: string }>): boolean => {
  const o = e as { plugin?: unknown; key?: unknown } | null
  return !!o && o.plugin === atom.plugin && o.key === atom.key
}

/** 聊天分頁允許的元素。Markdown 用跟助理回覆同一個 renderer、Link 可以是任何 scheme、Client 跑外掛自己的畫面模組、Image 會抓圖：都不准 */
export const CHAT_TREE_ALLOWED = ['Box', 'Text', 'Button', 'Input'] as const
const URLISH_PROP = /^(href|url|uri|src|source|link|image|icon)$/i

type TreeNode = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] } & Record<string, unknown>
const isNode = (v: unknown): v is TreeNode => typeof v === 'object' && v !== null && !Array.isArray(v)
const keyOf = (n: TreeNode): string => (typeof n.props?.key === 'string' ? n.props.key : typeof n.key === 'string' ? n.key : '')

/** 把樹分成「聊天子樹」和「其餘」。沒有前綴＝整棵都是聊天 */
export function splitChatTree(tree: unknown, prefix: string | undefined): { chat: unknown[]; rest: unknown } {
  if (!prefix) return { chat: [tree], rest: null }
  const chat: unknown[] = []
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip)
    if (!isNode(v)) return v
    if (keyOf(v).startsWith(prefix)) { chat.push(v); return null }
    const out: TreeNode = { ...v }
    if (Array.isArray(v.children)) out.children = v.children.map(strip)
    return out
  }
  return { chat, rest: strip(tree) }
}

export function isoWorld(on: On, opts: IsoOptions = {}): IsoWorld {
  const records: Rec[] = []
  const store: Record<string, unknown> = { lang: 'en', ...(opts.store ?? {}) }
  const renderId = opts.renderId ?? 'chat'
  const chatAtom = opts.atom ?? CHAT_ATOM

  // 注意：先登記的在最外層。on('*') 必須是這個世界的第一個 hook，才看得到後面每個 hook（含 mock.store）答掉的呼叫。
  // 這個攔截不改任何回傳值，只記錄。
  let hookDollar: any
  on('*', async ($, e, next) => {
    const op = (next as { event?: string }).event ?? 'unknown'
    const rec: { -readonly [K in keyof Rec]: Rec[K] } = { op, n: records.length + 1, input: e }
    records.push(rec)
    try {
      const r = await next(e)
      rec.result = r
      return r
    } catch (err) {
      rec.error = err
      throw err
    }
  })

  const clock = mock.clock(on, { now: opts.now ?? 1_000_000 })
  mock.store(on, store)

  // 內層的假處理函式：只讓外掛的呼叫有個合理的答案，不做任何判斷（判斷全在上面的 on('*') 記錄＋掃描）
  const fetchState: { handler: (url: string, init: unknown) => { status: number; text: string; headers?: Record<string, string> } } = {
    handler: () => ({ status: 200, text: '{"ok":true}' }),
  }
  on('http.fetch', ($, e) => {
    const ev = e as { url: string; init?: unknown }
    const r = fetchState.handler(ev.url, ev.init)
    return { value: { status: r.status, ok: r.status < 400, headers: r.headers ?? {}, text: r.text } } as never
  })
  // 這個 hook 的 $ 就是「外掛 hook 的 $」。呼叫它會跳過這個 hook 自己、但會經過上面的 on('*')，所以用它來替被測模組發出呼叫。
  // （不能用 on('*') 自己的 $：呼叫會跳過它，記錄就漏了。）
  // 引擎事件：先交給下面的 hook（別的外掛、被測模組自己的 hook），沒人答才由這裡補一個預設答案
  const orElse = async (next: (e: never) => unknown, e: unknown, fallback: unknown) => {
    try { return await next(e as never) } catch { return fallback }
  }
  on('session.start', ($, e, next) => orElse(next as never, e, { cwd: (e as { cwd: string }).cwd }) as never)
  on('session.end', ($, e, next) => orElse(next as never, e, { sessionId: (e as { sessionId: string }).sessionId }) as never)
  // 外掛可以用 hook 回答的引擎事件（回答會進模型）：沒人答時給原樣的預設答案，好讓探測（subject.ts 的 PROBES）呼叫得動
  on('prompt.section', ($, e, next) => orElse(next as never, e, { text: (e as { text: string | null }).text }) as never)
  on('prompt.context', ($, e, next) => orElse(next as never, e, { blocks: (e as { blocks: unknown[] }).blocks }) as never)
  on('attribution.text', ($, e, next) => orElse(next as never, e, { text: (e as { text: string }).text }) as never)
  on('skill.prompt', ($, e, next) => orElse(next as never, e, { text: (e as { text: string }).text }) as never)
  on('session.cwd', () => ({ value: 'D:/work/site' }) as never)
  on('turn.start', ($, e, next) => orElse(next as never, e, { turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', ($, e, next) => orElse(next as never, e, { text: '' }) as never)
  on('command.register', () => ({ value: { command: 'friends' } }) as never)
  for (const op of ['ui.open', 'ui.close', 'ui.toast', 'ui.notify', 'ui.notice', 'ui.status', 'ui.log', 'ui.invalidate'] as const) {
    on(op, () => ({ value: undefined }) as never)
  }
  on('ui.focus', () => ({}) as never)
  const panes = new Set<string>()
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }) as never)
  on('ui.copy', () => ({ value: { isCopied: true } }) as never)
  on('fs.read', ($, e) => {
    const path = (e as { path: string }).path.split('\\').join('/')
    if (path.endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ name: 'with-friends', version: '0.0.0' }) } as never
    throw new Error('ENOENT ' + path)
  })
  on('fs.exists', () => ({ value: false }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('model.classify', () => ({ value: undefined }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)

  const observe = (op: string, input: unknown, result?: unknown): Rec => {
    const rec: Rec = { op, n: records.length + 1, input, result }
    records.push(rec)
    return rec
  }

  const isChatRender = (rec: Rec): boolean => rec.op === 'ui.render' && (rec.input as { requestId?: string } | undefined)?.requestId === renderId

  const exits = () => records.filter(r => classifyOp(r.op) === 'exit' && !isChatRender(r))

  const violations = (markers: readonly Marker[]): Violation[] => {
    const needles: Needle[] = markers.flatMap(needlesOf)
    const out: Violation[] = []
    const add = (rec: { op: string; n: number }, channel: Violation['channel'], where: Violation['where'], hits: Hit[], prefix = '') => {
      for (const h of hits) out.push({ marker: h.marker, channel, op: rec.op, n: rec.n, where, path: prefix + h.path, variant: h.variant, via: h.via, window: h.window })
    }
    for (const rec of records) {
      const rule = ruleOf(rec.op)
      if (!rule) {
        if (classifyOp(rec.op) === undefined && !opts.tolerateUnknownOps) out.push({ marker: '-', channel: 'unknown-op', op: rec.op, n: rec.n, where: 'input', path: '$', variant: 'plain', via: 'direct', window: '' })
        continue
      }
      if (rec.op === 'ui.render') {
        // 聊天分頁以外的畫面（含同一棵樹裡聊天子樹以外的部分）不准有聊天文字
        const { rest } = isChatRender(rec) ? splitChatTree(rec.result, opts.chatKeyPrefix) : { rest: rec.result }
        add(rec, 'render', 'result', scanValue(rest, needles, '$.tree'))
        continue
      }
      // 聊天 atom 的寫入是唯一允許存放聊天文字的 state；寫到別的 atom 就是違規
      if (rec.op === 'state.set') {
        if (sameAtom(rec.input, chatAtom)) continue
        const o = rec.input as { plugin?: string; key?: string; value?: unknown }
        add(rec, 'extra-atom', 'input', scanValue(o.value, needles, '$.value'), `${o.plugin}/${o.key}`)
        continue
      }
      if (!rule.resultOnly) add(rec, rule.channel, 'input', scanValue(rec.input, needles))
      if (!rule.externalResult && rec.result !== undefined) add(rec, rule.channel, 'result', scanValue(rec.result, needles))
    }
    // 同一處只報一次
    const seen = new Set<string>()
    return out.filter(v => {
      const k = `${v.marker}|${v.channel}|${v.op}|${v.n}|${v.where}|${v.path}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }

  const ESCAPE_OPS = ['process.run', 'process.spawn', 'mcp.call', 'mcp.connect', 'model.classify', 'model.complete', 'model.fork']
  const networkEscapes = (recs: readonly Rec[], allow: NetworkAllow): string[] =>
    recs.flatMap(r => {
      if (allow.allowOps?.includes(r.op)) return []
      if (ESCAPE_OPS.includes(r.op)) return [`${r.op} ${JSON.stringify(r.input).slice(0, 100)}`]
      if (r.op !== 'http.fetch') return []
      const input = r.input as { url?: unknown; init?: { method?: string; body?: unknown } }
      const url = String(input?.url ?? '')
      const label = `${input?.init?.method ?? 'GET'} ${url.slice(0, 120)}`
      let u: URL | undefined
      try { u = new URL(url) } catch { return [label] }
      // 完整比對：來源、路徑、沒有 query；body 只准白名單欄位
      if (u.origin !== allow.origin || !allow.paths.includes(u.pathname) || u.search !== '' || u.hash !== '') return [label]
      const body = input?.init?.body
      if (body === undefined || body === '' || body === null) return []
      let parsed: unknown
      try { parsed = JSON.parse(String(body)) } catch { return [`${label} (body 不是 JSON)`] }
      if (!isNode(parsed)) return [`${label} (body 不是物件)`]
      const okKeys = allow.bodyKeys?.[u.pathname] ?? []
      const extra = Object.keys(parsed).filter(k => !okKeys.includes(k))
      return extra.length ? [`${label} (body 多了欄位 ${extra.join(',')})`] : []
    })

  /** 聊天分頁的畫面樹（記錄裡所有 requestId = renderId 的樹，取其聊天部分） */
  const chatTrees = (): { rec: Rec; parts: unknown[] }[] =>
    records.filter(isChatRender).filter(r => r.result !== undefined).map(rec => ({ rec, parts: splitChatTree(rec.result, opts.chatKeyPrefix).chat }))

  const treeProblems = (): string[] => {
    const out = new Set<string>()
    const walk = (v: unknown, rec: Rec): void => {
      if (Array.isArray(v)) { v.forEach(x => walk(x, rec)); return }
      if (!isNode(v)) return
      if (typeof v.type === 'string' && !(CHAT_TREE_ALLOWED as readonly string[]).includes(v.type)) out.add(`元素 ${v.type} 不在聊天分頁的白名單（${CHAT_TREE_ALLOWED.join('/')}）`)
      for (const k of Object.keys(v.props ?? {})) if (URLISH_PROP.test(k)) out.add(`元素 ${String(v.type)} 有網址類屬性 ${k}`)
      for (const k of Object.keys(v)) if (URLISH_PROP.test(k)) out.add(`元素 ${String(v.type)} 有網址類欄位 ${k}`)
      if (Array.isArray(v.children)) v.children.forEach(x => walk(x, rec))
    }
    for (const { rec, parts } of chatTrees()) walk(parts, rec)
    return [...out]
  }

  const rendered = (markers: readonly Marker[]): Hit[] => {
    const needles = markers.flatMap(needlesOf)
    return chatTrees().flatMap(({ parts }) => scanValue(parts, needles, '$.tree'))
  }

  return {
    records,
    clock,
    store,
    observe,
    unknownOps: () => [...new Set(records.map(r => r.op).filter(op => classifyOp(op) === undefined))],
    exits,
    violations,
    rendered,
    networkEscapes,
    treeProblems,
    mark: () => records.length,
    hook$: () => hookDollar,
    fetch: fetchState,
    panes,
    since: (mark: number) => records.slice(mark),
  }
}
