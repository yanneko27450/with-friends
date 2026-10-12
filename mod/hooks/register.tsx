// Friends with Claude：側邊 pane 看好友在不在線、正在用 Claude 做哪一類事。
// 借鑑 SaharCarmel/claude-who（MIT，邀請碼＋每人金鑰）與 chrisluo5311/squad-chat（MIT，pane 內容不進對話）。
// 送出去的動態只有 taxonomy.ts 的兩個代碼；好友傳來的任何文字只畫在 pane，絕不進對話。

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Friend, GroupView, Me, Membership, Net, StatusBody, UpdateView } from '../types'
import { avatarSvg } from './avatar'
import { t } from './i18n'
import type { Strings } from './i18n'
import { redact } from './redact'
import { ACTIONS, activityText, isAction, isSubject, LANGS, SUBJECTS } from './taxonomy'
import type { Action, Lang, Subject } from './taxonomy'
import { cleanName } from './text'

const PANE = 'friends'
/** 官方中繼（ui-18 D：原本是本機開發用的 127.0.0.1:8789，新使用者直接 create 會失敗） */
export const DEFAULT_RELAY = 'https://friends-status-relay.friends-status-relay.workers.dev'
const TICK_MS = 10_000
// 請求量（relay/COST.md）：pane 開著每 15 秒送一次狀態並從回應拿好友列表；pane 關著只每 60 秒送心跳
const PULL_MS = 15_000
const HEARTBEAT_MS = 60_000
/** 走使用者自己的額度：同一 session 至少隔 3 分鐘才分類一次（core-4） */
export const CLASSIFY_GAP_MS = 180_000

// plugin／key 要寫字面字串，validate 才讀得到
const friends = atom({ plugin: 'with-friends', key: 'friends' } as const, [] as Friend[])
const me = atom({ plugin: 'with-friends', key: 'me' } as const, {
  state: 'idle', action: '', subject: '', pending: '', isPaused: false, isHidden: false,
} as Me)
const net = atom({ plugin: 'with-friends', key: 'net' } as const, { isOk: true, error: '', at: 0 } as Net)
const group = atom({ plugin: 'with-friends', key: 'group' } as const, null as GroupView | null)
const lang = atom({ plugin: 'with-friends', key: 'lang' } as const, 'en' as Lang)
const upd = atom({ plugin: 'with-friends', key: 'update' } as const, { latest: '', state: 'idle' } as UpdateView)

let isBusy = false
let lastPushAt = 0
let lastPushed = ''
let lastClassifyAt = -Infinity
/** 這個對話的連線 id：membership 存在 $.store、所有對話共用，中繼靠它分辨同一個人的不同對話 */
let conn = ''
/** 這個對話上次送出的動態；一樣的不再送，免得舊對話的心跳蓋掉別的對話新分類出的動態 */
let sentActivity = ''
/** 這個對話的好友 pane 開著嗎（關著就不拉好友列表） */
let isPaneOpen = false

async function getMembership($: EngineInterface): Promise<Membership | undefined> {
  return (await $.store.get('membership')) as Membership | undefined
}
async function hiddenDirs($: EngineInterface): Promise<string[]> {
  return ((await $.store.get('hidden')) as string[] | undefined) ?? []
}
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
/**
 * 邀請字串（relay-5）：「中繼網址#邀請碼」，朋友貼一次就好，不用先設中繼；
 * 也收舊格式的純邀請碼（用目前設定的中繼）。網址只收 http(s)，其他一律當格式錯
 */
