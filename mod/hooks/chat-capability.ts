// CHAT-5：中繼的聊天 capability 閘門（純函式，不碰 $、不碰 store、不接面板）。
// 設計見 docs/drafts/chat5-gate-design.md。重點：
// - capability 就是 `GET /capability` 的一個簽章回應，簽章沿用 response-signing.ts（nonce、origin、method、path、status、body 全綁住），不另發金鑰
// - 只有「簽章驗過、200、內容相容」才 show；其餘一律不顯示聊天（fail closed）
// - 結果只放記憶體，最多信 10 分鐘；中繼回退或換版最多這麼久就藏起來
import { newResponseNonce, verifyRelaySignature } from './response-signing'

export const CAPABILITY_PATH = '/capability'
export const CAPABILITY_METHOD = 'GET'

/** 這版外掛要求中繼具備的聊天能力（唯一來源；中繼端的名字要照這裡對） */
export const CHAT_REQUIRED = {
  wire: 2,
  minCiphertextBytes: 2_048,
  features: ['mailbox', 'commit', 'sender-limit', 'dm-pairs', 'save-500', 'member-list'],
} as const

/** 外掛最多信一份 capability 多久；中繼只能說得比這短，不能更長 */
export const GATE_MAX_TTL_MS = 10 * 60_000
export const GATE_MIN_TTL_MS = 30_000
/** 沒有結果可信時，多久再問一次 */
export const GATE_NETWORK_RETRY_MS = 30_000
export const GATE_NEGATIVE_RETRY_MS = 5 * 60_000
/** 聊天路由出怪事時，兩次「馬上重問」至少隔這麼久 */
export const GATE_SUSPECT_MIN_GAP_MS = 10_000
/** capability 內文的長度上限（字元）；超過不驗簽、不解析 */
export const MAX_CAPABILITY_CHARS = 65_536
/** 一次探測最久等多久；fetch 卡住就當網路失敗（暫時性），不會讓閘門永遠不再重問 */
export const GATE_FETCH_TIMEOUT_MS = 10_000

const MAX_FEATURES = 256
const MAX_FEATURE_LENGTH = 64
const RELAY_VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/

export type ChatCapability = Readonly<{
  v: 1
  /** 只給診斷看，不參與判斷；中繼沒給就是空字串 */
  relayVersion: string
  enabled: boolean
  wire: readonly number[]
  maxCiphertextBytes: number
  features: readonly string[]
  ttlMs: number
}>

export type GateReason =
  | 'ok'
  | 'no-trust'      // 這個中繼網址沒有可核對的簽章金鑰：連請求都不發
  | 'network'       // 連不上、逾時
  | 'http-error'    // 簽章有效但狀態碼不是 200／404（5xx、429 算暫時的）
  | 'untrusted'     // 少了簽章標頭、簽章不符、nonce／key id 不對
  | 'relay-old'     // 簽章有效的 404：中繼還沒有 capability（舊版中繼）
  | 'bad-body'      // 簽章有效但內容不是約定格式
  | 'disabled'      // 中繼明說聊天關著
  | 'wire'          // 中繼不收這版外掛的信封版本
  | 'size'          // 中繼的密文上限比外掛需要的小
  | 'features'      // 中繼少了外掛要求的能力

export type GateResult = Readonly<{
  show: boolean
  reason: GateReason
  /** show 時才有：這份結果最多信多久 */
  ttlMs: number
  /** 暫時性失敗（網路、5xx、429）：不該拿來推翻還沒過期的 show */
  transient: boolean
  /** 這次請求發出的時間（外掛自己的時鐘）。晚到的舊結果靠它排序；show 的有效期也從這裡起算 */
  startedAt: number
}>

