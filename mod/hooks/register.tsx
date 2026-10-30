// Friends with Claude：側邊 pane 看好友在不在線、正在用 Claude 做哪一類事。
// 借鑑 SaharCarmel/claude-who（MIT，邀請碼＋每人金鑰）與 chrisluo5311/squad-chat（MIT，pane 內容不進對話）。
// 送出去的動態只有 taxonomy.ts 的兩個代碼；好友傳來的任何文字只畫在 pane，絕不進對話。

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Friend, GroupView, Me, Membership, Net, StatusBody, UpdateView, WhatsNewView } from '../types'
import { cellWidth, CHANGELOG, changelogRows, PICKER_CHROME } from './changelog'
import type { ChangelogSection } from './changelog'
import { AVATAR_EMOJI, avatarSvg, fillIndexFor } from './avatar'
import { isDemoBot, withDemoBot } from './demo-bot'
import { t } from './i18n'
import type { Strings } from './i18n'
import { redact } from './redact'
import { ACTION_LABEL, ACTIONS, activityText, AVATARS, isAction, isAvatar, isSubject, LANGS, SUBJECT_LABEL, SUBJECTS } from './taxonomy'
import type { Action, Avatar, Lang, Subject } from './taxonomy'
import { cleanName, isValidNameInput } from './text'
import { fromB64url, isResponsePublicKey, newResponseNonce, OFFICIAL_RESPONSE_KEYS, verifyRelaySignature } from './response-signing'

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
const whatsNew = atom({ plugin: 'with-friends', key: 'whatsNew' } as const, { isOpen: false } as WhatsNewView)
const removed = atom({ plugin: 'with-friends', key: 'removed' } as const, false)
const demoHiddenView = atom({ plugin: 'with-friends', key: 'demoHidden' } as const, false)
/** ui-28：版本紀錄小框框開著多久自動收起（毫秒） */
export const WHATS_NEW_MS = 10_000

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
/** 版本紀錄小框框的收起計時（ui-28）；沒開＝undefined */
let whatsNewTimer: { cancel: () => void } | undefined
/** 版本紀錄小框框的「第幾次打開」（fix-9）：每次開、關、對話結束都 +1；計時器和還沒做完的打開只認自己那一代，不然兩次打開同時送出時，先跑的計時器會被後來的蓋掉參照而取消不到 */
let whatsNewGen = 0
/** 版本紀錄框頂挑版本那一列（ui-29j：◀ 版本 ▶）；兩顆箭頭的 key——ui-29i 看焦點落在它們上面就重算 10 秒 */
const WHATS_NEW_PICK = 'whatsnew-pick'
const WHATS_NEW_ARROWS: readonly string[] = ['whatsnew-older', 'whatsnew-newer']
/** pane 右下角的版本（ui-24）；undefined＝還沒讀 */
let shownVersion: string | undefined
/** 這個對話送過自己的版本了嗎（ui-19f ②：每個對話第一次送狀態時帶一次，中繼存著） */
let isVersionSent = false
/** ver-2：中繼要求的最低外掛版本；不是 x.y.z 或沒回（舊中繼）＝''。只拿來比大小，字串本身不顯示 */
let relayMinVersion = ''
/**
 * ui-22：這個對話送過頭像了嗎。頭像存在 $.store（所有對話共用），每個對話開始時送一次、換頭像時再送一次。
 * 不跟版本放同一個請求：舊中繼不認得 avatar 會回 400，一起送的話連版本也一起放棄
 */
let isAvatarSent = false
let invalidResponseFailures = 0
let invalidResponseRetryAt = -Infinity
/** 同一個 hooks 模組實例內，所有 membership read-check-write/delete 共用的 critical section。 */
let membershipWrites: Promise<void> = Promise.resolve()

export async function withMembershipWrite<T>(fn: () => Promise<T>): Promise<T> {
  const previous = membershipWrites
  let release!: () => void
  membershipWrites = new Promise<void>(resolve => { release = resolve })
  await previous
  try { return await fn() } finally { release() }
}

type PinnedRelayKey = { keyId: string; publicKey: string }
type RelayTrust = { mode: 'official' } | { mode: 'pinned'; origins?: Record<string, PinnedRelayKey | string>; origin?: string; publicKey?: string }
async function responseTrust($: EngineInterface, origin: string): Promise<{ keyId: string; publicKey: string } | null> {
  if (origin === DEFAULT_RELAY) {
    const [keyId, publicKey] = Object.entries(OFFICIAL_RESPONSE_KEYS)[0]!
    return { keyId, publicKey }
  }
  const v = await $.store.get('relayTrustV1') as RelayTrust | undefined
  if (v?.mode !== 'pinned') return null
  const pin = v.origins?.[origin]
  // 舊版只存 public key，沒有可核對的 key id；明確拒收，不能靜默信任任意 id。
  if (typeof pin === 'string' || (pin === undefined && v.origin === origin && v.publicKey)) throw new RelayError(-4)
  return pin && /^[A-Za-z0-9._-]{1,64}$/.test(pin.keyId) && isResponsePublicKey(pin.publicKey) ? pin : null
}

/**
 * L-18：store 裡的成員資料只在「少了就完全不能用」的四個欄位都對時才算在群組裡（中繼網址、群組代號、成員代號、金鑰）。
 * 壞掉的（例如 {}、字串、少了金鑰）當成沒加入：不然 create／join 會被 sec-14 擋住、心跳一直失敗，只能 leave --force 救。
 * 其他欄位缺了就補預設值。這純屬防禦：0.3.3 起每一版存的都是同樣八個欄位、代碼都是中繼發的 base64url（L-18 審查查過全部歷史），
 * 但萬一有少欄位的資料，也不能把它當成沒加入（那樣會讓人不知不覺被登出、名字留在中繼上）
 */
export function membershipOf(v: unknown): Membership | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  if (typeof o.relay !== 'string' || !o.relay || !isToken(o.groupId) || !isToken(o.memberId) || !isToken(o.memberKey)) return undefined
  return {
    relay: o.relay, groupId: o.groupId, memberId: o.memberId, memberKey: o.memberKey,
    invite: typeof o.invite === 'string' ? o.invite : '',
    inviteGeneration: typeof o.inviteGeneration === 'number' && Number.isSafeInteger(o.inviteGeneration) && o.inviteGeneration >= 0 ? o.inviteGeneration : 0,
    groupName: typeof o.groupName === 'string' ? o.groupName : '',
    isOwner: o.isOwner === true,
    name: typeof o.name === 'string' ? o.name : '',
  }
}
async function getMembership($: EngineInterface): Promise<Membership | undefined> {
  return membershipOf(await $.store.get('membership'))
}
const membershipRevision = () => crypto.randomUUID()
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
  // 連結裡的邀請碼跟純邀請碼同一個規則（test-2：原本 # 後面什麼字都收，會先問名字再把亂字送給中繼）
  // 中繼只收「協定＋主機＋埠」（sec-6a）：路徑能塞任意字，原本會被抄進給朋友 Claude 看的安裝步驟
  const m = /^(https?:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?)\/?#([\w.-]{4,200})$/.exec(raw)
  if (m) return { relay: m[1]!, invite: m[2]! }
  // 純邀請碼只收 [A-Za-z0-9_.-]（中繼產生的就是這些字），貼錯的句子、網址片段都擋掉
  if (!/^[\w.-]{4,200}$/.test(raw)) return null
  return { relay: fallbackRelay, invite: raw }
}
export const inviteLink = (relay: string, invite: string) => `${relay.replace(/\/+$/, '')}#${invite}`
export const joinLine = (link: string) => `/friends join ${link}`
export const marketplaceUrl = (relay: string) => `${relay.replace(/\/+$/, '')}/marketplace.json`
/** 中繼網址只留「協定＋主機＋埠」；舊版存下的網址有路徑、帳密之類就回 null（sec-6a） */
export function relayOrigin(relay: string): string | null {
  const m = /^(https?:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?)(?:\/|$)/.exec(relay)
  return m ? m[1]! : null
}
/**
 * sec-15：只跟 https 中繼說話；http 只放行本機（localhost、127.0.0.1，開發測試用）。
 * http 會讓成員金鑰（每個請求的 authorization）在網路上明碼跑。http 的主機名照 relayOrigin 的規則（不收 IPv6、帳密），
 * 所以 [::1] 也不放行（以前 parseInvite／relayOrigin 就不收 IPv6，不為了這張放寬）
 */
export function isSecureRelay(relay: string): boolean {
  // sec-16（sec-15 審查建議 2）：https 也要驗主機格式。以前 https 只看開頭，帶帳密（https://user:pw@x）、
  // 空的或 - 開頭的標籤、超過 65535 的埠也會被拿去 fetch
  const origin = relayOrigin(relay)
  const m = origin ? /^(https?):\/\/([^:/]+)(?::(\d+))?$/.exec(origin) : null
  if (!m || !isHostname(m[2]!)) return false
  if (m[3] !== undefined && (Number(m[3]) < 1 || Number(m[3]) > 65535)) return false
  if (m[1] === 'https') return true
  const host = m[2]!.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1'
}
/** 主機名：用點分開的每一段 1～63 個英數字或「-」，不以「-」開頭結尾；不收空的段（a..b、結尾的點） */
const isHostname = (h: string) => h.length <= 253 && h.split('.').every(l => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l))

export function isHiddenDir(cwd: string, dirs: string[]): boolean {
  const c = norm(cwd)
  return dirs.some(d => c === norm(d) || c.startsWith(norm(d) + '/'))
}

/**
 * 中繼出錯只留狀態碼（ui-18 B）：中繼回的錯誤文字可能是惡意的，而指令的錯誤訊息會進對話＝提示注入。
 * 0＝連不上、-1＝中繼回的東西格式不對、-2＝外掛自己出錯、-3＝中繼不是 https（也不是本機）＝不連（sec-15）
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

// 中繼產生的 id、金鑰、邀請碼都是 base64url 加「.」（relay/core.mjs token／newInvite）
const TOKEN_RE = /^[\w.-]{1,200}$/
const isToken = (v: unknown): v is string => typeof v === 'string' && TOKEN_RE.test(v)

/**
 * sec-16b B：逐端點檢查成功回應的最低契約。失敗一律當作格式錯誤，不採用任何欄位。
 * 這只能抓缺漏或對不上本機身分的資料；惡意中繼仍能照格式偽造，身分驗證留給 C 的簽章。
 */
export function isValidRelayResponse(path: string, data: any, auth?: Membership): boolean {
  if (path === '/groups' || path === '/join') {
    return isToken(data.groupId) && isToken(data.memberId) && isToken(data.memberKey) && isToken(data.invite)
      && Number.isSafeInteger(data.inviteGeneration) && data.inviteGeneration >= 0
      && data.isOwner === (path === '/groups')
  }
  if (path === '/status' || path === '/friends') {
    if (!auth || !Array.isArray(data.members)) return false
    const mine = data.members.filter((v: unknown) => typeof v === 'object' && v !== null && (v as any).id === auth.memberId)
    if (mine.length !== 1 || (mine[0] as any).isMe !== true || typeof (mine[0] as any).isOwner !== 'boolean') return false
    return data.members.every((v: unknown) => {
      if (typeof v !== 'object' || v === null) return false
      const row = v as any
      return typeof row.id === 'string' && row.id.length > 0
        && typeof row.isMe === 'boolean'
        && (row.id === auth.memberId || row.isMe === false)
    })
  }
  if (path === '/invite/rotate') return isToken(data.invite) && Number.isSafeInteger(data.inviteGeneration) && data.inviteGeneration >= 1
  if (path === '/kick') return data.ok === true && isToken(data.invite) && Number.isSafeInteger(data.inviteGeneration) && data.inviteGeneration >= 1
  if (path === '/name') return data.ok === true
  if (path === '/leave') return data.ok === true
  // 新增 relayCall 端點時必須先在這裡定義成功契約；未知端點不可默認採用。
  return false
}