export function parseInvite(raw: string, fallbackRelay: string): { relay: string; invite: string } | null {
  // 複製出去的是「/friends join <連結>」：整行貼進 pane 也收
  const joinCmd = /^\/friends\s+join\s+(\S+)/i.exec(raw.trim())
  if (joinCmd) raw = joinCmd[1]!
  const m = /^(https?:\/\/[^\s#]+)#([^\s#]+)$/.exec(raw)
  if (m) return { relay: m[1]!.replace(/\/+$/, ''), invite: m[2]! }
  // 純邀請碼只收 [A-Za-z0-9_.-]（中繼產生的就是這些字），貼錯的句子、網址片段都擋掉
  if (!/^[\w.-]{4,200}$/.test(raw)) return null
  return { relay: fallbackRelay, invite: raw }
}
export const inviteLink = (relay: string, invite: string) => `${relay.replace(/\/+$/, '')}#${invite}`
export const joinLine = (link: string) => `/friends join ${link}`
export const marketplaceUrl = (relay: string) => `${relay.replace(/\/+$/, '')}/marketplace.json`

export function isHiddenDir(cwd: string, dirs: string[]): boolean {
  const c = norm(cwd)
  return dirs.some(d => c === norm(d) || c.startsWith(norm(d) + '/'))
}

/**
 * 中繼出錯只留狀態碼（ui-18 B）：中繼回的錯誤文字可能是惡意的，而指令的錯誤訊息會進對話＝提示注入。
 * 0＝連不上、-1＝中繼回的東西格式不對、-2＝外掛自己出錯
 */
export class RelayError extends Error {
  status: number
  constructor(status: number) {
    super(`relay ${status}`)
    this.status = status
  }
}
/** 給人看的錯誤：一律是 i18n 裡的固定句子 */
export const errorText = (err: unknown, s: Strings) => s.relayError(err instanceof RelayError ? err.status : -2)

async function relayCall($: EngineInterface, relay: string, method: 'GET' | 'POST', path: string, body?: unknown, auth?: Membership): Promise<any> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (auth) headers.authorization = `Bearer ${auth.groupId}.${auth.memberId}.${auth.memberKey}`
  let res
  try {
    res = await $.http.fetch(relay.replace(/\/+$/, '') + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new RelayError(0)
  }
  if (!res.ok) throw new RelayError(Number(res.status) || -1)
  let data: unknown
  try { data = JSON.parse(res.text) } catch { throw new RelayError(-1) }
  if (typeof data !== 'object' || data === null) throw new RelayError(-1)
  return data
}

// 中繼產生的 id、金鑰、邀請碼都是 base64url 加「.」（relay/core.mjs token／newInvite）
const TOKEN_RE = /^[\w.-]{1,200}$/
const isToken = (v: unknown): v is string => typeof v === 'string' && TOKEN_RE.test(v)

/** 中繼回的成員資料只挑認得的欄位、檢查格式；中繼網址與名字用本機的，中繼回什麼都蓋不掉 */
export function membershipFrom(r: any, relay: string, name: string): Membership {
  if (!isToken(r.groupId) || !isToken(r.memberId) || !isToken(r.memberKey) || !isToken(r.invite)) throw new RelayError(-1)
  return {
    relay, name, groupId: r.groupId, memberId: r.memberId, memberKey: r.memberKey, invite: r.invite,
    groupName: cleanName(r.groupName, 30), isOwner: r.isOwner === true,
  }
}

// ---- 外掛更新（ui-19，主人 10-12「AB都要」）----
// 朋友從 workers.dev 加的市集預設不會自動更新（官方只有官方市集預設自動更新），所以外掛自己看有沒有新版：
// A 面板顯示「有新版」＋按鈕；B 加入時問一次，同意的人開新對話時自己在背景更新。
// 不改朋友的 Claude 設定檔（known_marketplaces.json 的 autoUpdate），只跑 claude plugin 的兩個官方指令。

const SEMVER_RE = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/
/** 隔多久再看一次中繼上的版本（同一個對話裡） */
export const UPDATE_CHECK_MS = 6 * 3_600_000
/** 別的對話剛開始更新：這段時間內不重跑 */
const UPDATE_LOCK_MS = 10 * 60_000
let lastUpdateCheckAt = -Infinity

/** remote 比 local 新嗎；任一個不是 x.y.z 就當不新（中繼回怪字串不提示） */
export function isNewer(remote: string, local: string): boolean {
  const a = SEMVER_RE.exec(remote)
  const b = SEMVER_RE.exec(local)
  if (!a || !b) return false
  for (let i = 1; i <= 3; i++) {
    const d = Number(a[i]) - Number(b[i])
    if (d !== 0) return d > 0
  }
  return false
}
const bySemverDesc = (x: string, y: string) => (isNewer(x, y) ? -1 : isNewer(y, x) ? 1 : 0)

/** 自己的版本：讀 plugin.json（版本號只寫在那裡），讀不到＝''（不提示更新） */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const v = JSON.parse(String(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))).version
    return typeof v === 'string' && SEMVER_RE.test(v) ? v : ''
  } catch {
    return ''
  }
}

/**
 * 朋友當初安裝的市集（~/.claude/plugins/known_marketplaces.json 的 with-friends）：版本從這裡查，
 * 更新指令更新的也是這裡，兩邊才一致（ui-19 審查 ⑤：原本看群組中繼，第三方中繼會一直說有新版、更新卻沒變）。
 * 用 CLAUDE_CODE_PLUGIN_DIRS 載入的開發版沒有這筆 → 不查、不問、不更新
 */
async function installedMarketplace($: EngineInterface): Promise<{ url: string } | { file: string } | null> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home ? `${home}/.claude` : '')
  if (!dir) return null
  try {
    const known = JSON.parse(String(await $.fs.read(`${dir}/plugins/known_marketplaces.json`))) as Record<string, { source?: Record<string, unknown> }>
    const src = known['with-friends']?.source
    if (src?.source === 'url' && typeof src.url === 'string' && /^https?:\/\/\S+$/.test(src.url)) return { url: src.url }
    if (src?.source === 'directory' && typeof src.path === 'string') return { file: `${src.path}/.claude-plugin/marketplace.json` }
  } catch { /* 沒從市集裝 */ }
  return null
}

/** 看安裝來源的 marketplace.json：只取 with-friends 的版本字串，比自己新才記下來。讀不到就算了，不打擾 */
async function checkUpdate($: EngineInterface): Promise<string> {
  try {
    const local = await ownVersion($)
    if (!local) return ''
    const market = await installedMarketplace($)
    if (!market) return ''
    let text: string
    if ('url' in market) {
      const res = await $.http.fetch(market.url, { method: 'GET' })
      if (!res.ok) return ''
      text = res.text
    } else {
      text = String(await $.fs.read(market.file))
    }
    const plugins = (JSON.parse(text) as { plugins?: unknown }).plugins
    const entry = Array.isArray(plugins) ? plugins.find(p => p && (p as { name?: unknown }).name === 'with-friends') : undefined
    const remote = entry ? String((entry as { version?: unknown }).version ?? '') : ''
    const latest = isNewer(remote, local) ? remote : ''
    await update($, upd, v => ({ ...v, latest }))
    return latest
  } catch {
    return ''
  }
}

/**
 * 找 claude 執行檔：引擎裡沒有 CLAUDE_CODE_EXECPATH（ui-19 探測），只裝桌面版的人 PATH 上也沒有 claude。
 * Windows 先找桌面版內附的最新一支（%APPDATA%\Claude\claude-code\<版本>\<資料夾>\claude.exe），找不到才用 PATH 上的 claude
 */
async function findClaude($: EngineInterface): Promise<string> {
  const appdata = await $.env.get('APPDATA')
  if (appdata) {
    const base = `${appdata}\\Claude\\claude-code`
    try {
      const versions = (await $.fs.list(base)).filter(d => d.kind === 'dir' && SEMVER_RE.test(d.name)).map(d => d.name).sort(bySemverDesc)
      for (const v of versions) {
        for (const d of await $.fs.list(`${base}\\${v}`)) {
          const exe = `${base}\\${v}\\${d.name}\\claude.exe`
          if (d.kind === 'dir' && (await $.fs.exists(exe))) return exe
        }
      }
    } catch { /* 沒裝桌面版 */ }
  }
  return 'claude'
}