const deny = (reason: GateReason, startedAt: number, transient = false): GateResult => ({ show: false, reason, ttlMs: 0, transient, startedAt })

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 嚴格解析 capability 內文；格式不對回 null。多出來的欄位忽略（將來的中繼可以加），但已知欄位型別不對一律不收 */
export function parseChatCapability(text: string): ChatCapability | null {
  let data: unknown
  try { data = JSON.parse(text) } catch { return null }
  if (!isPlainObject(data) || data.v !== 1) return null
  const relayVersion = data.relayVersion ?? ''
  if (typeof relayVersion !== 'string' || (relayVersion !== '' && !RELAY_VERSION_RE.test(relayVersion))) return null
  const chat = data.chat
  if (!isPlainObject(chat) || typeof chat.enabled !== 'boolean') return null
  const wire = chat.wire
  if (!Array.isArray(wire) || wire.length > 8 || !wire.every(n => Number.isSafeInteger(n) && n >= 1 && n <= 1_000)) return null
  const max = chat.maxCiphertextBytes
  if (!Number.isSafeInteger(max) || (max as number) < 0 || (max as number) > 1_000_000) return null
  const features = chat.features
  if (!Array.isArray(features) || features.length > MAX_FEATURES || !features.every(f => typeof f === 'string' && f.length <= MAX_FEATURE_LENGTH)) return null
  const ttlSec = data.ttlSec
  if (!Number.isSafeInteger(ttlSec) || (ttlSec as number) < 1 || (ttlSec as number) > 86_400) return null
  const ttlMs = Math.min(GATE_MAX_TTL_MS, Math.max(GATE_MIN_TTL_MS, (ttlSec as number) * 1000))
  return {
    v: 1, relayVersion, enabled: chat.enabled, wire: wire as number[],
    maxCiphertextBytes: max as number, features: features as string[], ttlMs,
  }
}

/** 內容相容嗎。順序固定，回報第一個不合的原因 */
export function judgeChatCapability(cap: ChatCapability, startedAt: number): GateResult {
  if (!cap.enabled) return deny('disabled', startedAt)
  if (!cap.wire.includes(CHAT_REQUIRED.wire)) return deny('wire', startedAt)
  if (cap.maxCiphertextBytes < CHAT_REQUIRED.minCiphertextBytes) return deny('size', startedAt)
  for (const f of CHAT_REQUIRED.features) if (!cap.features.includes(f)) return deny('features', startedAt)
  return { show: true, reason: 'ok', ttlMs: cap.ttlMs, transient: false, startedAt }
}

export type SignedResponse = Readonly<{
  status: number
  headers: Readonly<Record<string, unknown>>
  text: string
}>

/** 一個已經拿到的簽章回應，判定要不要顯示聊天。不丟例外（回應是 null、欄位型別怪都算 untrusted） */
export function evaluateChatCapability(input: {
  nonce: string
  origin: string
  response: SignedResponse
  trust: { keyId: string; publicKey: string }
  startedAt: number
}): GateResult {
  const { startedAt } = input
  try {
    const { response, trust } = input
    const header = (name: string): unknown => response.headers?.[name]
    const status = Number(response.status)
    if (typeof response.text !== 'string' || !Number.isSafeInteger(status)) return deny('untrusted', startedAt)
    if (response.text.length > MAX_CAPABILITY_CHARS) {
      // 超長內文不驗簽、不解析；沒簽章的 5xx／429（代理錯誤頁）仍是暫時性，其餘當格式不對
      const transient = status === 429 || status >= 500
      return transient ? deny('untrusted', startedAt, true) : deny('bad-body', startedAt)
    }
    // 簽章先驗，再看狀態：沒簽好的 404 不能讓外掛以為「只是舊中繼」，也不能用內文做任何判斷
    const signed = verifyRelaySignature({
      nonce: input.nonce, origin: input.origin, method: CAPABILITY_METHOD, path: CAPABILITY_PATH, status, body: response.text,
      returnedNonce: header('x-friends-nonce'), keyId: header('x-friends-key-id'), expectedKeyId: trust.keyId,
      signature: header('x-friends-signature'), publicKey: trust.publicKey,
    })
    // 沒簽章的 5xx／429（代理、Cloudflare 錯誤頁、中繼缺私鑰時的 503）驗不了，但也不是中繼說「不相容」：
    // 當暫時性，不推翻還沒過期的 show（也不延長它）
    if (!signed) return deny('untrusted', startedAt, status === 429 || status >= 500)
    if (status === 404) return deny('relay-old', startedAt)
    if (status === 429 || status >= 500) return deny('http-error', startedAt, true)
    if (status !== 200) return deny('http-error', startedAt)
    const cap = parseChatCapability(response.text)
    if (!cap) return deny('bad-body', startedAt)
    return judgeChatCapability(cap, startedAt)
  } catch {
    return deny('untrusted', startedAt)
  }
}