async function relayCall($: EngineInterface, relay: string, method: 'GET' | 'POST', path: string, body?: unknown, auth?: Membership): Promise<any> {
  // sec-15：所有打中繼的路都經過這裡（store 裡舊版存的中繼、成員資料也是）：不安全就連請求都不發，金鑰不出門
  if (!isSecureRelay(relay)) throw new RelayError(-3)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const origin = relay.replace(/\/+$/, '')
  const trust = await responseTrust($, origin)
  if (!trust) throw new RelayError(-1)
  const nonce = newResponseNonce()
  headers['x-friends-nonce'] = nonce
  headers['x-friends-origin'] = origin
  // ver-2b：每個請求都帶自己的版本（讀不到就不帶），中繼將來才分得出新舊版；現在中繼不依它拒絕任何請求
  shownVersion ??= await ownVersion($)
  if (shownVersion) headers['x-friends-version'] = shownVersion
  if (auth) headers.authorization = `Bearer ${auth.groupId}.${auth.memberId}.${auth.memberKey}`
  let res
  try {
    res = await $.http.fetch(origin + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new RelayError(0)
  }
  const header = (name: string): unknown => res.headers?.[name]
  const keyId = header('x-friends-key-id')
  if (!verifyRelaySignature({
    nonce, origin, method, path, status: Number(res.status), body: res.text,
    returnedNonce: header('x-friends-nonce'), keyId, expectedKeyId: trust.keyId,
    signature: header('x-friends-signature'), publicKey: trust.publicKey,
  })) throw new RelayError(-1)
  if (!res.ok) throw new RelayError(Number(res.status) || -1)
  let data: unknown
  try { data = JSON.parse(res.text) } catch { throw new RelayError(-1) }
  // 陣列也是 object，但中繼一定回物件（test-2 抓到：回 [1,2] 時 pane 以為一切正常）
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new RelayError(-1)
  // 契約不符是「中繼回的東西格式不對」，不是網路連不上；沿用既有 -1 固定訊息。
  if (!isValidRelayResponse(path, data, auth)) throw new RelayError(-1)
  // 群主離開後，中繼會指定接任者。只採用已簽章且 self row 唯一的 roster，並用 membership revision 柵欄寫回。
  if (auth && (path === '/status' || path === '/friends')) await syncOwnerFromRoster($, auth, (data as any).members)
  return data
}

/** 中繼回的成員資料只挑認得的欄位、檢查格式；中繼網址與名字用本機的，中繼回什麼都蓋不掉 */
export function membershipFrom(r: any, relay: string, name: string): Membership {
  if (!isToken(r.groupId) || !isToken(r.memberId) || !isToken(r.memberKey) || !isToken(r.invite)
    || !Number.isSafeInteger(r.inviteGeneration) || r.inviteGeneration < 0) throw new RelayError(-1)
  return {
    relay, name, groupId: r.groupId, memberId: r.memberId, memberKey: r.memberKey, invite: r.invite,
    inviteGeneration: r.inviteGeneration,
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
/** 自動更新失敗後：同一版隔這麼久才再自動試，最多試這麼多次，之後只剩 pane 的手動鈕（ui-19f ③） */
export const AUTO_RETRY_MS = 60 * 60_000
export const AUTO_MAX_TRIES = 3
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

/**
 * pane 的更新鈕：別的對話正在更新（鎖還沒過期）時要講出來，不然朋友按了完全沒反應（主人 10-12 朋友回報）。
 * 這個對話自己在跑（running）就不蓋掉
 */
async function pressUpdate($: EngineInterface) {
  if ((await doUpdate($)) === 'busy') await update($, upd, (v): UpdateView => (v.state === 'running' ? v : { ...v, state: 'busy' }))
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

/** 自動試過哪一版、什麼時候、成功沒、第幾次。舊版存的是純版本字串：不知道成敗，當失敗過一次（ui-19f ③） */
type AutoTried = { v: string; at: number; ok: boolean; n: number }
function autoTriedOf(x: unknown): AutoTried | null {
  if (typeof x === 'string') return { v: x, at: -Infinity, ok: false, n: 1 }
  if (typeof x !== 'object' || x === null) return null
  const t = x as Partial<AutoTried>
  if (typeof t.v !== 'string' || typeof t.at !== 'number' || typeof t.n !== 'number') return null
  return { v: t.v, at: t.at, ok: t.ok === true, n: t.n }
}

/**
 * 開對話時（和長時間開著的對話每 6 小時）：看有沒有新版；同意自動更新的人就在背景更新（下一個新對話生效）。
 * 同一個版本「成功」過就不再自動跑：成功但版本沒變（來源不同步）時，不會每開一個對話就重跑（ui-19 審查 ⑤）。
 * 失敗了隔 AUTO_RETRY_MS 再試，最多 AUTO_MAX_TRIES 次（ui-19f ③：之前失敗一次就永遠不再自動試）
 */
async function autoUpdateCheck($: EngineInterface) {
  const now = await $.clock.now()
  lastUpdateCheckAt = now
  const latest = await checkUpdate($)
  if (!latest || (await $.store.get('autoUpdate')) !== true) return
  const tried = autoTriedOf(await $.store.get('autoTried'))
  const prev = tried?.v === latest ? tried : null
  if (prev && (prev.ok || prev.n >= AUTO_MAX_TRIES || now - prev.at < AUTO_RETRY_MS)) return
  const r = await doUpdate($)
  if (r !== 'busy') await $.store.set('autoTried', { v: latest, at: now, ok: r === 'ok', n: (prev?.n ?? 0) + 1 })
}

// ---- 頭像（ui-22）：只從 taxonomy.ts 的 16 個代碼挑，存在 $.store，下一次送狀態帶給中繼 ----
const avatarList = () => AVATARS.map(a => `${AVATAR_EMOJI[a]} ${a}`).join(', ')
/** 中繼回的 avatar 不可信：不是清單內代碼就當沒有（用原本的名字第一個字） */
const avatarOf = (f: Friend): Avatar | undefined => {
  const a = (f as Friend & { avatar?: unknown }).avatar
  return isAvatar(a) ? a : undefined
}
async function setAvatar($: EngineInterface, a: Avatar) {
  await $.store.set('avatar', a)
  isAvatarSent = false
  void tick($, true)
}
/** pane 的「換頭像」：問答框最多 4 個選項，所以先挑一組（4 個表情符號），再從那組挑一個；在「其他」打代碼也可以 */
async function pickAvatar($: EngineInterface, s: Strings): Promise<Avatar | null> {
  const groups = [0, 4, 8, 12].map(i => AVATARS.slice(i, i + 4))
  const fromTyped = (answer: string): Avatar | null => {
    const v = answer.trim().toLowerCase()
    return isAvatar(v) ? v : AVATARS.find(a => AVATAR_EMOJI[a] === answer.trim()) ?? null
  }
  try {
    const first = await $.ui.ask(s.askAvatar, { header: s.askAvatarHeader, options: groups.map(g => g.map(a => AVATAR_EMOJI[a]).join(' ')) })
    const group = groups.find(g => g.map(a => AVATAR_EMOJI[a]).join(' ') === first)
    if (!group) return fromTyped(first)
    const second = await $.ui.ask(s.askAvatar, { header: s.askAvatarHeader, options: group.map(a => `${AVATAR_EMOJI[a]} ${a}`) })
    return group.find(a => `${AVATAR_EMOJI[a]} ${a}` === second) ?? fromTyped(second)
  } catch {
    return null
  }
}

/** ui-9：/friends status 的一句話。只算別人（不含自己）；最多人在做的分類只取清單內代碼，同票照清單順序 */
export function statusText(list: Friend[], l: Lang, meId = ''): string {
  // 在線只認 working／idle 兩個值；自己用中繼的 isMe 和自己的成員 id 雙重排除
  const online = list.filter(f => !f.isMe && f.id !== meId && (f.presence === 'working' || f.presence === 'idle'))
  const working = online.filter(f => f.presence === 'working').length
  const counts = new Map<Action, number>()
  for (const f of online) if (isAction(f.action)) counts.set(f.action, (counts.get(f.action) ?? 0) + 1)
  let top: Action | undefined
  for (const a of ACTIONS) if ((counts.get(a) ?? 0) > (top ? counts.get(top) ?? 0 : 0)) top = a
  return t(l).statusSummary(online.length, working, online.length - working, top ? ACTION_LABEL[l][top] : '')
}

/** 好友列表只畫在 pane，但名字還是再清一次（舊版或別人架的中繼可能沒清） */
export function friendsFrom(members: unknown[]): Friend[] {
  const seen = new Set<string>()
  return members
    .filter((f): f is Friend => typeof f === 'object' && f !== null && typeof (f as Friend).id === 'string')
    // 同一個 id 只留第一個（畫面用 id 當 key，重複會亂）
    .filter(f => !seen.has(f.id) && !!seen.add(f.id))
    .map(f => ({
      ...f, name: cleanName(f.name, 20) || '?', version: typeof f.version === 'string' && SEMVER_RE.test(f.version) ? f.version : '',
      // 離線框（ui-17）照這個排序、顯示「x 前在線」：中繼給的怪值（字串、負數、NaN）一律當 0
      seenAgoSec: typeof f.seenAgoSec === 'number' && Number.isFinite(f.seenAgoSec) && f.seenAgoSec >= 0 ? Math.floor(f.seenAgoSec) : 0,
      // 惡意或舊版中繼的怪值（L-3，sec-6a 建議 4）：presence 拿去查 s.presence[…]，"constructor" 會查到函式、終端機整個畫不出來
      presence: f.presence === 'working' || f.presence === 'idle' ? f.presence : 'offline',
      isMe: f.isMe === true,
      // 不是字串的動作／對象當成「沒有動態」（不然 !== '' 成立、會顯示成「在忙」）
      action: typeof f.action === 'string' ? f.action : '',
      subject: typeof f.subject === 'string' ? f.subject : '',
      activityAgoSec: typeof f.activityAgoSec === 'number' && Number.isFinite(f.activityAgoSec) && f.activityAgoSec >= 0 ? Math.floor(f.activityAgoSec) : null,
    }))
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
export function statusBody(cur: Me, connId: string, sent: string, isResume = false): StatusBody {
  // 0.5.6：暫停時不讓好友看出工作中／閒置（承諾是只看得到在線）——working 一律送 idle；中繼也會再擋一次
  if (cur.isPaused) return { state: cur.state === 'working' ? 'idle' : cur.state, conn: connId, paused: true }
  // 0.5.6：中繼的暫停是「這位成員」的旗標，只有明確的 paused: false 才解除。繼續之後要送一次（送成功才停），
  // 平常的心跳不帶 paused，免得還沒讀到暫停的舊對話把別的對話的暫停蓋掉
  const resume = isResume ? { paused: false as const } : {}
  const a = activityOf(cur)
  if (a && JSON.stringify(a) !== sent) return { state: cur.state, conn: connId, ...a, ...resume }
  return { state: cur.state, conn: connId, ...resume }
}

/** 暫停狀態存在 $.store、所有對話共用；暫停時連這個對話記著的動態一起清掉 */
function withPaused(v: Me, isPaused: boolean): Me {
  return isPaused ? { ...v, isPaused, pending: '', action: '', subject: '' } : { ...v, isPaused }
}

/** pane 現在畫的是哪一份成員資料（L-17：tick 拿它跟共用的 store 比，不一樣就重畫） */
/**
 * 這個對話自己的記號：它送過 paused: true、或自己按過繼續，而 paused: false 還沒拿到 200。共用 store 的 token 負責「按繼續的對話已經關掉」，
 * 這個負責「先送出的 paused: true 比 paused: false 晚到中繼、token 已被別的對話清掉」——每個對話的請求是一個接一個送的（isBusy），
 * 所以送過 paused: true 的對話，最後送到中繼的一定是它自己的 paused: false
 */
let needsResume = false
let shownMember = ''
/** 跟 shownMember 同一份（L-17 審查：只換了邀請碼時不用清好友列表，要知道上一份是誰） */
let shownMembership: Membership | undefined
const memberShape = (m: Membership | undefined) => (m ? JSON.stringify([m.relay, m.groupId, m.memberId, m.invite, m.isOwner, m.groupName]) : '')
async function setGroup($: EngineInterface, m: Membership | undefined) {
  shownMember = memberShape(m)
  shownMembership = m
  // 換了群組（或剛開對話）：版本要再送一次給新群組
  isVersionSent = false
  isAvatarSent = false
  // 新群組可能在別的中繼：等它回了再算（ver-2）
  relayMinVersion = ''
  await update($, group, () => (m ? { name: m.groupName, invite: m.invite, isOwner: m.isOwner, relay: m.relay } : null))
}

/** 每 10 秒：必要時分類 → 送自己的狀態（變了、或 pane 開著滿 15 秒／關著滿 60 秒；force＝馬上送），回應裡帶好友列表 */
export async function tick($: EngineInterface, force = false) {
  if (isBusy) return
  isBusy = true
  const now = await $.clock.now()
  // 放在 try 外面：catch 也要知道這一輪是用哪一份成員資料送的（L-17 審查）
  let m: Membership | undefined
  try {
    m = await getMembership($)
    // L-17：成員資料是同一個人所有對話共用的。別的對話換了邀請碼、離開、加入或建立群組，這個對話的 pane 要跟著換
    // （不然「複製邀請碼」複製出去的是已經失效的那個，離開了也還畫著群組）
    if (memberShape(m) !== shownMember) {
      // 換了群組或身分才清好友列表；只是別的對話換了邀請碼（同一個身分）就不清，免得閃一下「載入中」
      if (!m || !isSameMember(shownMembership, m)) await update($, friends, () => [])
      await setGroup($, m)
      force = true // 換了群組（或身分）：馬上送一次，新群組的人才看得到你、這裡也馬上拿到新的好友列表
    }
    if (!m) return
    if (!force && now < invalidResponseRetryAt) return
    // 長時間開著的對話：每 6 小時再看一次有沒有新版，自動更新失敗過的也在這裡重試（ui-19、ui-19f ③）
    if (now - lastUpdateCheckAt >= UPDATE_CHECK_MS) {
      lastUpdateCheckAt = now
      void autoUpdateCheck($)
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
    // 「還沒把 paused: false 送到中繼」存在共用的 $.store：按繼續的那個對話就算先結束，別的對話（包括之後新開的）也會補送
    // 記號是每次按「繼續」新產生的 token（不是 true）：送出期間又經過「暫停→繼續」時，舊的回應只清得掉自己那一個 token
    const storedToken = await $.store.get('resumePending')
    const resumeToken = !cur.isPaused && typeof storedToken === 'string' && storedToken !== '' ? storedToken : ''
    const isResumePending = !cur.isPaused && (resumeToken !== '' || needsResume)
    const body = statusBody(cur, conn, sentActivity, isResumePending)
    // 要在送出「之前」就記：逾時、5xx、回應丟失的 paused: true 照樣可能已經到了中繼（而且可能比別的對話的 paused: false 晚到）
    if (body.paused === true) needsResume = true
    if (!isVersionSent) {
      shownVersion ??= await ownVersion($)
      if (shownVersion) body.version = shownVersion
    }
    const out: StatusBody & { avatar?: Avatar } = { ...body }
    if (!body.version && !isAvatarSent) {
      const a = await $.store.get('avatar')
      if (isAvatar(a)) out.avatar = a
      else isAvatarSent = true
    }
    const signature = JSON.stringify({ state: body.state, paused: body.paused })
    const gap = isPaneOpen ? PULL_MS : HEARTBEAT_MS
    if (!(force || body.action || out.avatar || signature !== lastPushed || now - lastPushAt >= gap)) return
    // 送狀態的回應裡就有好友列表，不另外拉
    let data: Awaited<ReturnType<typeof relayCall>>
    let isAvatarRejected = false
    try {
      data = await relayCall($, m.relay, 'POST', '/status', out, m)
    } catch (err) {
      // 舊版或自架的中繼不認得 version 欄位會回 400：這個對話不再送版本，下一輪照常送狀態（審查必修 1）
      if (body.version && err instanceof RelayError && err.status === 400) isVersionSent = true
      // 頭像同理（ui-22：現在線上的中繼還不認得 avatar）。400 也可能是別的原因，跟版本一樣寧可這個對話先不送。
      // fix-2：不讓 pane 閃一下「中繼不接受」的紅字，也不讓這一輪的動態晚 10 秒：拿掉頭像立刻重送同一筆
      // （400 若其實是別的欄位造成的，重送一樣會 400，才照常顯示錯誤；這個對話之後也不再帶頭像）
      // L-4：中繼不認得這個動作／對象代碼（新版外掛遇到舊版或自架的中繼）也會 400。不退讓的話每一輪都重送同一個代碼、
      // 一直 400，心跳也斷了。改送 other／other 一次，原本的動態記成已送，之後不再重送。
      // 帶著版本的那一次 400 分不出是誰造成的，先照舊（下一輪不帶版本再試）
      // （同一輪同時帶頭像和新代碼、中繼只拒絕代碼時，第一次 400 會被當成頭像被拒，這個對話之後不再送頭像；機率很低）
      const canFallBack = (e: unknown) =>
        e instanceof RelayError && e.status === 400 && !body.version && !!body.action && !(body.action === 'other' && body.subject === 'other')
      const sentAs = m // 閉包裡要一個確定不是 undefined 的參照（m 宣告在 try 外面）
      const fallBack = () => relayCall($, sentAs.relay, 'POST', '/status', { ...body, action: 'other', subject: 'other' }, sentAs)
      if (out.avatar && err instanceof RelayError && err.status === 400) {
        isAvatarSent = true
        isAvatarRejected = true
        try {
          data = await relayCall($, m.relay, 'POST', '/status', body, m)
        } catch (err2) {
          if (!canFallBack(err2)) throw err2
          data = await fallBack()
        }
      } else if (canFallBack(err)) {
        data = await fallBack()
      } else {
        throw err
      }
    }
    // L-17：等中繼的期間別的對話離開或換了群組：這次的回應是舊群組的，不記任何狀態、不寫好友列表（下一輪會照新的成員資料重畫）
    const currentMembership = await getMembership($)
    if (!isSameMember(currentMembership, m)) return
    if (body.action) sentActivity = JSON.stringify({ action: body.action, subject: body.subject })
    if (body.version) isVersionSent = true
    if (body.paused === false) needsResume = false
    if (body.paused === false && resumeToken !== '' && (await $.store.get('resumePending')) === resumeToken) await $.store.delete('resumePending')
    // 送出去的期間又換了頭像（setAvatar 把旗子放下、但那次 tick 因為 isBusy 沒跑）：store 跟送出的不一樣就下一輪再送
    if (out.avatar && !isAvatarRejected) isAvatarSent = (await $.store.get('avatar')) === out.avatar
    lastPushed = signature
    lastPushAt = now
    relayMinVersion = typeof data.minVersion === 'string' && SEMVER_RE.test(data.minVersion) ? data.minVersion : ''
    if (Array.isArray(data.members)) {
      // 延遲的舊 /status 可能帶改名前的 self row；自己的名字以 revision-safe 本機 membership 為準，不能把 pane 暫時畫回舊名。
      const rows = friendsFrom(data.members).map(f => f.isMe ? { ...f, name: cleanName(currentMembership.name, 20) || '?' } : f)
      await update($, friends, () => rows)
    }
    await update($, net, () => ({ isOk: true, error: '', at: now }))
    invalidResponseFailures = 0
    invalidResponseRetryAt = -Infinity
  } catch (err) {
    // L-17 審查：等中繼的期間別的對話離開或換了群組，這個錯誤（例如 401）是舊群組的，不顯示；下一輪照新的成員資料重來
    if (m && !isSameMember(await getMembership($), m)) return
    const s = t(await read($, lang))
    // 被移除（或群組已刪）後，這份 membership 已不可再用。只看 401，不採用中繼文字。
    if (m && err instanceof RelayError && err.status === 401) {
      await $.store.set('removedNotice', true)
      await update($, removed, () => true)
      await forgetGroup($, m)
      await update($, net, () => ({ isOk: true, error: '', at: now }))
      return
    }
    // ui-4：連不上（網路）→ 說會自動重試（每 10 秒的 tick 本來就會重試）；其他錯誤照狀態碼挑固定句子
    const error = err instanceof RelayError && err.status === 0 ? s.unreachable : errorText(err, s)
    if (err instanceof RelayError && err.status === -1) {
      invalidResponseFailures++
      invalidResponseRetryAt = now + Math.min(5 * 60_000, TICK_MS * 2 ** Math.min(invalidResponseFailures - 1, 5))
    }
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
  if (sec < 172_800) return s.hourAgo(Math.floor(sec / 3600))
  // 離線好友（ui-17）可能好幾天沒上線：滿 2 天改用天
  return s.dayAgo(Math.floor(sec / 86_400))
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
/** 取消版本紀錄小框框的計時器，並讓所有還沒做完的「打開」作廢（fix-9） */
function cancelWhatsNewTimer() {
  whatsNewGen++
  whatsNewTimer?.cancel()
  whatsNewTimer = undefined
}
/** 版本紀錄小框框收起（按鈕再按一次、pane 關掉都走這裡） */
async function closeWhatsNew($: EngineInterface) {
  cancelWhatsNewTimer()
  await update($, whatsNew, () => ({ isOpen: false }))
}
/** 按「版本紀錄」：關著就打開並開始計時，開著就立刻收起 */
async function toggleWhatsNew($: EngineInterface) {
  // fix-12：讀狀態要等。等的期間有人換代（session.end／pane 關掉收框，或另一次按鈕開框或收框），這次按鈕就作廢：不開框、不設計時器
  // 只記下世代、讀之前不換代：開著時同時按兩次，先完成的那次收框並換代、另一次作廢，所以只收一次
  const seen = whatsNewGen
  const isOpen = (await read($, whatsNew)).isOpen
  if (seen !== whatsNewGen) return
  if (isOpen) {
    await closeWhatsNew($)
    return
  }
  // fix-9：先換代再 await，等 update 期間有人換代就不設計時器。兩次「打開」同時進來時，fix-12 的檢查已經讓後讀完的那次作廢，只有先讀完的會走到這裡
  cancelWhatsNewTimer()
  const gen = whatsNewGen
  await update($, whatsNew, () => ({ isOpen: true }))
  if (gen !== whatsNewGen) return
  armWhatsNewTimer($, gen)
}
/** 開始算 10 秒自動收起；gen＝這一次打開（或挑版本）的世代，回呼只收這一代的框 */
function armWhatsNewTimer($: EngineInterface, gen: number) {
  // ui-29i 審查：最新設的一定蓋掉舊的。重算（rearmWhatsNew）不換代，同一代可能被設兩次（挑版本的 update 還沒回來時移焦點），
  // 舊的那個要先取消，不然沒人取消得到、會提早收框
  whatsNewTimer?.cancel()
  whatsNewTimer = $.clock.after(WHATS_NEW_MS, () => {
    // 只收「這一次打開」的框：中間被關掉、又打開過，這個計時器已經不是現在這一代
    if (gen !== whatsNewGen) return
    // ui-29：自動收起也換代（跟其他收框一樣），還在讀狀態的挑版本／按鈕就作廢，不會把剛收起的框又打開
    whatsNewGen++
    whatsNewTimer = undefined
    void update($, whatsNew, () => ({ isOpen: false }))
  })
}
/**
 * /friends 的子指令（L-12）。指令分派只認這份清單；sec-8 的防注入測試會檢查每一個都有在惡意中繼下跑過，
 * 所以新加子指令要加在這裡（不加的話 case 寫不進去、tsc 會擋；加了沒寫 case 也會擋）。
 * 會打中繼的子指令，測試的 ALL_SUBCOMMANDS 裡要有一筆能真的走到中繼的參數（只放用法錯誤的寫法測不到）
 */
export const SUBCOMMANDS = ['', 'open', 'help', 'create', 'join', 'pause', 'resume', 'hide', 'unhide', 'hidden', 'demo', 'relay', 'lang', 'update', 'status', 'avatar', 'autoupdate', 'rotate', 'remove', 'name', 'leave'] as const
export type Subcommand = (typeof SUBCOMMANDS)[number]
/** 版本紀錄可以挑的版本：版本號 ≤ 自己的，新的在前（ui-28 只列這些；ui-29 一次顯示其中一個） */
export function whatsNewVersions(ver: string | undefined): string[] {
  if (!ver) return []
  return CHANGELOG.filter(c => !isNewer(c.version, ver)).map(c => c.version).sort(bySemverDesc)
}
/**
 * ui-29：框頂挑版本。只在框開著時有效、只收可以挑的版本（比自己新的一律不理）；
 * 挑了就重算 10 秒（使用者正在看，不要剛挑完就收掉）。跟 toggleWhatsNew 一樣的世代保護（fix-9／fix-12）
 */
async function pickWhatsNew($: EngineInterface, v: string) {
  const seen = whatsNewGen
  const isOpen = (await read($, whatsNew)).isOpen
  if (seen !== whatsNewGen || !isOpen) return
  if (!whatsNewVersions(shownVersion).includes(v)) return
  cancelWhatsNewTimer()
  const gen = whatsNewGen
  await update($, whatsNew, () => ({ isOpen: true, version: v }))
  if (gen !== whatsNewGen) return
  armWhatsNewTimer($, gen)
}
/**
 * ui-29i：框開著時重算 10 秒，不換代（不換版本，也不讓正在進行的挑版本作廢——焦點移到選單、緊接著挑，兩個會前後腳進來）。
 * 讀狀態期間有人換代（收框）就不做；讀完到設計時器之間沒有 await，所以不會設到已經收起的框上
 */
async function rearmWhatsNew($: EngineInterface) {
  const seen = whatsNewGen
  const isOpen = (await read($, whatsNew)).isOpen
  if (seen !== whatsNewGen || !isOpen) return
  armWhatsNewTimer($, whatsNewGen) // 會先取消現在的計時器
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
// R6-02：藏起來與否存在同一人所有對話共用的 $.store.demoHidden（畫面每次都從 store 讀）；atom 只用來叫開著的 pane 重畫
async function setDemoHidden($: EngineInterface, isHidden: boolean) {
  await $.store.set('demoHidden', isHidden)
  await update($, demoHiddenView, () => isHidden)
}
const nextLang = (l: Lang): Lang => LANGS[(LANGS.indexOf(l) + 1) % LANGS.length] ?? 'en'

async function setPaused($: EngineInterface, isPaused: boolean) {
  if (!isPaused) needsResume = true // 先記在這個對話，後面的 store 寫入失敗也不會漏送
  await $.store.set('paused', isPaused)
  await update($, me, v => withPaused(v, isPaused))
  if (isPaused) sentActivity = ''
  // 繼續：記下「中繼那邊的暫停旗標還沒解」，任一對話送 paused: false 拿到 200 才清；再暫停就作廢
  if (isPaused) await $.store.delete('resumePending')
  else await $.store.set('resumePending', crypto.randomUUID())
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
async function inviteText($: EngineInterface, l: Lang, relay: string, invite: string): Promise<{ text: string; toast: string } | null> {
  const s = t(l)
  // 加入那行用「協定＋主機＋埠」組（sec-6a：舊版存下的中繼可能帶路徑，路徑能塞給朋友 Claude 看的字），連這個都抽不出來（帶帳密之類）就不複製；
  // 安裝改成照公開 README（ui-23b），不再用中繼網址組
  const origin = relayOrigin(relay)
  if (!origin) return null
  // sec-15：舊版存下的 http 中繼不再發邀請出去（朋友照著加入會被擋，金鑰也不該走 http）
  if (!isSecureRelay(origin)) { $.ui.toast(s.error(s.relayError(-3))); return null }
  const link = inviteLink(origin, invite)
  try {
    const answer = await $.ui.ask(s.askInstalled, { header: s.askInstalledHeader, options: [s.installedYes, s.installedNo, s.installedNoOther] })
    if (answer === s.installedYes) return { text: joinLine(link), toast: s.copied }
    if (answer === s.installedNo) return { text: s.installMessage, toast: s.copiedInstallOnly }
    if (answer === s.installedNoOther) return { text: t(nextLang(l)).installMessage, toast: s.copiedInstallOnly }
    return null
  } catch {
    return null
  }
}

/** 兩份成員資料是不是同一個身分（同一個中繼、同一個群組、同一個成員代號） */
const isSameMember = (a: Membership | undefined, b: Membership): a is Membership => !!a && a.relay === b.relay && a.groupId === b.groupId && a.memberId === b.memberId
/**
 * 從這台電腦移除群組。L-16：只在 store 裡還是 m 這個身分時才刪——等中繼（或等使用者按確認）的期間，
 * 別的對話可能已經離開、又加入了別的群組（成員資料是所有對話共用的），不能把那份刪掉。
 * 回 false＝store 已經不是 m（沒刪；pane 換成現在的狀態）
 */
async function forgetGroup($: EngineInterface, m: Membership): Promise<boolean> {
  const { removed, current } = await withMembershipWrite(async () => {
    const now = await getMembership($)
    if (now && !isSameMember(now, m)) return { removed: false, current: now }
    if (now) {
      await $.store.set('membershipRevision', membershipRevision())
      await $.store.delete('membership')
    }
    return { removed: true, current: undefined }
  })
  if (!removed) {
    // 好友列表先清掉：不然新群組的標題下面會短暫掛著舊群組的人（tick 正在跑的話，強制 tick 會被跳過）
    await update($, friends, () => [])
    await setGroup($, current)
    void tick($, true)
    return false
  }
  await setGroup($, undefined)
  await update($, friends, () => [])
  return true
}

/**
 * 離開群組（指令和 pane 的按鈕共用，ui-20）。ui-18 C：中繼沒確認就先別刪本機的成員資料，
 * 不然再也退不掉、名字永遠留在群組裡。例外：中繼說金鑰無效（被移除、群組沒了）＝本來就不在了；
 * 或使用者明確要 --force 只刪本機
 */
async function leaveGroup($: EngineInterface, m: Membership, s: Strings, isForce: boolean): Promise<'left' | 'localOnly' | 'keptOther' | 'localOnlyKeptOther' | { failed: string }> {
  try {
    await relayCall($, m.relay, 'POST', '/leave', {}, m)
  } catch (err) {
    const isGone = err instanceof RelayError && err.status === 401
    if (!isGone && !isForce) return { failed: errorText(err, s) }
    // --force、中繼沒收到：照實說「只從這台電腦移除」
    if (!isGone) return (await forgetGroup($, m)) ? 'localOnly' : 'localOnlyKeptOther'
  }
  // L-16：中繼那邊已經離開了（使用者要的）；本機若已經是別的群組，保留那份、照實說
  return (await forgetGroup($, m)) ? 'left' : 'keptOther'
}
/** leaveGroup 的結果 → 固定句子（指令和 pane 共用） */
const leaveText = (r: Awaited<ReturnType<typeof leaveGroup>>, s: Strings) =>
  r === 'left' ? s.left : r === 'localOnly' ? s.leftLocalOnly : r === 'keptOther' ? s.leftKeptOther
    : r === 'localOnlyKeptOther' ? s.leftLocalOnlyKeptOther : s.leaveFailed(r.failed)

/** 離開前確認（ui-20）。問題裡不放群組名：那是別人取的字，問答框可能進對話。關掉框＝不離開 */
async function confirmLeave($: EngineInterface, s: Strings, isOwner: boolean): Promise<boolean> {
  try {
    const q = isOwner ? `${s.askLeave} ${s.askLeaveOwner}` : s.askLeave
    return (await $.ui.ask(q, { header: s.askLeaveHeader, options: [s.leaveYes, s.leaveNo] })) === s.leaveYes
  } catch {
    return false
  }
}

/**
 * 移除確認不放好友名字（名字是別人打的字，問答框可能進對話；ui-16 原設計）。以前改放 roster 序號，但序號是中繼回來的順序、
 * pane 畫面另外排序，兩者對不上，又允許同名，群主可能確認到另一位（盲審 #4）。
 * 取捨：改放「固定字彙」的描述——頭像代碼（清單內 16 個）、在線狀態、多久前在線——這些畫面上看得到、也都不是自由文字；
 * 有同名的人就另外註明「另有 N 位同名」。真正決定移除誰的仍是 memberId（按鈕所在那一列／指令唯一符合的那位），描述只幫人核對。
 */
export function removeWho(f: Friend, roster: Friend[], l: Lang, onTerminal = false): string {
  const s = t(l)
  const join = (parts: string[]) => parts.join(l === 'zh-TW' ? '，' : ', ')
  // 全部是固定字彙：頭像代碼（沒選頭像的人，pane 畫底色圓框，就說底色）、在線狀態或多久前在線
  const describe = (x: Friend) => {
    const a = avatarOf(x)
    const parts: string[] = []
    if (a) parts.push(`${AVATAR_EMOJI[a]} ${s.avatarName[a]}`)
    // 終端機的列只畫表情符號、名字和狀態字：沒畫的底色、「多久前在線」就不說，不然核對的資訊畫面上找不到，
    // 該跳的「看起來一樣」提醒也會被這些畫面上沒有的差異蓋掉
    else if (!onTerminal && x.presence !== 'offline') parts.push(s.askRemoveBadge(fillIndexFor(x.id)))
    parts.push(x.presence === 'offline' && !onTerminal ? s.lastSeen(ago(x.seenAgoSec, l)) : s.presence[x.presence])
    return join(parts)
  }
  const mine = describe(f)
  const twins = roster.filter(x => !x.isMe && x.id !== f.id && x.name === f.name)
  const parts = [mine]
  if (twins.length > 0) parts.push(s.askRemoveSameName(twins.length))
  // 描述還是一模一樣（例如兩位都離線、同一分鐘前在線）：照實說分不出來，請看按的是哪一列
  if (twins.some(x => describe(x) === mine)) parts.push(s.askRemoveLookAlike)
  return join(parts)
}

/** 移除確認只放 removeWho 的固定字彙描述，不把好友名字放進問答框。關掉框也視為取消。 */
async function confirmRemove($: EngineInterface, s: Strings, who: string): Promise<boolean> {
  try {
    return (await $.ui.ask(s.askRemove(who), { header: s.askRemoveHeader, options: [s.removeYes, s.removeNo] })) === s.removeYes
  } catch {
    return false
  }
}

async function askNewName($: EngineInterface, s: Strings): Promise<{ name?: string; invalid?: true }> {
  try {
    const answer = await $.ui.ask(s.askNewName, { header: s.askNewNameHeader, options: [s.keepName, s.cancelName] })
    if (answer === s.keepName || answer === s.cancelName || !answer.trim()) return {}
    if (!isValidNameInput(answer, 20)) return { invalid: true }
    return { name: answer.trim() }
  } catch {
    return {}
  }
}

/** 改名只寫回同一個身分；revision 改變時沿用 membership 寫入的保守補償，避免復活已離開的身分。 */
async function renameSelf($: EngineInterface, original: Membership, newName: string): Promise<void> {
  if (!isValidNameInput(newName, 20)) throw new RelayError(-2)
  await relayCall($, original.relay, 'POST', '/name', { name: newName.trim() }, original)
  let mem: Membership | undefined
  await withMembershipWrite(async () => {
    const revision = membershipRevision()
    await $.store.set('membershipRevision', revision)
    const now = await getMembership($)
    if (!isSameMember(now, original)) return
    mem = { ...now, name: newName.trim() }
    await $.store.set('membership', mem)
    if (await $.store.get('membershipRevision') !== revision) {
      const after = await getMembership($)
      if (isSameMember(after, mem) && after?.name === mem.name) await $.store.delete('membership')
      mem = undefined
    }
  })
  if (!mem) throw new RelayError(-2)
  await update($, friends, rows => rows.map(f => f.id === original.memberId ? { ...f, name: newName.trim() } : f))
}

/** 套用 rotate／kick 回來的新邀請；沿用 L-SEC-ROTATE-1 的 revision 與 inviteGeneration 柵欄。 */
async function saveRotatedInvite($: EngineInterface, original: Membership, r: any): Promise<Membership | undefined> {
  let mem: Membership | undefined
  await withMembershipWrite(async () => {
    const revision = membershipRevision()
    await $.store.set('membershipRevision', revision)
    const now = await getMembership($)
    if (!isSameMember(now, original) || !isToken(r.invite) || !Number.isSafeInteger(r.inviteGeneration)
      || r.inviteGeneration <= now.inviteGeneration) return
    mem = { ...now, invite: r.invite, inviteGeneration: r.inviteGeneration }
    await $.store.set('membership', mem)
    if (await $.store.get('membershipRevision') !== revision) {
      const after = await getMembership($)
      if (isSameMember(after, mem) && after?.inviteGeneration === mem.inviteGeneration) await $.store.delete('membership')
      mem = undefined
    }
  })
  if (mem) await setGroup($, mem)
  else await setGroup($, await getMembership($))
  return mem
}

/** 已簽章 roster 的 self row 是群主權限真值；只更新同一身分，不能把已離開或已換群的人復活。 */
async function syncOwnerFromRoster($: EngineInterface, original: Membership, members: unknown[]): Promise<Membership | undefined> {
  const self = members.find((row: any) => row && row.id === original.memberId && row.isMe === true) as { isOwner: boolean } | undefined
  if (!self) return undefined // relayCall 的契約會先拒絕；這裡只做防禦
  let mem: Membership | undefined
  let changed = false
  await withMembershipWrite(async () => {
    const before = await getMembership($)
    if (!isSameMember(before, original)) return
    if (before.isOwner === self.isOwner) { mem = before; return }
    const revision = membershipRevision()
    await $.store.set('membershipRevision', revision)
    const now = await getMembership($)
    if (!isSameMember(now, original)) return
    if (now.isOwner === self.isOwner) { mem = now; return }
    mem = { ...now, isOwner: self.isOwner }
    await $.store.set('membership', mem)
    changed = true
    if (await $.store.get('membershipRevision') !== revision) {
      const after = await getMembership($)
      if (isSameMember(after, mem) && after?.isOwner === mem.isOwner) await $.store.delete('membership')
      mem = undefined
    }
  })
  if (mem && changed) await setGroup($, mem)
  return mem
}

export type RemoveOutcome = 'ok' | 'relay-failed' | 'uncertain'
const removeText = (outcome: RemoveOutcome, s: Strings) => outcome === 'ok' ? s.removedOne : outcome === 'relay-failed' ? s.removeFailed : s.removeUncertain

/** 中繼以 memberId 精確移除；成功輸出與 toast 都只用固定句，不帶名字。checkpoint 讓測試釘住成功回應後的 crash 邊界。 */
export async function removeMember($: EngineInterface, m: Membership, memberId: string, checkpoint: () => Promise<void> = async () => {}): Promise<RemoveOutcome> {
  let relayAccepted = false
  try {
    const r = await relayCall($, m.relay, 'POST', '/kick', { memberId }, m)
    relayAccepted = true
    await checkpoint()
    if (!(await saveRotatedInvite($, m, r))) return 'uncertain'
    await update($, friends, rows => rows.filter(f => f.id !== memberId))
    return 'ok'
  } catch (err) {
    // 0.5.6：已簽章的 404＝中繼確定這個人不在群組了（例如上一次踢人其實成功、只是回應丟了，這次是重試；或他剛好自己離開了）→
    // 目的已達成，不再誤報「沒移除」。但「踢人一併換邀請碼」的承諾不能因此落空（他離開時沒換碼、重試時本機也沒拿到上次的新碼），
    // 所以這裡補換一次邀請碼並存下來；換碼或存檔任何一步失敗都只能說不確定。成功才清掉本機好友列
    if (!relayAccepted && err instanceof RelayError && err.status === 404) {
      try {
        const rotated = await relayCall($, m.relay, 'POST', '/invite/rotate', {}, m)
        if (!(await saveRotatedInvite($, m, rotated))) return 'uncertain'
        await update($, friends, rows => rows.filter(f => f.id !== memberId))
        return 'ok'
      } catch {
        return 'uncertain'
      }
    }
    // 只有收到已簽章的明確 HTTP 失敗，才知道 kick 沒有完成；傳輸／簽章／本機 store／成功後例外都只能保守標為不確定。
    // 盲審 #2：5xx 不算「確定沒做」——Worker／Durable Object 可能已寫入才出錯，所以只有已簽章的 4xx（中繼明確拒絕）算失敗。
    return !relayAccepted && err instanceof RelayError && err.status >= 400 && err.status <= 499 ? 'relay-failed' : 'uncertain'
  }
}

/**
 * 問群組名稱（ui-7：pane 的「建立群組」鈕）。群組名是使用者自己打的字；選預設＝「名字 的群組」（照介面語言，
 * 不用中繼的中文預設）。選「先不建立」、關掉、空白都回 null
 */
async function askGroupName($: EngineInterface, s: Strings, name: string): Promise<string | null> {
  try {
    const answer = (await $.ui.ask(s.askGroupName, { header: s.askGroupNameHeader, options: [s.useDefaultGroupName(name), s.cancelCreate] })).trim()
    if (!answer || answer === s.cancelCreate) return null
    return cleanName(answer === s.useDefaultGroupName(name) ? s.groupNameDefault(name) : answer, 30) || null
  } catch {
    return null
  }
}

/**
 * sec-14：已經在群組裡就不准再建立或加入（sec-6a 建議 7）。以前會直接蓋掉本機的成員資料、不先離開舊群組，
 * 使用者以為自己還在舊群組，舊群組也留下一個不會再回來的成員。成員資料在 $.store、同一人所有對話共用：
 * 這個對話的 pane 可能還畫著「建立群組」，別的對話卻已經加入了，所以擋在 createGroup／joinGroup 本身，
 * 在打中繼和寫 store 之前。只說「一個群組」，不帶群組名（群組名是中繼回來的字，不能進指令輸出）
 */
export class AlreadyInGroupError extends Error {
  constructor() {
    super('already in a group')
    this.name = 'AlreadyInGroupError'
  }
}
async function assertNotInGroup($: EngineInterface) {
  if (await getMembership($)) throw new AlreadyInGroupError()
}
/**
 * 中繼回來之後、寫 store 之前再看一次：等中繼的那一下別的對話剛好加入了，就用剛拿到的身分退掉剛建立／加入的群組
 * （不然那邊會留一個不會再回來的成員，正是這張卡要擋的事），再丟 AlreadyInGroupError；退不掉也不寫 store。
 * 接受的風險：兩個對話「同一瞬間」都拿到中繼回應、都看到 store 是空的，後寫的會蓋掉先寫的（store 沒有原子操作）；
 * 要同一個人在兩個對話幾乎同時建立／加入才會發生
 */
/** pane 被擋下來時：固定句子＋把 pane 換成現在真正的群組畫面（tick 也會在 10 秒內同步，這裡是讓它馬上換） */
async function showAlreadyInGroup($: EngineInterface, s: Strings) {
  $.ui.toast(s.alreadyInGroup)
  await setGroup($, await getMembership($))
  void tick($, true)
}

/** 建群組（指令 create 和 pane 的「建立群組」鈕共用） */
async function createGroup($: EngineInterface, relay: string, name: string, groupName: string) {
  await assertNotInGroup($)
  const r = await relayCall($, relay, 'POST', '/groups', { name, groupName })
  const mem = membershipFrom(r, relay, name)
  try {
    await withMembershipWrite(async () => {
      if (await getMembership($)) throw new AlreadyInGroupError()
      await $.store.set('membershipRevision', membershipRevision())
      await $.store.set('membership', mem)
    })
  } catch (err) {
    if (err instanceof AlreadyInGroupError) try { await relayCall($, mem.relay, 'POST', '/leave', {}, mem) } catch {}
    throw err
  }
  await $.store.set('onboarded', true)
  await $.store.delete('removedNotice')
  await update($, removed, () => false)
  await setGroup($, mem)
}

async function joinGroup($: EngineInterface, parsed: { relay: string; invite: string }, name: string) {
  await assertNotInGroup($)
  const r = await relayCall($, parsed.relay, 'POST', '/join', { invite: parsed.invite, name })
  const mem = membershipFrom(r, parsed.relay, name)
  try {
    await withMembershipWrite(async () => {
      if (await getMembership($)) throw new AlreadyInGroupError()
      await $.store.set('membershipRevision', membershipRevision())
      await $.store.set('membership', mem)
    })
  } catch (err) {
    if (err instanceof AlreadyInGroupError) try { await relayCall($, mem.relay, 'POST', '/leave', {}, mem) } catch {}
    throw err
  }
  await $.store.set('onboarded', true)
  await $.store.delete('removedNotice')
  await update($, removed, () => false)
  await setGroup($, mem)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const l = await storedLang($)
    await update($, lang, () => l)
    const wasRemoved = (await $.store.get('removedNotice')) === true
    await update($, removed, () => wasRemoved)
    await $.command.register({
      name: 'friends',
      description: t(l).commandDescription,
      argumentHint: '[create|join|status|pause|resume|hide|lang|avatar|update|autoupdate|rotate|remove|name|leave|help]',
    })
    const m = await getMembership($)
    await setGroup($, m)
    const isPaused = Boolean(await $.store.get('paused'))
    await update($, me, v => ({ ...v, isPaused }))
    conn = crypto.randomUUID()
    sentActivity = ''
    invalidResponseFailures = 0
    invalidResponseRetryAt = -Infinity
    $.clock.every(TICK_MS, () => { void tick($) })
    if (m) {
      isPaneOpen = true
      void $.ui.open({ id: PANE, title: t(l).title })
    } else {
      // 還沒加入群組：每次開新對話都自己打開 pane 的「貼上邀請」（R6-01：原本只跳第一次，按過「之後再說」就再也找不回來）
      await $.store.set('onboarded', true)
      isPaneOpen = true
      void $.ui.open({ id: PANE, title: t(l).title, focus: true })
    }
    void autoUpdateCheck($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // fix-9 ⑥：對話結束就取消版本紀錄的計時器，框也一併收起（不然計時器被取消、框會停在開著；/clear 之後同一個 pane 可能還在）
    try {
      await closeWhatsNew($)
    } catch { /* 收不起來也不影響結束 */ }
    try {
      const m = await getMembership($)
      // 只收掉這個對話的連線；同一人別的對話還開著就還在線
      if (m) await relayCall($, m.relay, 'POST', '/status', { state: 'offline', conn }, m)
    } catch { /* 中繼 150 秒後自己判離線 */ }
    return next(e)
  })

  // pane 被關掉：之後只送心跳、不拉好友列表（relay/COST.md）
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      isPaneOpen = false
      void closeWhatsNew($)
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // 出錯也一定讓 pane 關得掉

  // ui-29i：終端機要先把焦點移到挑版本的地方才能挑；移焦點不算「挑」，框可能在挑之前就自己收掉。焦點真的落在 ◀／▶ 上就重算 10 秒（ui-29j 起不是下拉了）
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const r = await next(e)
    if (!r.deny && e.plugin === 'with-friends' && e.element !== undefined && WHATS_NEW_ARROWS.includes(e.element)) void rearmWhatsNew($)
    return r
  }).catch(($, e, next) => next(e)) // 出錯也一定讓焦點照常移動

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
    const [typed = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    // L-12：不在 SUBCOMMANDS 裡的一律當 help（跟以前的 default 一樣回說明）；下面的 case 只能寫清單裡的字，漏加會被 tsc 擋
    const sub: Subcommand = (SUBCOMMANDS as readonly string[]).includes(typed) ? (typed as Subcommand) : 'help'
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
          // sec-14：先擋，不先看參數（在群組裡打 /friends create 不帶名字，也是說「先離開」比較有用）；開著的 pane 也換成群組畫面
          if (m) { await setGroup($, m); return { text: s.alreadyInGroup } }
          const name = cleanName(rest.join(' '), 20)
          if (!name) return { text: s.usageCreate }
          await createGroup($, relay, name, s.groupNameDefault(name))
          await open()
          void tick($)
          await askAutoUpdate($, s)
          return { text: s.created }
        }
        case 'join': {
          // sec-14：先擋，不問名字、不打中繼
          if (m) { await setGroup($, m); return { text: s.alreadyInGroup } }
          const [invite, ...nameParts] = rest
          const parsed = invite ? parseInvite(invite, relay) : null
          if (!parsed) return { text: s.usageJoin }
          // sec-15：不安全的中繼先擋，不問名字（relayCall 也會擋，這裡只是早一步）
          if (!isSecureRelay(parsed.relay)) return { text: s.relayError(-3) }
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
        case 'demo': {
          // R6-02：隱藏／顯示示範機器人（不用 hide：/friends hide 是「不分享的資料夾」）。只認 on／off，其餘回說明
          const want = rest[0]
          if (want !== 'on' && want !== 'off') return { text: s.help }
          await setDemoHidden($, want === 'off')
          return { text: want === 'off' ? s.demoOff : s.demoOn }
        }
        case 'relay': {
          const url = rest[0] ?? ''
          const origin = relayOrigin(url)
          if (!origin || origin !== url.replace(/\/$/, '')) return { text: s.usageRelay(relay) }
          if (!isSecureRelay(origin)) return { text: s.relayError(-3) }
          if (origin !== DEFAULT_RELAY) {
            const keyId = rest[1]
            const publicKey = rest[2]
            if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId ?? '') || !isResponsePublicKey(publicKey)) return { text: s.usageRelay(relay) }
            const prior = await $.store.get('relayTrustV1') as RelayTrust | undefined
            const origins = prior?.mode === 'pinned' ? { ...(prior.origins ?? {}) } : {}
            // 舊的單一 pin 沒有 key id：保留成 string＝待使用者逐主機重新確認；設定同一 origin 時才由下行換成新格式。
            if (prior?.mode === 'pinned' && prior.origin && prior.publicKey && origins[prior.origin] === undefined) origins[prior.origin] = prior.publicKey
            await $.store.set('relayTrustV1', { mode: 'pinned', origins: { ...origins, [origin]: { keyId, publicKey } } })
          } else {
            await $.store.set('relayTrustV1', { mode: 'official' })
          }
          await $.store.set('relay', origin)
          return { text: s.relaySet(origin) }
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
        case 'status': {
          // ui-9：手機看不到 pane，只能靠指令；指令輸出會進對話，所以只回數字和清單內分類的文字，不列名字
          if (!m) return { text: s.statusNotJoined }
          if ((await $.store.get('paused')) === true) return { text: s.statusPaused }
          let data
          try {
            data = await relayCall($, m.relay, 'GET', '/friends', undefined, m)
          } catch (err) {
            if (err instanceof RelayError && err.status === 0) return { text: s.statusUnreachable }
            throw err
          }
          return { text: statusText(Array.isArray(data.members) ? friendsFrom(data.members) : [], l, m.memberId) }
        }
        case 'avatar': {
          // 只收清單內代碼；打錯不回顯使用者打的字，只列出可以用的代碼
          const want = (rest[0] ?? '').toLowerCase()
          if (rest.length !== 1 || !isAvatar(want)) return { text: s.usageAvatar(avatarList()) }
          await setAvatar($, want)
          // 還沒加入群組：存起來，加入後的第一次送狀態就會帶上（fix-2）
          return { text: (m ? s.avatarSet : s.avatarSetNotJoined)(`${AVATAR_EMOJI[want]} ${want}`) }
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
          if (!isToken(r.invite) || !Number.isSafeInteger(r.inviteGeneration) || r.inviteGeneration < 1) throw new RelayError(-1)
          const mem = await saveRotatedInvite($, m, r)
          if (!mem) {
            await update($, friends, () => [])
            void tick($, true)
            return { text: s.rotateStale }
          }
          return { text: s.rotated }
        }
        case 'remove': {
          if (!m) return { text: s.notJoined }
          const raw = rest.join(' ').trim()
          if (!raw) return { text: s.usageRemove }
          const data = await relayCall($, m.relay, 'GET', '/friends', undefined, m)
          const current = await getMembership($)
          if (!isSameMember(current, m)) return { text: s.removeFailed }
          if (!current.isOwner) return { text: s.removeOwnerOnly }
          const roster = friendsFrom(data.members).filter(f => !f.isMe)
          const matches = roster.filter(f => f.name === raw)
          if (matches.length === 0) return { text: s.removeNotFound }
          if (matches.length > 1) return { text: s.removeAmbiguous }
          const target = matches[0]!
          if (!(await confirmRemove($, s, removeWho(target, roster, l)))) return { text: s.removeCancelled }
          return { text: removeText(await removeMember($, current, target.id), s) }
        }
        case 'name': {
          if (!m) return { text: s.notJoined }
          const want = rest.join(' ')
          if (!isValidNameInput(want, 20)) return { text: s.usageName }
          await renameSelf($, m, want)
          return { text: s.nameChanged }
        }
        case 'leave': {
          if (!m) return { text: s.notJoined }
          const r = await leaveGroup($, m, s, rest[0] === '--force')
          return { text: leaveText(r, s) }
        }
        default: {
          // L-12：走到這裡的只能是 'help'。清單加了新字卻忘了寫 case，這行 tsc 會擋（反方向由 case 的型別擋）
          const onlyHelp: 'help' = sub
          void onlyHelp
          return { text: s.help }
        }
      }
    } catch (err) {
      // sec-14：問名字（或等中繼）的期間別的對話加入了：照樣回固定的提示句，不回含糊的錯誤
      if (err instanceof AlreadyInGroupError) { await setGroup($, await getMembership($)); return { text: s.alreadyInGroup } }
      return { text: s.error(errorText(err, s)) }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // 手機 app 沒有輸入框（官方型別：mobile 不給 Input、Select）。用介面判斷（ui-29h）：$.ui.resolve 三種介面都給（ui-29 實測），不能靠 'Input' in els，
    // 實機上 resolve 不一定照介面拿掉元件，手機就會出現一個畫不出來、貼不進去的框
    // 刻意用白名單：型別裡還有 vscode（目前還不接 pane），不認得的介面一律退回「教打指令」那句
    const Input = (e.surface === 'desktop' || e.surface === 'terminal') && 'Input' in els ? els.Input : undefined
    const l = await read($, lang)
    const s = t(l)
    const g = await read($, group)
    const list = await read($, friends)
    const mine = await read($, me)
    const n = await read($, net)
    const u = await read($, upd)
    const wn = await read($, whatsNew)
    const wasRemoved = await read($, removed)
    const isAutoUpdate = (await $.store.get('autoUpdate')) === true
    await read($, demoHiddenView) // R6-02：訂閱，按「隱藏示範」或打 /friends demo off|on 時 pane 會重畫；實際值每次從 store 讀
    const isDemoHidden = (await $.store.get('demoHidden')) === true
    // ui-24（主人 10-12「右下角可以多一行字」）：最底下靠右小字顯示自己的版本，朋友看了就知道升級了沒；讀不到就不畫
    // 同一個對話裡版本不會變（更新要開新對話才生效），讀一次就記住
    shownVersion ??= await ownVersion($)
    const ver = shownVersion
    // ver-2：比中繼要求的最低版本舊 → 固定句子＋同一個更新鈕（自己的版本讀不到就不提示）
    const isTooOld = !!ver && isNewer(relayMinVersion, ver)
    // fix-3：市集最新版也比 minVersion 舊（或還不知道最新版）＝按更新也升不上去：換一句、不配更新鈕
    const canUpdateToMin = !!u.latest && !isNewer(relayMinVersion, u.latest)
    // A（ui-19）：有新版 → 一行說明＋「更新」鈕；按了之後顯示進度與結果
    const updateRow = u.state === 'running' ? <Text key="upd" color="warning">{s.updating}</Text>
      : u.state === 'done' ? <Text key="upd" color="success">{s.updatedPane}</Text>
      : u.state === 'failed' || u.state === 'busy' ? (
        <Box key="upd" flexDirection="column">
          <Text color={u.state === 'failed' ? 'error' : 'warning'}>{u.state === 'failed' ? s.updateFailedPane : s.updateBusy}</Text>
          <Box flexDirection="row"><Button key="update" label={s.updateRetry} onPress={() => { void pressUpdate($) }} /></Box>
        </Box>
      )
      : isTooOld && canUpdateToMin ? (
        <Box key="upd" flexDirection="row" gap={1} alignItems="center">
          <Text color="error" wrap="truncate-end">{s.tooOld}</Text>
          <Button key="update" label={s.updateNow} onPress={() => { void pressUpdate($) }} />
        </Box>
      )
      : isTooOld ? <Text key="upd" color="error" wrap="truncate-end">{s.tooOldWait}</Text>
      : u.latest ? (
        <Box key="upd" flexDirection="row" gap={1} alignItems="center">
          <Text color="warning" wrap="truncate-end">{s.updateAvailable(u.latest)}</Text>
          <Button key="update" label={s.updateNow} onPress={() => { void pressUpdate($) }} />
          {!isAutoUpdate && (
            <Button key="autoOn" label={s.updateAlways} onPress={() => {
              void (async () => { await $.store.set('autoUpdate', true); await pressUpdate($) })()
            }} />
          )}
        </Box>
      )
      : null
    const updateRows = updateRow === null ? 0 : u.state === 'failed' ? 4 : u.state === 'busy' ? 3 : 1
    const versionRow = ver ? (
      <Box key="ver" flexDirection="row" justifyContent="flex-end">
        <Text dimColor>v{ver}</Text>
      </Box>
    ) : null
    // ui-28（主人 10-16「加入版本紀錄這個按鈕放在版本號的底下」「跳一個小框框出來 然後過個幾秒把它關掉」）：
    // 版本號底下同樣靠右一顆「版本紀錄」；按了在它正下方跳出有框線的小框框，每個版本更新了什麼（新的在上，只列版本號 ≤ 自己的），
    // 約 10 秒（WHATS_NEW_MS）自動收起，開著再按一次立刻收起。讀不到版本就不畫整塊
    const whatsNewRow = ver ? (
      <Box key="wn-row" flexDirection="row" justifyContent="flex-end">
        <Button key="whatsnew" label={s.whatsNew} onPress={() => { void toggleWhatsNew($) }} />
      </Box>
    ) : null
    // ui-29（主人 10-19「用選擇框的方式給使用者看哪個版本的更新紀錄」）：框裡一次只放一個版本，框頂挑版本；預設自己目前的版本（可以挑的裡面最新那個）
    const versions = whatsNewVersions(ver)
    const picked = wn.version !== undefined && versions.includes(wn.version) ? wn.version : versions[0]
    const headingOf = (v: string) => {
      const c = CHANGELOG.find(x => x.version === v)
      return !c ? v : c.isUpTo ? s.changelogUpTo(c.version, c.date) : s.changelogVersion(c.version, c.date)
    }
    const pickedEntry = CHANGELOG.find(c => c.version === picked)
    const allSections: ChangelogSection[] = ver && wn.isOpen && pickedEntry ? [{ heading: headingOf(pickedEntry.version), items: pickedEntry.items[l] }] : []
    const hasPicker = allSections.length > 0 && versions.length > 1
    const pickedAt = picked === undefined ? -1 : versions.indexOf(picked)
    // ui-29j（主人 10-20「用左右選擇的框架來做」）：三種介面都是「◀ 挑的版本 ▶」，下拉拿掉。中間就是那一版的標題（框裡不再另外畫一次）。
    // 到頭的那一邊畫成淡色的字（不是按鈕，按不到、Tab 也不會停在上面），左右的位置不變
    const olderVer = pickedAt >= 0 && pickedAt < versions.length - 1 ? versions[pickedAt + 1] : undefined
    const newerVer = pickedAt > 0 ? versions[pickedAt - 1] : undefined
    const picker = !hasPicker || picked === undefined ? null : (
      <Box key={WHATS_NEW_PICK} flexDirection="row" gap={1}>
        {olderVer ? <Button key="whatsnew-older" label={s.changelogOlderName} onPress={() => { void pickWhatsNew($, olderVer) }}>{s.changelogOlder}</Button>
          : <Text key="whatsnew-older-off" dimColor>{s.changelogOlder}</Text>}
        <Text key="whatsnew-current" bold>{headingOf(picked)}</Text>
        {newerVer ? <Button key="whatsnew-newer" label={s.changelogNewerName} onPress={() => { void pickWhatsNew($, newerVer) }}>{s.changelogNewer}</Button>
          : <Text key="whatsnew-newer-off" dimColor>{s.changelogNewer}</Text>}
      </Box>
    )
    const bodyColumns = e.props.bodyColumns ?? 40
    // 挑版本那一列的寬度（照寬度算折行，窄的 pane 會折）：終端機的按鈕畫成「[ ◀ ]」佔 5 格，兩顆＋最長的標題＋兩個間隔（寧可多留）
    const pickerCells = !hasPicker ? 0 : PICKER_CHROME + Math.max(...versions.map(v => cellWidth(headingOf(v))))
    const changelogBox = (sections: readonly ChangelogSection[], isPickerShown = true) => sections.length === 0 ? null : (
      <Box key="whatsnew-box" flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
        {isPickerShown && picker}
        {sections.map(sec => (
          <Box key={'wn-' + sec.heading} flexDirection="column">
            {!(isPickerShown && picker) && <Text bold>{sec.heading}</Text>}
            {sec.items.map((it, i) => <Text key={'it' + i}>· {it}</Text>)}
          </Box>
        ))}
      </Box>
    )
    const versionBlock = (sections: readonly ChangelogSection[], isPickerShown = true) => versionRow ? (
      <Box key="verblock" flexDirection="column">
        {versionRow}
        {whatsNewRow}
        {changelogBox(sections, isPickerShown)}
      </Box>
    ) : null
    // 版本列 1＋按鈕 1＋（開著的框框）
    const versionRows = versionRow ? 2 + (allSections.length ? changelogRows(allSections, bodyColumns, pickerCells) : 0) : 0
    // ui-19f ②（主人 10-12 選「要，只送版本號」）：比自己和市集最新版都舊的朋友標「舊版 v…」；沒回報版本的（舊外掛、網頁成員）不標
    const newest = ver && u.latest && isNewer(u.latest, ver) ? u.latest : ver
    const oldTag = (f: Friend) => (!f.isMe && f.version && newest && isNewer(newest, f.version) ? s.oldVersion(f.version) : '')
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
        if (!isSecureRelay(parsed.relay)) { $.ui.toast(s2.error(s2.relayError(-3))); return }
        // sec-14：別的對話可能已經加入群組了（store 共用），這個 pane 還沒換畫面：先擋、不問名字，並換成群組畫面
        if (await getMembership($)) { await showAlreadyInGroup($, s2); return }
        const name = await askName($, s2)
        if (!name) { $.ui.toast(s2.joinCancelled); return }
        try {
          await joinGroup($, parsed, name)
          $.ui.toast(s2.joined)
          void tick($, true)
          await askAutoUpdate($, s2)
        } catch (err) {
          if (err instanceof AlreadyInGroupError) { await showAlreadyInGroup($, s2); return }
          $.ui.toast(s2.error(errorText(err, s2)))
        }
      }
      // ui-7（主人 10-12「還有沒有創社群組的按鈕」）：不打指令也能開群組——問名字 → 問群組名 → 建立
      const pressCreate = async () => {
        const s2 = t(await read($, lang))
        const relay = ((await $.store.get('relay')) as string | undefined) ?? DEFAULT_RELAY
        if (await getMembership($)) { await showAlreadyInGroup($, s2); return }
        const name = await askName($, s2)
        const groupName = name ? await askGroupName($, s2, name) : null
        if (!name || !groupName) { $.ui.toast(s2.createCancelled); return }
        try {
          await createGroup($, relay, name, groupName)
          $.ui.toast(s2.created)
          void tick($, true)
          await askAutoUpdate($, s2)
        } catch (err) {
          if (err instanceof AlreadyInGroupError) { await showAlreadyInGroup($, s2); return }
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
          <Text>{wasRemoved ? s.removedFromGroup : s.notInGroup}</Text>
          {/* ui-29h：沒有輸入框的介面（手機）不說「貼在這裡」，改教用指令加入（指令在手機也能打） */}
          <Text>{Input ? s.joinIntro : s.joinIntroNoInput}</Text>
          {Input && (
            <Input key="invite" label={s.inviteLabel} placeholder={s.invitePlaceholder} submitLabel={s.inviteSubmit} autoFocus
              onSubmit={(value: string) => { void submitInvite(value) }} />
          )}
          <Text dimColor>{s.joinHint}</Text>
          <Text dimColor wrap="truncate-end">{s.reopenHint}</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="create" label={s.createGroup} onPress={() => { void pressCreate() }} />
            <Button key="later" label={s.later} onPress={() => { isPaneOpen = false; void $.ui.close({ id: PANE }) }} />
          </Box>
          {versionBlock(allSections)}
        </Box>
      )
    }
    // ui-13：示範機器人只在這裡加進要畫的名單（本機、不經中繼）；下面的在線人數、isAlone、移除編號都照真的 list 算
    // R6-02：示範機器人改成獨立一塊（下面的 demoCard），不混進好友清單與離線清單；已隱藏就不加
    const drawn = list.length > 0 ? withDemoBot(list, l, Date.now(), isDemoHidden) : list
    const demoFriend = drawn.find(isDemoBot)
    const sorted = drawn.filter(f => !isDemoBot(f)).sort((a, b) => ORDER[a.presence] - ORDER[b.presence] || a.name.localeCompare(b.name))
    const online = list.filter(f => f.presence !== 'offline' && !f.isMe).length
    // 好友看到的是中繼上自己那一筆（可能是別的對話送的），不是這個對話自己的分類
    const meOnRelay = list.find(f => f.isMe)
    // ui-4：列表拿到了、但群組裡只有自己 → 教怎麼邀請
    const isAlone = list.length > 0 && !list.some(f => !f.isMe)
    const removeRoster = list.filter(f => !f.isMe)
    const demoCard = (key: string, buttonKey: string, isBoxed: boolean) => demoFriend ? (
      <Box key={key} flexDirection="column" {...(isBoxed ? { borderStyle: 'round', borderColor: 'inactive', borderDimColor: true, paddingX: 1 } : { marginTop: 1 })}>
        <Text bold wrap="truncate-end">{demoFriend.name}</Text>
        <Text dimColor wrap="truncate-end">{s.demoLabel}</Text>
        <Box flexDirection="row"><Button key={buttonKey} label={s.demoHide} onPress={() => { void setDemoHidden($, true) }} /></Box>
      </Box>
    ) : null
    const pressRemove = async (target: Friend, onTerminal = false) => {
      const l2 = await read($, lang)
      const s2 = t(l2)
      const cur = await getMembership($)
      if (!cur?.isOwner || !removeRoster.some(f => f.id === target.id) || !(await confirmRemove($, s2, removeWho(target, removeRoster, l2, onTerminal)))) return
      const now = await getMembership($)
      if (!isSameMember(now, cur) || !now.isOwner) { $.ui.toast(s2.removeFailed); return }
      $.ui.toast(removeText(await removeMember($, cur, target.id), s2))
    }
    const pausedHint = mine.isPaused ? <Text dimColor wrap="truncate-end">{s.pausedHint}</Text> : null
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
          const out = await inviteText($, l2, cur.relay, cur.invite)
          if (!out) return
          const r = await $.ui.copy({ text: out.text, surface: press.surface })
          $.ui.toast(r.isCopied ? out.toast : s2.copyFailed)
        })()
      }} />
    )
    // ui-22：換頭像（兩步選，只能選清單內的）
    const avatarButton = (
      <Button key="avatar" label={s.changeAvatar} onPress={() => {
        void (async () => {
          const s2 = t(await read($, lang))
          const a = await pickAvatar($, s2)
          if (!a) { $.ui.toast(s2.avatarCancelled); return }
          await setAvatar($, a)
          $.ui.toast(s2.avatarSet(`${AVATAR_EMOJI[a]} ${a}`))
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
          // L-16：確認框開著的時候，別的對話可能已經離開或換了群組：那就什麼都不做（不去退那個舊群組），pane 換成現在的狀態
          const now = await getMembership($)
          if (!isSameMember(now, cur)) {
            await update($, friends, () => [])
            await setGroup($, now)
            void tick($, true)
            $.ui.toast(s2.leaveStale)
            return
          }
          const r = await leaveGroup($, cur, s2, false)
          $.ui.toast(leaveText(r, s2))
        })()
      }}>
        <Text dimColor>{s.leave}</Text>
      </Button>
    )
    const nameButton = (
      <Button key="name" label={s.changeName} onPress={() => {
        void (async () => {
          const s2 = t(await read($, lang))
          const cur = await getMembership($)
          if (!cur) return
          const answer = await askNewName($, s2)
          if (answer.invalid) { $.ui.toast(s2.nameInvalid); return }
          if (!answer.name) { $.ui.toast(s2.nameCancelled); return }
          try {
            await renameSelf($, cur, answer.name)
            $.ui.toast(s2.nameChanged)
          } catch (err) {
            $.ui.toast(s2.error(errorText(err, s2)))
          }
        })()
      }} />
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

    // 桌面版／手機版（ui-8：主人 10-12 看兩張粗版選「像 Spotify 好友動態」drafts/ui-8/shots/spotify.png）：
    // 上：標題＋群組名·在線人數；中：每位朋友三行（名字＋時間、在做什麼、類別·狀態）；離線收進灰框；下：「你」＋按鈕
    // 只借版面，不借對方的品牌（綠色、等化器圖示、英文功能名都不用）
    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const avatar = (f: Friend, size: number) => {
        const a = avatarOf(f)
        const alt = s.avatarAlt(f.name, s.presence[f.presence], a ? s.avatarName[a] : undefined)
        return <Svg source={avatarSvg(f.id, f.name, f.presence, size, 'dot', a, alt)} alt={alt} width={size} height={size} />
      }
      const actionLabel = (a: string) => ACTION_LABEL[l][isAction(a) ? a : 'other']
      const subjectLabel = (x: string) => SUBJECT_LABEL[l][isSubject(x) ? x : 'other']
      const others = sorted.filter(f => !f.isMe)
      const onlineFriends = others.filter(f => f.presence !== 'offline')
      // ui-17（主人 10-12「離線應該是以灰色的框框」）：離線的人放進獨立的灰框小節，最近上線的在前
      const offlineFriends = others.filter(f => f.presence === 'offline').sort((a, b) => a.seenAgoSec - b.seenAgoSec)
      const feed = [...onlineFriends].sort((a, b) => (a.activityAgoSec ?? Infinity) - (b.activityAgoSec ?? Infinity))
      // 高度不夠時先把離線框收成只剩標題，再把動態收成「還有 N 位」，自己的那一區與按鈕一定留著
      const rows = e.props.scroll ? e.props.scroll.bodyRows : 100
      // 標題 2＋間距 1；「你」標籤 1＋動態 1＋按鈕 1＋間距 1＋離開 1＋間距 1；區塊間距 2
      // R6-02：示範卡（上下框線 2＋三行）＋框外間距 1
      const fixedRows = 3 + (n.isOk ? 0 : 1) + (updateRow ? updateRows + 1 : 0) + 6 + (pausedHint ? 1 : 0) + 2 + (versionRow ? versionRows + 1 : 0) + (demoFriend ? 6 : 0)
      // 每位朋友：三行字＋上面空一行
      const CARD_ROWS = 4
      // 離線框：上下框線 2＋標題 1＋框外間距 1，每人 2 行（頭像），多的收成「還有 N 位」1 行
      const OFFLINE_MAX = 3
      const OFFLINE_FRAME = 4
      const wantOffline = Math.min(offlineFriends.length, OFFLINE_MAX)
      const offlineRowsFor = (k: number) => (offlineFriends.length ? OFFLINE_FRAME + 2 * k + (offlineFriends.length > k ? 1 : 0) : 0)
      const feedFloor = CARD_ROWS * Math.min(feed.length, 1)
      const shownOfflineN = rows - fixedRows - offlineRowsFor(wantOffline) >= feedFloor ? wantOffline : 0
      const shownOffline = offlineFriends.slice(0, shownOfflineN)
      const moreOffline = offlineFriends.length - shownOffline.length
      const offlineRows = offlineRowsFor(shownOfflineN)
      const roomFeed = Math.max(1, Math.floor((rows - fixedRows - offlineRows) / CARD_ROWS))
      const shownFeed = feed.length > roomFeed ? feed.slice(0, Math.max(0, roomFeed - 1)) : feed
      const moreFeed = feed.length - shownFeed.length
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text bold>{s.feedTitle}</Text>
              {langButton}
            </Box>
            <Text dimColor wrap="truncate-end">{`${g.name} · ${s.online(online)}`}</Text>
          </Box>
          {!n.isOk && <Text color="error" wrap="truncate-end">{n.error}</Text>}
          {updateRow}
          <Box flexDirection="column">
            {list.length === 0 && <Text dimColor>{s.loading}</Text>}
            {isAlone && <Text dimColor>{s.alone}</Text>}
            {shownFeed.map(f => {
              const when = f.action !== '' ? ago(f.activityAgoSec, l) : ''
              const third = [f.action !== '' ? subjectLabel(f.subject) : '', s.presence[f.presence], oldTag(f)].filter(Boolean).join(' · ')
              return (
                <Box key={f.id} flexDirection="row" gap={1} marginTop={1}>
                  {avatar(f, 36)}
                  <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                    <Box flexDirection="row" justifyContent="space-between" gap={1}>
                      <Text bold wrap="truncate-end">{f.name}</Text>
                      <Box flexDirection="row" gap={1}>
                        {when !== '' && <Text dimColor>{when}</Text>}
                        {g.isOwner && !isDemoBot(f) && <Button key={'remove-' + f.id} label={s.removeButton} onPress={() => { void pressRemove(f) }} />}
                      </Box>
                    </Box>
                    {f.action !== '' ? <Text wrap="truncate-end">{actionLabel(f.action)}</Text> : <Text dimColor>{s.noActivity}</Text>}
                    <Text dimColor wrap="truncate-end">{third}</Text>
                  </Box>
                </Box>
              )
            })}
            {moreFeed > 0 && <Text dimColor>{s.more(moreFeed)}</Text>}
          </Box>
          {offlineFriends.length > 0 && (
            <Box key="offline" flexDirection="column" borderStyle="round" borderColor="inactive" borderDimColor paddingX={1}>
              <Text dimColor>{s.offlineTitle(offlineFriends.length)}</Text>
              {shownOffline.map(f => (
                <Box key={'off-' + f.id} flexDirection="row" gap={1} alignItems="center" marginTop={1}>
                  {avatar(f, 24)}
                  <Text dimColor wrap="truncate-end">{f.name}</Text>
                  <Text dimColor wrap="truncate-end">{s.lastSeen(ago(f.seenAgoSec, l)) + (oldTag(f) ? ` · ${oldTag(f)}` : '')}</Text>
                  {g.isOwner && !isDemoBot(f) && <Button key={'remove-off-' + f.id} label={s.removeButton} onPress={() => { void pressRemove(f) }} />}
                </Box>
              ))}
              {moreOffline > 0 && <Text dimColor>{shownOffline.length ? s.more(moreOffline) : s.offlineList(offlineFriends.map(f => f.name).join(l === 'zh-TW' ? '、' : ', '))}</Text>}
            </Box>
          )}
          {demoCard('demo', 'hide-demo-bot', true)}
          <Box flexDirection="column">
            <Text dimColor wrap="truncate-end">{s.youLabel + (meOnRelay ? ` · ${meOnRelay.name}` : '')}</Text>
            <Text bold={!mine.isPaused} color={mine.isPaused ? 'warning' : undefined} wrap="truncate-end">{myLine}</Text>
            {pausedHint}
            <Box flexDirection="row" gap={1} marginTop={1}>
              {pauseButton}
              {inviteButton}
            </Box>
            <Box flexDirection="row" gap={1} marginTop={1}>
              {avatarButton}
              {nameButton}
              {leaveButton}
            </Box>
          </Box>
          {versionBlock(allSections)}
        </Box>
      )
    }

    // 終端機：沒有 Svg，行內 pane 又矮（實測約 11 行就被截）——控制項放最上面，好友一人一行，放不下就收成「還有 N 位」
    // 自己已由上面的 myLine 單獨佔一列；好友區不能再把 isMe 算進顯示／收起數。
    const terminalFriends = sorted.filter(f => !f.isMe)
    const headerBase = 5 + (n.isOk ? 0 : 1) + updateRows + (pausedHint ? 1 : 0) + (isAlone ? 2 : 0) // ui-15 改名另佔一列；邀請說明比較長，窄的終端機會折成兩行
    // 版本列只在好友都放得下時才畫：行內 pane 很矮，不拿好友的位置換版本（看版本也可以打 /friends update）
    const bodyRows = e.props.scroll ? e.props.scroll.bodyRows : Infinity
    // R6-02：示範塊（3 行＋上面空一行）排在真好友之後、版本列之前；好友都放得下、還有 4 行才畫，不拿真好友的位置換（不畫就是整塊不畫，不會剩一個沒標示的機器人）
    const isTermDemo = !!demoFriend && bodyRows - headerBase - terminalFriends.length >= 4
    const headerRows = headerBase + (isTermDemo ? 4 : 0)
    // ui-28：版本列＋按鈕（2 行）也是放得下才畫；框框再看剩幾行（ui-29 起框裡只有挑的那一個版本）
    const termRoom = bodyRows - headerRows - terminalFriends.length
    // ui-29：框裡本來就只有一個版本，放得下（含挑版本那一列）就畫，放不下就不畫框
    // 分級照舊（ui-28）：挑版本列＋那一段放得下就全畫；只放得下那一段就不畫挑版本列（跟以前「只列自己這一版」一樣）；再放不下就不畫框
    const isTermFull = termRoom - 2 >= changelogRows(allSections, bodyColumns, pickerCells)
    const isTermBare = !isTermFull && termRoom - 2 >= changelogRows(allSections, bodyColumns)
    const termSections: ChangelogSection[] = isTermFull || isTermBare ? allSections : []
    const termVersionBlock = termRoom >= 2 ? versionBlock(termSections, isTermFull) : null
    const room = e.props.scroll ? Math.max(1, e.props.scroll.bodyRows - headerRows) : terminalFriends.length
    const shown = terminalFriends.length > room ? terminalFriends.slice(0, Math.max(0, room - 1)) : terminalFriends
    const hiddenCount = terminalFriends.length - shown.length
    return (
      <Box flexDirection="column">
        {header}
        {!n.isOk && <Text color="error" wrap="truncate-end">{n.error}</Text>}
        {updateRow}
        <Text color={mine.isPaused ? 'warning' : undefined} dimColor={!mine.isPaused} wrap="truncate-end">{myLine}</Text>
        {pausedHint}
        <Box flexDirection="row" gap={1}>
          {pauseButton}
          {inviteButton}
          <Button key="refresh" label={s.refresh} onPress={() => { void tick($, true) }} />
          {/* ui-26：終端機按鈕列只留 4 個（5 個在英文約 79 欄會擠爆），換頭像用 /friends avatar；好友的頭像照樣畫在名字前（表情符號） */}
          {leaveButton}
        </Box>
        <Box flexDirection="row" gap={1}>{nameButton}</Box>
        <Box flexDirection="column" marginTop={1}>
          {sorted.length === 0 && <Text dimColor>{s.loading}</Text>}
          {isAlone && <Text dimColor>{s.alone}</Text>}
          {shown.map(f => (
            <Box key={f.id} flexDirection="row" gap={1}>
              <Text color={COLOR[f.presence]}>●</Text>
              {avatarOf(f) && <Text>{AVATAR_EMOJI[avatarOf(f)!]}</Text>}
              <Text bold wrap="truncate-end">{f.name}{f.isMe ? s.you : ''}</Text>
              <Text dimColor>{s.presence[f.presence]}</Text>
              {f.presence !== 'offline' && f.action !== '' && <Text dimColor>—</Text>}
              {f.presence !== 'offline' && f.action !== '' && (
                <Text wrap="truncate-end">{activityText(f.action, f.subject, l)}</Text>
              )}
              {f.presence !== 'offline' && f.action !== '' && (
                <Text dimColor>{ago(f.activityAgoSec, l)}</Text>
              )}
              {oldTag(f) !== '' && <Text dimColor>· {oldTag(f)}</Text>}
              {g.isOwner && !isDemoBot(f) && <Button key={'remove-term-' + f.id} label={s.removeButton} onPress={() => { void pressRemove(f, true) }} />}
            </Box>
          ))}
          {hiddenCount > 0 && <Text dimColor>{s.more(hiddenCount)}</Text>}
          {isTermDemo && demoCard('demo-term', 'hide-demo-term', false)}
        </Box>
        {termVersionBlock}
      </Box>
    )
  })
}