/**
 * 跑官方的兩個指令：先更新市集清單，再更新外掛。指令的輸出不顯示（裡面可能有中繼傳來的文字）。
 * cwd 固定在外掛自己的資料夾（ui-19 審查 ⑥：不要在朋友的專案資料夾裡找 claude、讀專案層級的設定）
 */
async function runUpdate($: EngineInterface): Promise<boolean> {
  try {
    const exe = await findClaude($)
    for (const args of [['plugin', 'marketplace', 'update', 'with-friends'], ['plugin', 'update', 'with-friends@with-friends']]) {
      // stdin 給空字串：不要接到引擎自己的輸入（桌面版的引擎是串流輸入）
      const r = await $.process.run([exe, ...args], { cwd: $.plugin.root, stdin: '', timeoutMs: 120_000 })
      if (r.exitCode !== 0) return false
    }
    return true
  } catch {
    return false
  }
}

/** 這個對話正在跑更新：在第一個 await 之前設好，連按兩下也只跑一組（ui-19 審查 ④） */
let isUpdatingHere = false

/**
 * 更新一次：同一人好幾個對話同時開時，靠 $.store 的鎖（時間＋隨機 token，寫完再讀一次確認是自己的）只讓一個對話跑。
 * busy＝別的對話正在更新（或剛被關掉、鎖還沒過期），不要報成失敗（ui-19 實測：-p 結束時背景更新被中斷，留下鎖）。
 * 出錯也一定解鎖、狀態不會卡在「更新中」（ui-19 審查 ③）
 */
async function doUpdate($: EngineInterface): Promise<'ok' | 'failed' | 'busy'> {
  if (isUpdatingHere) return 'busy'
  isUpdatingHere = true
  try {
    const now = await $.clock.now()
    const lock = await $.store.get('updatingAt')
    const lockedAt = typeof lock === 'number' ? lock : typeof lock === 'object' && lock !== null ? Number((lock as { at?: unknown }).at) : NaN
    if (now - lockedAt < UPDATE_LOCK_MS) return 'busy'
    const token = crypto.randomUUID()
    await $.store.set('updatingAt', { at: now, token })
    if (((await $.store.get('updatingAt')) as { token?: unknown } | undefined)?.token !== token) return 'busy'
    await update($, upd, (v): UpdateView => ({ ...v, state: 'running' }))
    let isOk = false
    try {
      isOk = await runUpdate($)
    } finally {
      await update($, upd, (v): UpdateView => ({ ...v, state: isOk ? 'done' : 'failed' }))
      await $.store.delete('updatingAt')
    }
    return isOk ? 'ok' : 'failed'
  } finally {
    isUpdatingHere = false
  }
}

/** B：問一次要不要自動更新（加入或建立群組之後；問過就不再問；不是從市集裝的不問）。關掉框＝不開 */
async function askAutoUpdate($: EngineInterface, s: Strings) {
  if ((await $.store.get('autoUpdate')) !== undefined) return
  if (!(await installedMarketplace($))) return
  try {
    const answer = await $.ui.ask(s.askAutoUpdate, { header: s.askAutoUpdateHeader, options: [s.autoUpdateYes, s.autoUpdateNo] })
    if (answer === s.autoUpdateYes) await $.store.set('autoUpdate', true)
    if (answer === s.autoUpdateNo) await $.store.set('autoUpdate', false)
  } catch { /* 關掉框：之後可以 /friends autoupdate on，或 pane 上的「以後自動更新」 */ }
}

/**
 * 開對話時：看有沒有新版；同意自動更新的人就在背景更新（下一個新對話生效）。
 * 同一個版本只自動試一次：更新「成功」但版本沒變（來源不同步）時，不會每開一個對話就重跑（ui-19 審查 ⑤）
 */
async function updateOnStart($: EngineInterface) {
  lastUpdateCheckAt = await $.clock.now()
  const latest = await checkUpdate($)
  if (!latest || (await $.store.get('autoUpdate')) !== true || (await $.store.get('autoTried')) === latest) return
  if ((await doUpdate($)) !== 'busy') await $.store.set('autoTried', latest)
}

/** 好友列表只畫在 pane，但名字還是再清一次（舊版或別人架的中繼可能沒清） */
function friendsFrom(members: unknown[]): Friend[] {
  return members
    .filter((f): f is Friend => typeof f === 'object' && f !== null && typeof (f as Friend).id === 'string')
    .map(f => ({ ...f, name: cleanName(f.name, 20) || '?' }))
}

/**
 * 把（已在本機遮過的）指令分成 動作＋對象。
 * 不管模型回什麼、出不出錯，回傳的一定是清單內代碼：classify 會 reject（交接坑 3），
 * 回 undefined 或清單外字串都當 other。（$ 不能跨檔傳，所以放在這個檔）
 */
export async function classifyActivity($: EngineInterface, redacted: string): Promise<{ action: Action; subject: Subject }> {
  if (!redacted.trim()) return { action: 'other', subject: 'other' }
  let action: Action = 'other'
  let subject: Subject = 'other'
  try {
    const v = await $.model.classify(redacted, ACTIONS)
    if (isAction(v)) action = v
  } catch { /* 留 other */ }
  try {
    const v = await $.model.classify(redacted, SUBJECTS)
    if (isSubject(v)) subject = v
  } catch { /* 留 other */ }
  return { action, subject }
}

/** 我現在的動態：暫停＝沒有；不分享的資料夾＝other；其他＝分類出的兩個代碼（還沒分類＝沒有）。 */
export function activityOf(cur: Me): { action: Action; subject: Subject } | null {
  if (cur.isPaused) return null
  if (cur.isHidden) return { action: 'other', subject: 'other' }
  if (isAction(cur.action) && isSubject(cur.subject)) return { action: cur.action, subject: cur.subject }
  return null
}