export type GateFetch = (path: string, headers: Record<string, string>) => Promise<SignedResponse>

/**
 * 問一次中繼。nonce 一律在這裡新產生（newResponseNonce），呼叫端不能指定：新鮮度（防重放）全靠它。
 * fetch 由呼叫端包（同 relayCall 的 secure 檢查）。trust 是 null＝這個中繼沒有可核對的金鑰：不發請求。
 * now 是外掛自己的時鐘（毫秒）；fetch 超過 timeoutMs（預設 10 秒）當作網路失敗。
 * 模組裡沒有計時器（`$` 不能傳進 import 的函式），所以等待由呼叫端給：sleep 接 `(ms) => $.clock.sleep(ms)`。
 */
export function probeChatGate(deps: ProbeDeps): Promise<GateResult> {
  return probeWithNonce(deps, newResponseNonce())
}

/** 只給測試：指定 nonce（例如驗證請求標頭帶了這個值）。正式程式碼不要用。 */
export function probeChatGateWithNonce(deps: ProbeDeps, nonce: string): Promise<GateResult> {
  return probeWithNonce(deps, nonce)
}

export type ProbeDeps = Readonly<{
  origin: string
  trust: { keyId: string; publicKey: string } | null
  fetch: GateFetch
  version?: string
  /** 外掛自己的時鐘（毫秒）。必填：要跟 gateOpen／gateUpdate 用同一個時鐘（單調時鐘），否則 startedAt 和 now 不在同一個尺度上 */
  now: () => number
  /** 等 ms 毫秒後 resolve（呼叫端用 $.clock.sleep）；用來給 fetch 設時限 */
  sleep: (ms: number) => Promise<void>
  timeoutMs?: number
}>

async function probeWithNonce(deps: ProbeDeps, nonce: string): Promise<GateResult> {
  const startedAt = deps.now()
  if (!deps.trust) return deny('no-trust', startedAt)
  const headers: Record<string, string> = { 'x-friends-nonce': nonce, 'x-friends-origin': deps.origin }
  if (deps.version) headers['x-friends-version'] = deps.version
  // 時限不是有限正數（NaN、0、Infinity、負數）就用預設，不讓怪值變成「馬上逾時」或「永遠沒有時限」
  const timeoutMs = typeof deps.timeoutMs === 'number' && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : GATE_FETCH_TIMEOUT_MS
  let response: SignedResponse
  try {
    response = await Promise.race([
      deps.fetch(CAPABILITY_PATH, headers),
      deps.sleep(timeoutMs).then((): never => { throw new Error('timeout') }),
    ])
  } catch { return deny('network', startedAt, true) }
  return evaluateChatCapability({ nonce, origin: deps.origin, response, trust: deps.trust, startedAt })
}

// ---- 記憶體閘門狀態 ----

export type GateEntry = Readonly<{
  origin: string
  show: boolean
  reason: GateReason
  /** 採用這個決定的那次請求的發出時間；比它更早發出的結果晚到時丟掉 */
  decidedAt: number
  /** 最近一次套用結果的時間（外掛時鐘） */
  checkedAt: number
  /** show 到這個時間為止（從請求發出時起算）；過了就藏 */
  validUntil: number
  /** 這個時間之後才值得再問 */
  nextCheckAt: number
}>

// 時鐘被往回撥（now 比最近一次套用結果的時間還早）：不信這份紀錄，當作沒有、立刻重問。
// 只偵測得到「比最近一次探測更早」的時間；探測之後才被撥回的牆鐘偵測不到，接線時 now 請用單調時鐘（見設計短文第 8 節）
// 寫成 !(a >= b) 而不是 a < b：now 或紀錄裡有 NaN 時也當作時鐘不對（立刻重問），不會變成永遠不再重問
// 紀錄裡的四個時間欄位也要是有限數字（從別處還原或手寫的紀錄可能是 Infinity／NaN），否則一律當作不可用、立刻重問
const entryUnusable = (entry: GateEntry, now: number): boolean => !(
  Number.isFinite(entry.decidedAt) && Number.isFinite(entry.checkedAt) && Number.isFinite(entry.validUntil) && Number.isFinite(entry.nextCheckAt)
  && now >= entry.decidedAt && now >= entry.checkedAt
)