/**
 * 要送給中繼的內容。同一個人可能同時開好幾個 Code 對話、各自送：
 * 動態只在這個對話有新的時候送一次，其餘只送心跳（中繼收到沒帶代碼＝保留舊動態）；
 * 暫停要明確送 paused，中繼才清掉動態。
 */
export function statusBody(cur: Me, connId: string, sent: string): StatusBody {
  if (cur.isPaused) return { state: cur.state, conn: connId, paused: true }
  const a = activityOf(cur)
  if (a && JSON.stringify(a) !== sent) return { state: cur.state, conn: connId, ...a }
  return { state: cur.state, conn: connId }
}

/** 暫停狀態存在 $.store、所有對話共用；暫停時連這個對話記著的動態一起清掉 */
function withPaused(v: Me, isPaused: boolean): Me {
  return isPaused ? { ...v, isPaused, pending: '', action: '', subject: '' } : { ...v, isPaused }
}

async function setGroup($: EngineInterface, m: Membership | undefined) {
  await update($, group, () => (m ? { name: m.groupName, invite: m.invite, isOwner: m.isOwner, relay: m.relay } : null))
}

/** 每 10 秒：必要時分類 → 送自己的狀態（變了、或 pane 開著滿 15 秒／關著滿 60 秒；force＝馬上送），回應裡帶好友列表 */
export async function tick($: EngineInterface, force = false) {
  if (isBusy) return
  isBusy = true
  const now = await $.clock.now()
  try {
    const m = await getMembership($)
    if (!m) return
    // 長時間開著的對話：每 6 小時再看一次有沒有新版（ui-19）
    if (now - lastUpdateCheckAt >= UPDATE_CHECK_MS) {
      lastUpdateCheckAt = now
      void checkUpdate($)
    }
    // 別的對話可能換了語言
    const l = await storedLang($)
    if (l !== (await read($, lang))) {
      await update($, lang, () => l)
      await retitle($, l)
    }
    let cur = await read($, me)
    // 別的對話可能按了暫停／繼續
    const isPaused = Boolean(await $.store.get('paused'))
    if (isPaused !== cur.isPaused) {
      await update($, me, v => withPaused(v, isPaused))
      if (isPaused) sentActivity = ''
      cur = await read($, me)
    }
    // 節流是「同一個人」不是「同一個對話」：上次分類時間存在共用的 $.store，開 3 個對話也不會 3 倍額度
    const shared = await $.store.get('classifiedAt')
    const lastAny = Math.max(lastClassifyAt, typeof shared === 'number' ? shared : -Infinity)
    if (cur.pending && !cur.isPaused && !cur.isHidden && now - lastAny >= CLASSIFY_GAP_MS) {
      lastClassifyAt = now
      await $.store.set('classifiedAt', now)
      const { action, subject } = await classifyActivity($, cur.pending)
      await update($, me, v => ({ ...v, action, subject, pending: '' }))
      // 新分類出來的一律送，就算和這個對話上次一樣（中間可能被別的對話換掉了）
      sentActivity = ''
      cur = await read($, me)
    }
    const body = statusBody(cur, conn, sentActivity)
    const signature = JSON.stringify({ state: body.state, paused: body.paused })
    const gap = isPaneOpen ? PULL_MS : HEARTBEAT_MS
    if (!(force || body.action || signature !== lastPushed || now - lastPushAt >= gap)) return
    // 送狀態的回應裡就有好友列表，不另外拉
    const data = await relayCall($, m.relay, 'POST', '/status', body, m)
    if (body.action) sentActivity = JSON.stringify({ action: body.action, subject: body.subject })
    lastPushed = signature
    lastPushAt = now
    if (Array.isArray(data.members)) await update($, friends, () => friendsFrom(data.members))
    await update($, net, () => ({ isOk: true, error: '', at: now }))
  } catch (err) {
    const error = errorText(err, t(await read($, lang)))
    await update($, net, () => ({ isOk: false, error, at: now }))
  } finally {
    isBusy = false
  }
}

const ORDER = { working: 0, idle: 1, offline: 2 } as const
const COLOR = { working: 'success', idle: 'warning', offline: 'inactive' } as const

function ago(sec: number | null, l: Lang): string {
  const s = t(l)
  if (sec === null) return ''
  if (sec < 60) return s.justNow
  if (sec < 3600) return s.minAgo(Math.floor(sec / 60))
  return s.hourAgo(Math.floor(sec / 3600))
}

export const langOf = (locale: string): Lang => (locale.toLowerCase().startsWith('zh') ? 'zh-TW' : 'en')

/**
 * ui-21：還沒選過語言時自己判斷（主人 10-12 選「自動判斷」）。先看 Claude 桌面版的介面語言
 * （config.json 只取 locale 一欄，其他不看不存）；沒有桌面版（只用終端機）再看終端機的 LANG（Mac／Linux），
 * 最後看電腦的地區設定。中文→繁中，其他→英文。主人這台 Windows 顯示語言是英文、地區與桌面版是中文，所以不看顯示語言
 */
async function detectLang($: EngineInterface): Promise<Lang> {
  const appdata = await $.env.get('APPDATA')
  const home = await $.env.get('HOME')
  const files = [appdata ? `${appdata}/Claude/config.json` : '', home ? `${home}/Library/Application Support/Claude/config.json` : '']
  for (const f of files.filter(Boolean)) {
    try {
      const locale = (JSON.parse(String(await $.fs.read(f))) as { locale?: unknown }).locale
      if (typeof locale === 'string' && locale) return langOf(locale)
    } catch { /* 沒裝桌面版、或讀不到 */ }
  }
  // LANG=C／POSIX（容器、CI）不算有設定
  for (const v of [await $.env.get('LC_ALL'), await $.env.get('LANG')]) {
    if (v && /^[a-z]{2}/i.test(v) && !/^posix/i.test(v)) return langOf(v)
  }
  try {
    return langOf(Intl.DateTimeFormat().resolvedOptions().locale)
  } catch {
    return 'en'
  }
}

/** 判斷一次就存進共用的 $.store，之後每個對話都一樣，也不會因為改了系統設定突然換掉 */
async function storedLang($: EngineInterface): Promise<Lang> {
  const v = (await $.store.get('lang')) as Lang | undefined
  if (v && LANGS.includes(v)) return v
  const l = await detectLang($)
  await $.store.set('lang', l)
  return l
}
async function setLang($: EngineInterface, l: Lang) {
  await $.store.set('lang', l)
  await update($, lang, () => l)
  await retitle($, l)
}
// 對開著的 pane 再 open 一次只會換標題，不會多開一個
async function retitle($: EngineInterface, l: Lang) {
  if (isPaneOpen) await $.ui.open({ id: PANE, title: t(l).title })
}
const nextLang = (l: Lang): Lang => LANGS[(LANGS.indexOf(l) + 1) % LANGS.length] ?? 'en'

async function setPaused($: EngineInterface, isPaused: boolean) {
  await $.store.set('paused', isPaused)
  await update($, me, v => withPaused(v, isPaused))
  if (isPaused) sentActivity = ''
}

/**
 * 問名字（主人 10-11：朋友只打一條指令，名字用問答框問）。外掛自己開 Claude 的問答框，
 * 不經過模型、不花額度；名字打在問答框的輸入欄。名字是使用者自己打的，不是好友傳來的文字。
 * 選「先不加入」、關掉、空白都回 null。（2.1.295 的問答框還沒有純文字題，所以附兩個選項）
 */
async function askName($: EngineInterface, s: Strings): Promise<string | null> {
  try {
    const answer = (await $.ui.ask(s.askName, { header: s.askNameHeader, options: [s.nameAnon, s.cancelJoin] })).trim()
    if (!answer || answer === s.cancelJoin) return null
    const name = cleanName(answer === s.nameAnon ? s.anonValue : answer, 20)
    return name || null
  } catch {
    return null
  }
}

// 按「複製邀請碼」先問朋友裝好了沒（主人 10-12 選 C 版）：裝好了只給加入指令，還沒就連安裝步驟一起給。關掉框＝不複製
// 安裝步驟可以選另一個語言（ui-21：主人 10-12 選「複製時多一個選項」），不用先切介面；加入那一行不分語言
async function inviteText($: EngineInterface, l: Lang, relay: string, link: string): Promise<{ text: string; toast: string } | null> {
  const s = t(l)
  try {
    const answer = await $.ui.ask(s.askInstalled, { header: s.askInstalledHeader, options: [s.installedYes, s.installedNo, s.installedNoOther] })
    if (answer === s.installedYes) return { text: joinLine(link), toast: s.copied }
    if (answer === s.installedNo) return { text: s.inviteMessage(marketplaceUrl(relay), joinLine(link)), toast: s.copiedWithSteps }
    if (answer === s.installedNoOther) return { text: t(nextLang(l)).inviteMessage(marketplaceUrl(relay), joinLine(link)), toast: s.copiedWithSteps }
    return null
  } catch {
    return null
  }
}

async function forgetGroup($: EngineInterface) {
  await $.store.delete('membership')
  await setGroup($, undefined)
  await update($, friends, () => [])
}

/**
 * 離開群組（指令和 pane 的按鈕共用，ui-20）。ui-18 C：中繼沒確認就先別刪本機的成員資料，
 * 不然再也退不掉、名字永遠留在群組裡。例外：中繼說金鑰無效（被移除、群組沒了）＝本來就不在了；
 * 或使用者明確要 --force 只刪本機
 */
async function leaveGroup($: EngineInterface, m: Membership, s: Strings, isForce: boolean): Promise<'left' | 'localOnly' | { failed: string }> {
  try {
    await relayCall($, m.relay, 'POST', '/leave', {}, m)
  } catch (err) {
    const isGone = err instanceof RelayError && err.status === 401
    if (!isGone && !isForce) return { failed: errorText(err, s) }
    if (!isGone) {
      await forgetGroup($)
      return 'localOnly'
    }
  }
  await forgetGroup($)
  return 'left'
}

/** 離開前確認（ui-20）。問題裡不放群組名：那是別人取的字，問答框可能進對話。關掉框＝不離開 */
async function confirmLeave($: EngineInterface, s: Strings, isOwner: boolean): Promise<boolean> {
  try {
    const q = isOwner ? `${s.askLeave} ${s.askLeaveOwner}` : s.askLeave
    return (await $.ui.ask(q, { header: s.askLeaveHeader, options: [s.leaveYes, s.leaveNo] })) === s.leaveYes
  } catch {
    return false
  }
}