/** 現在能顯示聊天嗎。換了中繼網址、沒有結果、過期、時鐘倒退，都是 false */
export function gateOpen(entry: GateEntry | undefined, origin: string, now: number): boolean {
  return !!entry && entry.origin === origin && entry.show && !entryUnusable(entry, now) && now < entry.validUntil
}

export function gateShouldProbe(entry: GateEntry | undefined, origin: string, now: number): boolean {
  return !entry || entry.origin !== origin || entryUnusable(entry, now) || !(now < entry.nextCheckAt)
}

/**
 * 拿新結果更新狀態（now 是收到結果的時間）。
 * - 比已採用的決定更早發出的結果（晚到、亂序）直接丟掉；同一毫秒時，不讓 show 蓋過已經關掉的決定
 * - show：信到 發出時間 + min(ttl, 10 分鐘)，一半時間後再問
 * - 暫時性失敗：還沒過期的 show 保留（不延長）；本來就沒開的維持關
 * - 明確不相容（舊中繼、關閉、版本不合、簽章壞…）：立刻關，不等過期
 * 換了中繼網址時，舊網址的結果不繼承。
 */
export function gateUpdate(prev: GateEntry | undefined, result: GateResult, origin: string, now: number): GateEntry {
  // 時間不是有限數字（單調時鐘換算寫錯）：不採用任何東西，關著，下一輪馬上重問
  // 但已採用的決定的發出時間要留著，不然之後晚到的舊結果會越過順序檢查把已關的閘門重新打開；
  // 這次結果的發出時間是有限數字、而且不是暫時性失敗（等於這次也做了一個「關」的決定）時，順序記憶也要推進到它，
  // 不然「關」之後才發出的結果被洗掉，更早發出、晚到的 ok 就能重開
  if (!Number.isFinite(now) || !Number.isFinite(result.startedAt) || (result.show && !Number.isFinite(result.ttlMs))) {
    const kept = prev && prev.origin === origin && Number.isFinite(prev.decidedAt) ? prev.decidedAt : 0
    const keep = Number.isFinite(result.startedAt) && !result.transient ? Math.max(kept, result.startedAt) : kept
    return { origin, show: false, reason: result.show ? 'untrusted' : result.reason, decidedAt: keep, checkedAt: 0, validUntil: 0, nextCheckAt: 0 }
  }
  const same = prev && prev.origin === origin && !entryUnusable(prev, now) ? prev : undefined
  if (same && (result.startedAt < same.decidedAt || (result.startedAt === same.decidedAt && result.show && !same.show))) return same
  if (result.show) {
    const ttl = Math.min(GATE_MAX_TTL_MS, result.ttlMs)
    return { origin, show: true, reason: 'ok', decidedAt: result.startedAt, checkedAt: now, validUntil: result.startedAt + ttl, nextCheckAt: Math.min(now + Math.floor(ttl / 2), result.startedAt + ttl) }
  }
  if (result.transient) {
    // 暫時性失敗沒有改變決定，所以 decidedAt 不動；沒有舊決定就用這次的發出時間
    const open = !!same && same.show && now < same.validUntil
    return {
      origin, show: open, reason: open ? 'ok' : result.reason, decidedAt: same?.decidedAt ?? result.startedAt, checkedAt: now,
      validUntil: open ? same!.validUntil : 0, nextCheckAt: now + GATE_NETWORK_RETRY_MS,
    }
  }
  return { origin, show: false, reason: result.reason, decidedAt: result.startedAt, checkedAt: now, validUntil: 0, nextCheckAt: now + GATE_NEGATIVE_RETRY_MS }
}

/** 聊天路由出現不明的失敗（網路、5xx、沒有 reason 的 404）：盡快重問（兩次至少隔 10 秒），結果出來前維持原狀 */
export function gateMarkSuspect(entry: GateEntry | undefined, now: number): GateEntry | undefined {
  if (!entry) return entry
  // 時間不是有限數字：標成「立刻重問」（0），不能讓 NaN 進到 nextCheckAt 變成永遠不重問
  const next = Math.min(entry.nextCheckAt, Math.max(now, entry.checkedAt + GATE_SUSPECT_MIN_GAP_MS))
  return { ...entry, nextCheckAt: Number.isFinite(next) ? next : 0 }
}