async function joinGroup($: EngineInterface, parsed: { relay: string; invite: string }, name: string) {
  const r = await relayCall($, parsed.relay, 'POST', '/join', { invite: parsed.invite, name })
  const mem = membershipFrom(r, parsed.relay, name)
  await $.store.set('membership', mem)
  await $.store.set('onboarded', true)
  await setGroup($, mem)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const l = await storedLang($)
    await update($, lang, () => l)
    await $.command.register({
      name: 'friends',
      description: t(l).commandDescription,
      argumentHint: '[create|join|pause|resume|hide|lang|update|autoupdate|leave|help]',
    })
    const m = await getMembership($)
    await setGroup($, m)
    const isPaused = Boolean(await $.store.get('paused'))
    await update($, me, v => ({ ...v, isPaused }))
    conn = crypto.randomUUID()
    sentActivity = ''
    $.clock.every(TICK_MS, () => { void tick($) })
    if (m) {
      isPaneOpen = true
      void $.ui.open({ id: PANE, title: t(l).title })
    } else if (!(await $.store.get('onboarded'))) {
      // 裝好後第一次開對話：自己打開 pane 的「貼上邀請」，只跳這一次（主人 10-11 選「兩種都做」）
      await $.store.set('onboarded', true)
      isPaneOpen = true
      void $.ui.open({ id: PANE, title: t(l).title, focus: true })
    }
    void updateOnStart($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      const m = await getMembership($)
      // 只收掉這個對話的連線；同一人別的對話還開著就還在線
      if (m) await relayCall($, m.relay, 'POST', '/status', { state: 'offline', conn }, m)
    } catch { /* 中繼 150 秒後自己判離線 */ }
    return next(e)
  })

  // pane 被關掉：之後只送心跳、不拉好友列表（relay/COST.md）
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) isPaneOpen = false
    return next(e)
  }).catch(($, e, next) => next(e)) // 出錯也一定讓 pane 關得掉

  on('turn.start', async ($, e, next) => {
    const text = e.text.trim()
    const isHidden = isHiddenDir(await $.session.cwd(), await hiddenDirs($))
    await update($, me, (v): Me => ({
      ...v, state: 'working', isHidden,
      pending: text && !v.isPaused && !isHidden ? redact(text) : v.pending,
    }))
    void tick($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      await update($, me, (v): Me => ({ ...v, state: 'idle' }))
      void tick($)
    }
    return next(e)
  })

  // 指令輸出會進對話，所以這裡只回自己的操作結果，不回好友的任何文字
  on('command.run', { command: 'friends' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const l = await read($, lang)
    const s = t(l)
    const relay = ((await $.store.get('relay')) as string | undefined) ?? DEFAULT_RELAY
    const m = await getMembership($)
    const open = async () => {
      isPaneOpen = true
      await $.ui.open({ id: PANE, title: s.title })
      void tick($, true)
    }
    try {
      switch (sub) {
        case '': case 'open':
          await open()
          return { text: s.opened }
        case 'create': {
          const name = cleanName(rest.join(' '), 20)
          if (!name) return { text: s.usageCreate }
          const r = await relayCall($, relay, 'POST', '/groups', { name })
          const mem = membershipFrom(r, relay, name)
          await $.store.set('membership', mem)
          await setGroup($, mem)
          await open()
          void tick($)
          await askAutoUpdate($, s)
          return { text: s.created }
        }
        case 'join': {
          const [invite, ...nameParts] = rest
          const parsed = invite ? parseInvite(invite, relay) : null
          if (!parsed) return { text: s.usageJoin }
          const name = cleanName(nameParts.join(' '), 20) || (await askName($, s))
          if (!name) return { text: s.joinCancelled }
          await joinGroup($, parsed, name)
          await open()
          void tick($)
          await askAutoUpdate($, s)
          return { text: s.joined }
        }
        case 'pause': case 'resume': {
          await setPaused($, sub === 'pause')
          void tick($)
          return { text: sub === 'pause' ? s.paused : s.resumed }
        }
        case 'hide': case 'unhide': {
          const dir = rest.join(' ') || (await $.session.cwd())
          const dirs = await hiddenDirs($)
          const nextDirs = sub === 'hide'
            ? [...dirs.filter(d => norm(d) !== norm(dir)), dir]
            : dirs.filter(d => norm(d) !== norm(dir))
          await $.store.set('hidden', nextDirs)
          return { text: s.hiddenList(nextDirs) }
        }
        case 'hidden':
          return { text: s.hiddenList(await hiddenDirs($)) }
        case 'relay': {
          const url = rest[0] ?? ''
          if (!/^https?:\/\/\S+$/.test(url)) return { text: s.usageRelay(relay) }
          await $.store.set('relay', url)
          return { text: s.relaySet(url) }
        }
        case 'lang': {
          const want = rest[0] as Lang | undefined
          if (!want || !LANGS.includes(want)) return { text: s.usageLang }
          await setLang($, want)
          return { text: t(want).langSet }
        }
        case 'update': {
          if (!(await checkUpdate($))) return { text: s.upToDate }
          const result = await doUpdate($)
          return { text: result === 'ok' ? s.updated : result === 'busy' ? s.updateBusy : s.updateFailed }
        }
        case 'autoupdate': {
          const want = rest[0]
          if (want !== 'on' && want !== 'off') return { text: s.usageAutoUpdate((await $.store.get('autoUpdate')) === true) }
          await $.store.set('autoUpdate', want === 'on')
          return { text: want === 'on' ? s.autoUpdateOn : s.autoUpdateOff }
        }
        case 'rotate': {
          if (!m) return { text: s.notJoined }
          const r = await relayCall($, m.relay, 'POST', '/invite/rotate', {}, m)
          if (!isToken(r.invite)) throw new RelayError(-1)
          const mem = { ...m, invite: r.invite }
          await $.store.set('membership', mem)
          await setGroup($, mem)
          return { text: s.rotated }
        }
        case 'leave': {
          if (!m) return { text: s.notJoined }
          const r = await leaveGroup($, m, s, rest[0] === '--force')
          return { text: r === 'left' ? s.left : r === 'localOnly' ? s.leftLocalOnly : s.leaveFailed(r.failed) }
        }
        default:
          return { text: s.help }
      }
    } catch (err) {
      return { text: s.error(errorText(err, s)) }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // 手機 app 沒有輸入框（官方：mobile 不給 Input）
    const Input = 'Input' in els ? els.Input : undefined
    const l = await read($, lang)
    const s = t(l)
    const g = await read($, group)
    const list = await read($, friends)
    const mine = await read($, me)
    const n = await read($, net)
    const u = await read($, upd)
    const isAutoUpdate = (await $.store.get('autoUpdate')) === true
    // A（ui-19）：有新版 → 一行說明＋「更新」鈕；按了之後顯示進度與結果
    const updateRow = u.state === 'running' ? <Text key="upd" color="warning">{s.updating}</Text>
      : u.state === 'done' ? <Text key="upd" color="success">{s.updatedPane}</Text>
      : u.state === 'failed' ? (
        <Box key="upd" flexDirection="column">
          <Text color="error">{s.updateFailedPane}</Text>
          <Box flexDirection="row"><Button key="update" label={s.updateRetry} onPress={() => { void doUpdate($) }} /></Box>
        </Box>
      )
      : u.latest ? (
        <Box key="upd" flexDirection="row" gap={1} alignItems="center">
          <Text color="warning" wrap="truncate-end">{s.updateAvailable(u.latest)}</Text>
          <Button key="update" label={s.updateNow} onPress={() => { void doUpdate($) }} />
          {!isAutoUpdate && (
            <Button key="autoOn" label={s.updateAlways} onPress={() => {
              void (async () => { await $.store.set('autoUpdate', true); await doUpdate($) })()
            }} />
          )}
        </Box>
      )
      : null
    const updateRows = updateRow === null ? 0 : u.state === 'failed' ? 4 : 1
    const langButton = (
      <Button key="lang" label={s.switchLang} onPress={() => {
        void (async () => { await setLang($, nextLang(await read($, lang))) })()
      }} />
    )
    if (!g) {
      // 貼上邀請 → 問名字 → 加入。邀請只進外掛自己（Input 的內容不會進對話）
      const submitInvite = async (value: string) => {
        const s2 = t(await read($, lang))
        const relay = ((await $.store.get('relay')) as string | undefined) ?? DEFAULT_RELAY
        const parsed = parseInvite(value.trim(), relay)
        if (!parsed) { $.ui.toast(s2.badInvite); return }
        const name = await askName($, s2)
        if (!name) { $.ui.toast(s2.joinCancelled); return }
        try {
          await joinGroup($, parsed, name)
          $.ui.toast(s2.joined)
          void tick($, true)
          await askAutoUpdate($, s2)
        } catch (err) {
          $.ui.toast(s2.error(errorText(err, s2)))
        }
      }
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text bold>{s.title}</Text>
            {langButton}
          </Box>
          {updateRow}
          <Text>{s.notInGroup}</Text>
          <Text>{s.joinIntro}</Text>
          {Input && (
            <Input key="invite" label={s.inviteLabel} placeholder={s.invitePlaceholder} submitLabel={s.inviteSubmit} autoFocus
              onSubmit={(value: string) => { void submitInvite(value) }} />
          )}
          <Box flexDirection="row" gap={1}>
            <Button key="later" label={s.later} onPress={() => { isPaneOpen = false; void $.ui.close({ id: PANE }) }} />
          </Box>
          <Text dimColor>{s.joinHint}</Text>
        </Box>
      )
    }
    const sorted = [...list].sort((a, b) => ORDER[a.presence] - ORDER[b.presence] || a.name.localeCompare(b.name))
    const online = list.filter(f => f.presence !== 'offline' && !f.isMe).length
    // 好友看到的是中繼上自己那一筆（可能是別的對話送的），不是這個對話自己的分類
    const meOnRelay = list.find(f => f.isMe)
    const myLine = mine.isPaused
      ? s.myPaused
      : mine.isHidden ? s.myHidden
      : s.myActivity(meOnRelay && meOnRelay.action !== '' ? activityText(meOnRelay.action, meOnRelay.subject, l) : s.myNone)
    const pauseButton = (
      <Button key="pause" label={mine.isPaused ? s.resume : s.pause} onPress={() => {
        void (async () => {
          await setPaused($, !(await read($, me)).isPaused)
          await tick($)
        })()
      }} />
    )
    const inviteButton = (
      <Button key="invite" label={s.copyInvite} onPress={press => {
        void (async () => {
          const cur = await read($, group)
          if (!cur) return
          const l2 = await read($, lang)
          const s2 = t(l2)
          const out = await inviteText($, l2, cur.relay, inviteLink(cur.relay, cur.invite))
          if (!out) return
          const r = await $.ui.copy({ text: out.text, surface: press.surface })
          $.ui.toast(r.isCopied ? out.toast : s2.copyFailed)
        })()
      }} />
    )
    // ui-20（主人 10-12「我希望離開的功能也要放在右邊的介面」）：先確認；中繼連不上不刪本機（同指令）
    const leaveButton = (
      <Button key="leave" label={s.leave} onPress={() => {
        void (async () => {
          const s2 = t(await read($, lang))
          const cur = await getMembership($)
          if (!cur || !(await confirmLeave($, s2, cur.isOwner))) return
          const r = await leaveGroup($, cur, s2, false)
          $.ui.toast(r === 'left' ? s2.left : r === 'localOnly' ? s2.leftLocalOnly : s2.leaveFailed(r.failed))
        })()
      }}>
        <Text dimColor>{s.leave}</Text>
      </Button>
    )
    const header = (
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" gap={1} flexShrink={1}>
          <Text bold wrap="truncate-end">{g.name}</Text>
          <Text dimColor wrap="truncate-end">· {s.online(online)}</Text>
        </Box>
        {langButton}
      </Box>
    )

    // 桌面版／手機版：社群軟體的版面（主人 10-11 選「A 好友列表」＋「B 限動＋動態牆」合在一起）
    // 上：在線好友頭像一排；中：最近動態；下：自己的卡片＋按鈕
    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const avatar = (f: Friend, size: number) => (
        <Svg source={avatarSvg(f.id, f.name, f.presence, size)} alt={`${f.name} · ${s.presence[f.presence]}`} width={size} height={size} />
      )
      const others = sorted.filter(f => !f.isMe)
      const onlineFriends = others.filter(f => f.presence !== 'offline')
      const offlineNames = others.filter(f => f.presence === 'offline').map(f => f.name)
      const feed = [...onlineFriends].sort((a, b) => (a.activityAgoSec ?? Infinity) - (b.activityAgoSec ?? Infinity))
      // 高度不夠時先拿掉頭像排，再把動態收成「還有 N 位」，自己的卡片與按鈕一定留著
      const rows = e.props.scroll ? e.props.scroll.bodyRows : 100
      const fixedRows = 2 + (n.isOk ? 0 : 1) + (updateRow ? updateRows + 1 : 0) + 1 + (offlineNames.length ? 1 : 0) + 3 + 2 + 2
      const STRIP_ROWS = 4
      const showStrip = onlineFriends.length > 0 && rows - fixedRows - STRIP_ROWS >= 2 * Math.min(feed.length, 2)
      const roomFeed = Math.max(1, Math.floor((rows - fixedRows - (showStrip ? STRIP_ROWS : 0)) / 2))
      const shownFeed = feed.length > roomFeed ? feed.slice(0, Math.max(0, roomFeed - 1)) : feed
      const moreFeed = feed.length - shownFeed.length
      const STRIP_MAX = 6
      const strip = onlineFriends.slice(0, STRIP_MAX)
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {!n.isOk && <Text color="error" wrap="truncate-end">{n.error}</Text>}
          {updateRow}
          {showStrip && (
            <Box flexDirection="row" gap={2}>
              {strip.map(f => (
                <Box key={'strip-' + f.id} flexDirection="column" alignItems="center">
                  {avatar(f, 36)}
                  <Text dimColor wrap="truncate-end">{f.name}</Text>
                </Box>
              ))}
              {onlineFriends.length > STRIP_MAX && <Text dimColor>{s.morePeople(onlineFriends.length - STRIP_MAX)}</Text>}
            </Box>
          )}
          <Box flexDirection="column">
            <Text dimColor>{s.recent}</Text>
            {list.length === 0 && <Text dimColor>{s.loading}</Text>}
            {shownFeed.map(f => {
              const prefix = s.doingPrefix[f.presence === 'working' ? 'working' : 'idle']
              const when = ago(f.activityAgoSec, l)
              return (
                <Box key={f.id} flexDirection="row" gap={1} alignItems="center" marginTop={1}>
                  {avatar(f, 28)}
                  <Box flexDirection="column" flexShrink={1}>
                    <Box flexDirection="row" gap={1}>
                      <Text bold wrap="truncate-end">{f.name}</Text>
                      {f.action !== '' && prefix !== '' && <Text dimColor>{prefix}</Text>}
                      {f.action !== '' && <Text wrap="truncate-end">{activityText(f.action, f.subject, l)}</Text>}
                      {f.action === '' && <Text dimColor>{s.noActivity}</Text>}
                    </Box>
                    <Text dimColor wrap="truncate-end">
                      {f.action !== '' && when ? `${s.presence[f.presence]} · ${s.startedAgo(when)}` : s.presence[f.presence]}
                    </Text>
                  </Box>
                </Box>
              )
            })}
            {moreFeed > 0 && <Text dimColor>{s.more(moreFeed)}</Text>}
            {offlineNames.length > 0 && (
              <Text dimColor wrap="truncate-end">{s.offlineList(offlineNames.join(l === 'zh-TW' ? '、' : ', '))}</Text>
            )}
          </Box>
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1} alignItems="center">
              {meOnRelay && avatar(meOnRelay, 32)}
              <Box flexDirection="column" flexShrink={1}>
                {meOnRelay && <Text bold wrap="truncate-end">{meOnRelay.name}{s.you}</Text>}
                <Text color={mine.isPaused ? 'warning' : undefined} dimColor={!mine.isPaused} wrap="truncate-end">{myLine}</Text>
              </Box>
            </Box>
            <Box flexDirection="row" gap={1} marginTop={1}>
              {pauseButton}
              {inviteButton}
            </Box>
            <Box flexDirection="row" marginTop={1}>
              {leaveButton}
            </Box>
          </Box>
        </Box>
      )
    }

    // 終端機：沒有 Svg，行內 pane 又矮（實測約 11 行就被截）——控制項放最上面，好友一人一行，放不下就收成「還有 N 位」
    const headerRows = 4 + (n.isOk ? 0 : 1) + updateRows
    const room = e.props.scroll ? Math.max(1, e.props.scroll.bodyRows - headerRows) : sorted.length
    const shown = sorted.length > room ? sorted.slice(0, Math.max(0, room - 1)) : sorted
    const hiddenCount = sorted.length - shown.length
    return (
      <Box flexDirection="column">
        {header}
        {!n.isOk && <Text color="error" wrap="truncate-end">{n.error}</Text>}
        {updateRow}
        <Text color={mine.isPaused ? 'warning' : undefined} dimColor={!mine.isPaused} wrap="truncate-end">{myLine}</Text>
        <Box flexDirection="row" gap={1}>
          {pauseButton}
          {inviteButton}
          <Button key="refresh" label={s.refresh} onPress={() => { void tick($, true) }} />
          {leaveButton}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {sorted.length === 0 && <Text dimColor>{s.loading}</Text>}
          {shown.map(f => (
            <Box key={f.id} flexDirection="row" gap={1}>
              <Text color={COLOR[f.presence]}>●</Text>
              <Text bold wrap="truncate-end">{f.name}{f.isMe ? s.you : ''}</Text>
              <Text dimColor>{s.presence[f.presence]}</Text>
              {f.presence !== 'offline' && f.action !== '' && <Text dimColor>—</Text>}
              {f.presence !== 'offline' && f.action !== '' && (
                <Text wrap="truncate-end">{activityText(f.action, f.subject, l)}</Text>
              )}
              {f.presence !== 'offline' && f.action !== '' && (
                <Text dimColor>{ago(f.activityAgoSec, l)}</Text>
              )}
            </Box>
          ))}
          {hiddenCount > 0 && <Text dimColor>{s.more(hiddenCount)}</Text>}
        </Box>
      </Box>
    )
  })
}
