import { expect, test } from 'claude-code/testing'

import {
  CAPABILITY_PATH, CHAT_REQUIRED, GATE_FETCH_TIMEOUT_MS, MAX_CAPABILITY_CHARS, GATE_MAX_TTL_MS, GATE_MIN_TTL_MS, GATE_NEGATIVE_RETRY_MS, GATE_NETWORK_RETRY_MS, GATE_SUSPECT_MIN_GAP_MS,
  evaluateChatCapability, gateMarkSuspect, gateOpen, gateShouldProbe, gateUpdate, parseChatCapability, probeChatGate, probeChatGateWithNonce,
} from '../hooks/chat-capability'
import type { GateEntry, GateFetch, GateResult, SignedResponse } from '../hooks/chat-capability'
import { MAX_CHAT_CIPHERTEXT_BYTES } from '../hooks/chat-envelope'
import { nobleEd25519Sign } from '../hooks/noble-crypto.js'
import { fromB64url, responseEnvelope } from '../hooks/response-signing'
import { SEC16B_TEST_KEY } from './fixtures/sec-16b-test-key'

const ORIGIN = 'https://relay.test'
const T0 = 1_000_000
const TRUST = { keyId: SEC16B_TEST_KEY.keyId, publicKey: SEC16B_TEST_KEY.publicKey }
const PRIVATE = fromB64url(SEC16B_TEST_KEY.privateKeyPkcs8).slice(-32)

const b64url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const GOOD_BODY = {
  v: 1,
  relayVersion: '0.6.0',
  chat: { enabled: true, wire: [2], maxCiphertextBytes: 2048, features: [...CHAT_REQUIRED.features] },
  ttlSec: 600,
}

type Sign = { nonce?: string; origin?: string; method?: string; path?: string; status?: number; body?: string }

/** 假中繼：照請求帶的 nonce 簽。sign 參數讓個別測試把簽章欄位改成不對的。 */
function signed(nonce: string, status: number, text: string, sign: Sign = {}): SignedResponse {
  const signature = b64url(nobleEd25519Sign(responseEnvelope({
    nonce: sign.nonce ?? nonce, origin: sign.origin ?? ORIGIN, method: sign.method ?? 'GET',
    path: sign.path ?? CAPABILITY_PATH, status: sign.status ?? status, body: sign.body ?? text,
  }), PRIVATE))
  return { status, text, headers: { 'x-friends-nonce': nonce, 'x-friends-key-id': TRUST.keyId, 'x-friends-signature': signature } }
}

const nonceOf = (headers: Record<string, string>): string => headers['x-friends-nonce']!

/** 新版中繼：回簽過章的 capability */
const newRelay = (body: unknown = GOOD_BODY, sign: Sign = {}): GateFetch => async (_path, headers) =>
  signed(nonceOf(headers), 200, typeof body === 'string' ? body : JSON.stringify(body), sign)

/** 舊版中繼（0.5.8 以前）：沒有這條路由，Worker 對沒定義的路由回簽過章的 404 */
const oldRelay: GateFetch = async (_path, headers) => signed(nonceOf(headers), 404, JSON.stringify({ error: 'not found' }))

/** 不會到期的 sleep：一般測試裡 fetch 一定先回來 */
const never = (): Promise<void> => new Promise<void>(() => {})

const probe = (fetch: GateFetch, trust: typeof TRUST | null = TRUST) =>
  probeChatGate({ origin: ORIGIN, trust, version: '0.6.0', fetch, now: () => T0, sleep: never })

const cap = (patch: Record<string, unknown> = {}, chatPatch: Record<string, unknown> = {}) =>
  ({ ...GOOD_BODY, ...patch, chat: { ...GOOD_BODY.chat, ...chatPatch } })

// ---- 四組矩陣（新外掛兩格；舊外掛兩格是中繼端的義務，見設計短文第 5 節，這裡不能假裝測） ----

test('矩陣 新外掛＋新中繼：簽章過、相容 → 顯示聊天', async () => {
  const r = await probe(newRelay())
  expect(r).toEqual({ show: true, reason: 'ok', ttlMs: 600_000, transient: false, startedAt: T0 })
})

test('矩陣 新外掛＋舊中繼：簽章有效的 404 → 不顯示，原因 relay-old，不是暫時性', async () => {
  const r = await probe(oldRelay)
  expect(r).toEqual({ show: false, reason: 'relay-old', ttlMs: 0, transient: false, startedAt: T0 })
})

test('矩陣 新外掛＋舊中繼：沒簽章的 404 不能當成「只是舊中繼」→ untrusted', async () => {
  const r = await probe(async () => ({ status: 404, headers: {}, text: '{"error":"not found"}' }))
  expect(r.reason).toBe('untrusted')
  expect(r.show).toBe(false)
})

test('矩陣 新外掛＋沒有簽章金鑰的中繼：不發請求', async () => {
  let calls = 0
  const r = await probe(async () => { calls++; return signed('x', 200, '{}') }, null)
  expect(r.reason).toBe('no-trust')
  expect(r.show).toBe(false)
  expect(calls).toBe(0)
})

// ---- 請求長相 ----

test('請求：GET /capability，帶新 nonce、origin、版本；不帶 authorization', async () => {
  const seen: Array<{ path: string; headers: Record<string, string> }> = []
  const fetch: GateFetch = async (path, headers) => { seen.push({ path, headers }); return signed(nonceOf(headers), 200, JSON.stringify(GOOD_BODY)) }
  await probe(fetch)
  await probe(fetch)
  expect(seen.length).toBe(2)
  expect(seen[0]!.path).toBe('/capability')
  expect(Object.keys(seen[0]!.headers).sort()).toEqual(['x-friends-nonce', 'x-friends-origin', 'x-friends-version'])
  expect(seen[0]!.headers['x-friends-origin']).toBe(ORIGIN)
  expect(seen[0]!.headers['x-friends-nonce']).not.toBe(seen[1]!.headers['x-friends-nonce'])
})

// ---- 偽造與重放：每個簽章欄位各改一個，都必須不顯示 ----

test('nonce：正式入口不接受呼叫端指定；測試入口指定的值會原樣帶出去', async () => {
  const seen: string[] = []
  const fetch: GateFetch = async (_p, h) => { seen.push(nonceOf(h)); return signed(nonceOf(h), 200, JSON.stringify(GOOD_BODY)) }
  // @ts-expect-error probeChatGate 沒有 nonce 參數
  await probeChatGate({ origin: ORIGIN, trust: TRUST, fetch, nonce: 'AAAAAAAAAAAAAAAAAAAAAA', now: () => T0, sleep: never })
  expect(seen[0]).not.toBe('AAAAAAAAAAAAAAAAAAAAAA')
  expect(seen[0]!.length).toBeGreaterThanOrEqual(16)
  const r = await probeChatGateWithNonce({ origin: ORIGIN, trust: TRUST, fetch, now: () => T0, sleep: never }, 'BBBBBBBBBBBBBBBBBBBBBB')
  expect(seen[1]).toBe('BBBBBBBBBBBBBBBBBBBBBB')
  expect(r.show).toBe(true)
})

test('逾時：fetch 一直不回來 → 網路失敗（暫時性），不會讓探測永遠卡住', async () => {
  expect(GATE_FETCH_TIMEOUT_MS).toBe(10_000)
  const waits: number[] = []
  const expires = (ms: number): Promise<void> => { waits.push(ms); return Promise.resolve() }
  const r = await probeChatGate({ origin: ORIGIN, trust: TRUST, fetch: () => new Promise<SignedResponse>(() => {}), now: () => T0, sleep: expires })
  expect(r).toEqual({ show: false, reason: 'network', ttlMs: 0, transient: true, startedAt: T0 })
  expect(waits).toEqual([GATE_FETCH_TIMEOUT_MS])
  // 時限內回來的照常（fetch 已經回來，sleep 還沒到期）
  const ok = await probeChatGate({ origin: ORIGIN, trust: TRUST, fetch: newRelay(), now: () => T0, sleep: never, timeoutMs: 5_000 })
  expect(ok.show).toBe(true)
  // 時限可調
  waits.length = 0
  await probeChatGate({ origin: ORIGIN, trust: TRUST, fetch: () => new Promise<SignedResponse>(() => {}), now: () => T0, sleep: expires, timeoutMs: 1234 })
  expect(waits).toEqual([1234])
})

test('簽章：欄位被改、重放、缺標頭，一律 untrusted 且不顯示', async () => {
  const body = JSON.stringify(GOOD_BODY)
  const cases: Array<[string, GateFetch]> = [
    ['簽成別的 nonce（重放舊回應）', newRelay(GOOD_BODY, { nonce: 'AAAAAAAAAAAAAAAAAAAA' })],
    ['簽成別的 origin', newRelay(GOOD_BODY, { origin: 'https://other.test' })],
    ['簽成別的 method', newRelay(GOOD_BODY, { method: 'POST' })],
    ['簽成別的路徑（拿 /status 的簽章來冒充）', newRelay(GOOD_BODY, { path: '/status' })],
    ['簽成別的狀態碼', newRelay(GOOD_BODY, { status: 201 })],
    ['簽的內文跟送來的不同', newRelay(GOOD_BODY, { body: body + ' ' })],
    ['沒有任何簽章標頭', async () => ({ status: 200, headers: {}, text: body })],
    ['key id 不對', async (_p, h) => ({ ...signed(nonceOf(h), 200, body), headers: { ...signed(nonceOf(h), 200, body).headers, 'x-friends-key-id': 'unknown-key' } })],
    ['回的 nonce 不是我送的', async (_p, h) => ({ ...signed(nonceOf(h), 200, body), headers: { ...signed(nonceOf(h), 200, body).headers, 'x-friends-nonce': 'BBBBBBBBBBBBBBBBBBBB' } })],
    ['簽章長度不對', async (_p, h) => ({ ...signed(nonceOf(h), 200, body), headers: { ...signed(nonceOf(h), 200, body).headers, 'x-friends-signature': 'A'.repeat(85) } })],
  ]
  for (const [name, fetch] of cases) {
    const r = await probe(fetch)
    expect(`${name}:${r.reason}:${r.show}`).toBe(`${name}:untrusted:false`)
  }
})

test('簽章：用別把金鑰簽的、內文再漂亮也不顯示', async () => {
  const other = new Uint8Array(32).fill(7)
  const r = await probe(async (_p, h) => {
    const nonce = nonceOf(h)
    const text = JSON.stringify(GOOD_BODY)
    const signature = b64url(nobleEd25519Sign(responseEnvelope({ nonce, origin: ORIGIN, method: 'GET', path: CAPABILITY_PATH, status: 200, body: text }), other))
    return { status: 200, text, headers: { 'x-friends-nonce': nonce, 'x-friends-key-id': TRUST.keyId, 'x-friends-signature': signature } }
  })
  expect(r.reason).toBe('untrusted')
})

test('簽章：回應物件長得怪（null、undefined、status 不是整數、text 不是字串、headers 是 null）不丟例外', async () => {
  const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWX'
  const bad = [
    null,
    undefined,
    'text',
    42,
    { status: '200', headers: {}, text: '{}' },
    { status: 200, headers: null, text: '{}' },
    { status: 200, headers: {}, text: undefined },
    { status: Number.NaN, headers: {}, text: '{}' },
  ] as unknown as SignedResponse[]
  const bare = await probe(async () => undefined as unknown as SignedResponse)
  expect(bare.show).toBe(false)
  expect(bare.reason).toBe('untrusted')
  for (const response of bad) {
    const r = evaluateChatCapability({ nonce, origin: ORIGIN, response, trust: TRUST, startedAt: T0 })
    expect(r.show).toBe(false)
  }
})

// ---- 內容不相容 ----

test('不相容：關閉、信封版本不合、密文上限太小、少一項能力，各有固定原因', async () => {
  const expectReason = async (body: unknown, reason: string) => {
    const r = await probe(newRelay(body))
    expect(`${reason}:${r.reason}:${r.show}`).toBe(`${reason}:${reason}:false`)
  }
  await expectReason(cap({}, { enabled: false }), 'disabled')
  await expectReason(cap({}, { wire: [1] }), 'wire')
  await expectReason(cap({}, { wire: [] }), 'wire')
  await expectReason(cap({}, { maxCiphertextBytes: 2047 }), 'size')
  await expectReason(cap({}, { maxCiphertextBytes: 2016 }), 'size')
  for (const missing of CHAT_REQUIRED.features) {
    await expectReason(cap({}, { features: CHAT_REQUIRED.features.filter(f => f !== missing) }), 'features')
  }
})

test('相容：將來的中繼多列很多能力、代號長得不一樣，也不會讓整份被退件', async () => {
  const many = [...CHAT_REQUIRED.features, 'Future_Thing', 'x'.repeat(64), ...Array.from({ length: 100 }, (_, i) => 'extra-' + i)]
  expect((await probe(newRelay(cap({}, { features: many })))).show).toBe(true)
  // 但缺必要能力還是照樣判不相容
  expect((await probe(newRelay(cap({}, { features: ['Future_Thing', 'extra-1'] })))).reason).toBe('features')
})

test('相容：中繼多宣告能力、多支援信封版本、多帶未知欄位都沒關係', async () => {
  const body = { ...cap({}, { wire: [2, 3], maxCiphertextBytes: 4096, features: [...CHAT_REQUIRED.features, 'future-thing'], extra: 1 }), futureTopLevel: { a: 1 } }
  expect((await probe(newRelay(body))).show).toBe(true)
})

test('內容格式不對：簽章有效也不採用（bad-body）', async () => {
  const bads: unknown[] = [
    '{not json',
    '[]', 'null', '"x"', '5',
    { ...GOOD_BODY, v: 2 },
    { ...GOOD_BODY, v: '1' },
    { ...GOOD_BODY, relayVersion: 'not a version!' },
    { ...GOOD_BODY, relayVersion: 'x'.repeat(33) },
    { ...GOOD_BODY, relayVersion: 6 },
    { ...GOOD_BODY, ttlSec: 0 },
    { ...GOOD_BODY, ttlSec: 1.5 },
    { ...GOOD_BODY, ttlSec: 86_401 },
    { ...GOOD_BODY, ttlSec: '600' },
    { ...GOOD_BODY, chat: undefined },
    { ...GOOD_BODY, chat: [] },
    cap({}, { enabled: 'true' }),
    cap({}, { enabled: undefined }),
    cap({}, { wire: '2' }),
    cap({}, { wire: [2.5] }),
    cap({}, { wire: [0] }),
    cap({}, { wire: Array.from({ length: 9 }, (_, i) => i + 1) }),
    cap({}, { maxCiphertextBytes: -1 }),
    cap({}, { maxCiphertextBytes: '2048' }),
    cap({}, { maxCiphertextBytes: 1e9 }),
    cap({}, { features: 'mailbox' }),
    cap({}, { features: [1] }),
    cap({}, { features: Array.from({ length: 257 }, (_, i) => 'f' + i) }),
    cap({}, { features: ['x'.repeat(65)] }),
    cap({}, { features: [null] }),
  ]
  for (const body of bads) {
    const r = await probe(newRelay(body))
    expect(`${JSON.stringify(body)}:${r.reason}:${r.show}`).toBe(`${JSON.stringify(body)}:bad-body:false`)
  }
})

test('parseChatCapability：ttl 夾在 30 秒到 10 分鐘之間，中繼只能縮短不能拉長', async () => {
  expect(parseChatCapability(JSON.stringify({ ...GOOD_BODY, ttlSec: 1 }))!.ttlMs).toBe(GATE_MIN_TTL_MS)
  expect(parseChatCapability(JSON.stringify({ ...GOOD_BODY, ttlSec: 120 }))!.ttlMs).toBe(120_000)
  expect(parseChatCapability(JSON.stringify({ ...GOOD_BODY, ttlSec: 86_400 }))!.ttlMs).toBe(GATE_MAX_TTL_MS)
  // JSON 裡的 "__proto__" 是普通的自有欄位，不會變成原型：chat 沒有自己的 enabled 就是格式不對，不是繼承來的 true
  const polluted = JSON.stringify(GOOD_BODY.chat).replace('"enabled":true,', '')
  const text = `{"v":1,"ttlSec":600,"chat":{"__proto__":{"enabled":true},${polluted.slice(1)}}`
  expect(parseChatCapability(text)).toBe(null)
  expect(({} as { enabled?: boolean }).enabled).toBe(undefined)
})

test('relayVersion 只是診斷資訊：沒給也相容', async () => {
  const { relayVersion: _drop, ...noVersion } = GOOD_BODY
  expect((await probe(newRelay(noVersion))).show).toBe(true)
  expect(parseChatCapability(JSON.stringify(noVersion))!.relayVersion).toBe('')
  expect((await probe(newRelay({ ...GOOD_BODY, relayVersion: '0.6.0-rc1' }))).show).toBe(true)
})

// ---- 暫時性失敗與非 200 ----

test('網路例外、5xx、429 是暫時性；其他非 200 不是', async () => {
  const net = await probe(async () => { throw new Error('connect ECONNREFUSED') })
  expect(net).toEqual({ show: false, reason: 'network', ttlMs: 0, transient: true, startedAt: T0 })
  for (const status of [500, 502, 503, 429]) {
    const r = await probe(async (_p, h) => signed(nonceOf(h), status, '{"error":"x"}'))
    expect(`${status}:${r.reason}:${r.transient}`).toBe(`${status}:http-error:true`)
  }
  for (const status of [400, 401, 403, 301]) {
    const r = await probe(async (_p, h) => signed(nonceOf(h), status, '{"error":"x"}'))
    expect(`${status}:${r.reason}:${r.transient}`).toBe(`${status}:http-error:false`)
  }
  // 沒簽章的 5xx：見下面「閘門：沒簽章的 5xx」
})

// ---- 與信封常數對齊 ----

test('CHAT_REQUIRED 跟信封一致：外掛要的密文上限不小於外掛自己會送的最大密文', async () => {
  expect(CHAT_REQUIRED.wire).toBe(2)
  expect(CHAT_REQUIRED.minCiphertextBytes).toBeGreaterThanOrEqual(MAX_CHAT_CIPHERTEXT_BYTES)
  expect(new Set(CHAT_REQUIRED.features).size).toBe(CHAT_REQUIRED.features.length)
})

// ---- 記憶體閘門狀態 ----

/** 做一個結果：startedAt 是請求發出的時間 */
const ok = (startedAt: number, ttlMs = 600_000): GateResult => ({ show: true, reason: 'ok', ttlMs, transient: false, startedAt })
const net = (startedAt: number): GateResult => ({ show: false, reason: 'network', ttlMs: 0, transient: true, startedAt })
const old = (startedAt: number): GateResult => ({ show: false, reason: 'relay-old', ttlMs: 0, transient: false, startedAt })

test('閘門：沒有結果、換了中繼網址都不開', async () => {
  expect(gateOpen(undefined, ORIGIN, 0)).toBe(false)
  const e = gateUpdate(undefined, ok(1_000), ORIGIN, 1_000)
  expect(gateOpen(e, ORIGIN, 1_000)).toBe(true)
  expect(gateOpen(e, 'https://other.test', 1_000)).toBe(false)
  expect(gateShouldProbe(e, 'https://other.test', 1_000)).toBe(true)
})

test('閘門：開 10 分鐘（從請求發出時起算），過期就關；過一半時間值得再問', async () => {
  const e = gateUpdate(undefined, ok(1_000), ORIGIN, 1_000)
  expect(e.validUntil).toBe(1_000 + GATE_MAX_TTL_MS)
  expect(gateOpen(e, ORIGIN, 1_000 + GATE_MAX_TTL_MS - 1)).toBe(true)
  expect(gateOpen(e, ORIGIN, 1_000 + GATE_MAX_TTL_MS)).toBe(false)
  expect(gateShouldProbe(e, ORIGIN, 1_000 + 299_999)).toBe(false)
  expect(gateShouldProbe(e, ORIGIN, 1_000 + 300_000)).toBe(true)
  // 結果自己帶的 ttl 比上限長也只信上限
  const long = gateUpdate(undefined, ok(0, 10 * GATE_MAX_TTL_MS), ORIGIN, 0)
  expect(long.validUntil).toBe(GATE_MAX_TTL_MS)
  // 回應慢了 20 秒才到：有效期從發出時算，不是從收到時算
  const slow = gateUpdate(undefined, ok(0), ORIGIN, 20_000)
  expect(slow.validUntil).toBe(GATE_MAX_TTL_MS)
  // 回應 400 秒才到：下次檢查不能排在已經過期之後
  const verySlow = gateUpdate(undefined, ok(0), ORIGIN, 400_000)
  expect(verySlow.nextCheckAt).toBe(GATE_MAX_TTL_MS)
  expect(verySlow.nextCheckAt).toBeLessThanOrEqual(verySlow.validUntil)
})

test('閘門：暫時性失敗保留還沒過期的開啟狀態，但不延長；過期後就關', async () => {
  const open = gateUpdate(undefined, ok(0), ORIGIN, 0)
  const afterNet = gateUpdate(open, net(400_000), ORIGIN, 400_000)
  expect(afterNet.validUntil).toBe(open.validUntil)
  expect(afterNet.decidedAt).toBe(open.decidedAt)
  expect(gateOpen(afterNet, ORIGIN, 500_000)).toBe(true)
  expect(afterNet.nextCheckAt).toBe(400_000 + GATE_NETWORK_RETRY_MS)
  const again = gateUpdate(afterNet, net(600_000), ORIGIN, 600_000)
  expect(gateOpen(again, ORIGIN, 600_000)).toBe(false)
  // 本來就沒開，網路失敗不會變開
  expect(gateOpen(gateUpdate(undefined, net(0), ORIGIN, 0), ORIGIN, 1)).toBe(false)
})

test('閘門：中繼回退成舊版（簽章有效的 404）→ 立刻關，不等過期', async () => {
  const open = gateUpdate(undefined, ok(0), ORIGIN, 0)
  const rolledBack = gateUpdate(open, old(10_000), ORIGIN, 10_000)
  expect(gateOpen(rolledBack, ORIGIN, 10_000)).toBe(false)
  expect(rolledBack.reason).toBe('relay-old')
  expect(rolledBack.nextCheckAt).toBe(10_000 + GATE_NEGATIVE_RETRY_MS)
  // 之後中繼又升回新版，下一次問到就重新打開
  expect(gateOpen(gateUpdate(rolledBack, ok(400_000), ORIGIN, 400_000), ORIGIN, 400_000)).toBe(true)
})

test('閘門：任何明確不相容（含簽章壞掉）都立刻關', async () => {
  for (const reason of ['untrusted', 'bad-body', 'disabled', 'wire', 'size', 'features', 'http-error', 'no-trust'] as const) {
    const open = gateUpdate(undefined, ok(0), ORIGIN, 0)
    const next = gateUpdate(open, { show: false, reason, ttlMs: 0, transient: false, startedAt: 5 }, ORIGIN, 5)
    expect(`${reason}:${gateOpen(next, ORIGIN, 5)}`).toBe(`${reason}:false`)
  }
})

test('閘門：沒簽章的 5xx 當暫時性（不推翻還沒過期的開啟，也不延長）；沒簽章的 200 不行', async () => {
  const unsigned503 = await probe(async () => ({ status: 503, headers: {}, text: '{}' }))
  expect(unsigned503).toEqual({ show: false, reason: 'untrusted', ttlMs: 0, transient: true, startedAt: T0 })
  const unsigned200 = await probe(async () => ({ status: 200, headers: {}, text: JSON.stringify(GOOD_BODY) }))
  expect(unsigned200.transient).toBe(false)
  const open = gateUpdate(undefined, ok(0), ORIGIN, 0)
  const next = gateUpdate(open, { ...unsigned503, startedAt: 100_000 }, ORIGIN, 100_000)
  expect(gateOpen(next, ORIGIN, 100_000)).toBe(true)
  expect(next.validUntil).toBe(open.validUntil)
  const bad200 = gateUpdate(open, { ...unsigned200, startedAt: 100_000 }, ORIGIN, 100_000)
  expect(gateOpen(bad200, ORIGIN, 100_000)).toBe(false)
})

test('沒簽章的非 5xx／429 一律不是暫時性（代理頁、被攔截的網路不能讓開著的閘門續命）', async () => {
  for (const status of [200, 301, 400, 403, 404]) {
    const r = await probe(async () => ({ status, headers: {}, text: JSON.stringify(GOOD_BODY) }))
    expect(`${status}:${r.reason}:${r.transient}`).toBe(`${status}:untrusted:false`)
  }
})

test('內文太長：不驗簽、不解析，直接當格式不對', async () => {
  const huge = JSON.stringify({ ...GOOD_BODY, pad: 'x'.repeat(MAX_CAPABILITY_CHARS) })
  const r = await probe(newRelay(huge))
  expect(r.reason).toBe('bad-body')
  expect(r.show).toBe(false)
})

test('閘門：時間不是有限數字（NaN）→ 不採用、關著、下一輪馬上重問', async () => {
  const bad = gateUpdate(undefined, ok(Number.NaN), ORIGIN, 1_000)
  expect(gateOpen(bad, ORIGIN, 1_000)).toBe(false)
  expect(gateShouldProbe(bad, ORIGIN, 1_000)).toBe(true)
  const bad2 = gateUpdate(undefined, ok(1_000), ORIGIN, Number.NaN)
  expect(gateOpen(bad2, ORIGIN, 1_000)).toBe(false)
  expect(gateShouldProbe(bad2, ORIGIN, 1_000)).toBe(true)
  // 已經開著的閘門，拿 NaN 的 now 去問也不會說開、也不會說不用重問
  const open = gateUpdate(undefined, ok(0), ORIGIN, 0)
  expect(gateOpen(open, ORIGIN, Number.NaN)).toBe(false)
  expect(gateShouldProbe(open, ORIGIN, Number.NaN)).toBe(true)
  // NaN 的結果蓋不掉已經採用的有效決定以外的東西：之後有效的結果照常打開
  expect(gateOpen(gateUpdate(bad, ok(2_000), ORIGIN, 2_000), ORIGIN, 2_000)).toBe(true)
})

test('閘門：gateMarkSuspect 收到 NaN／Infinity 的時間，下一次檢查不會變成 NaN（永遠不重問）', async () => {
  const open = gateUpdate(undefined, ok(0), ORIGIN, 0)
  const closed = gateUpdate(open, old(10_000), ORIGIN, 10_000)
  for (const entry of [open, closed]) {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const s = gateMarkSuspect(entry, bad) as GateEntry
      expect(`${bad}:${Number.isNaN(s.nextCheckAt)}`).toBe(`${bad}:false`)
      expect(`${bad}:${gateShouldProbe(s, ORIGIN, 1_000_000)}`).toBe(`${bad}:true`)
    }
  }
  // 結果裡的 ttl 不是有限數字：不採用、關著、馬上重問
  const weird = gateUpdate(undefined, { show: true, reason: 'ok', ttlMs: Number.NaN, transient: false, startedAt: 0 }, ORIGIN, 0)
  expect(gateOpen(weird, ORIGIN, 1)).toBe(false)
  expect(gateShouldProbe(weird, ORIGIN, 1)).toBe(true)
  // 紀錄裡就算有 NaN，也不會讓 gateShouldProbe 說「不用重問」
  expect(gateShouldProbe({ ...open, nextCheckAt: Number.NaN }, ORIGIN, 1_000)).toBe(true)
})

test('閘門：非有限時間的更新不會洗掉順序記憶（之後晚到的舊 ok 不能重開已關的閘門）', async () => {
  const closed = gateUpdate(undefined, old(200), ORIGIN, 210)
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const afterBadResult = gateUpdate(closed, ok(bad), ORIGIN, 220)
    expect(afterBadResult.decidedAt).toBe(200)
    expect(afterBadResult.reason).not.toBe('ok')
    expect(gateOpen(gateUpdate(afterBadResult, ok(100), ORIGIN, 230), ORIGIN, 230)).toBe(false)
    const afterBadNow = gateUpdate(closed, ok(250), ORIGIN, bad)
    expect(afterBadNow.decidedAt).toBe(250) // 發出時間 250 是有限的，這次算一個「關」的決定，順序記憶推進到它
    expect(gateOpen(gateUpdate(afterBadNow, ok(100), ORIGIN, 300), ORIGIN, 300)).toBe(false)
  }
})

test('閘門：「關」的結果搭配非有限的 now 也要推進順序記憶（之後更早發出、晚到的 ok 不能重開）', async () => {
  const open = gateUpdate(undefined, ok(100), ORIGIN, 110)
  expect(gateOpen(open, ORIGIN, 120)).toBe(true)
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const closed = gateUpdate(open, old(200), ORIGIN, bad)
    expect(`${bad}:${closed.show}:${closed.decidedAt}`).toBe(`${bad}:false:200`)
    const late = gateUpdate(closed, ok(150), ORIGIN, 300)
    expect(`${bad}:${gateOpen(late, ORIGIN, 300)}`).toBe(`${bad}:false`)
    // 要開著的結果（ok）搭配壞掉的 now 也是一個「關」的決定
    const closedByOk = gateUpdate(open, ok(200), ORIGIN, bad)
    expect(`${bad}:${closedByOk.show}:${closedByOk.decidedAt}`).toBe(`${bad}:false:200`)
    expect(`${bad}:${gateOpen(gateUpdate(closedByOk, ok(150), ORIGIN, 300), ORIGIN, 300)}`).toBe(`${bad}:false`)
  }
  // 晚到的更舊結果不能把順序記憶往回拉
  expect(gateUpdate(open, old(50), ORIGIN, Number.NaN).decidedAt).toBe(100)
  // 暫時性失敗沒有改變決定，不推進順序記憶（不然之後 100～200 之間發出、晚到的正常 ok 會被丟掉）
  expect(gateUpdate(open, net(200), ORIGIN, Number.NaN).decidedAt).toBe(100)
})

test('閘門：紀錄裡的時間欄位是 Infinity／NaN 也不會永遠開著或永遠不重問', async () => {
  const open = gateUpdate(undefined, ok(0), ORIGIN, 0)
  for (const field of ['validUntil', 'nextCheckAt', 'decidedAt', 'checkedAt'] as const) {
    for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const broken = { ...open, [field]: bad } as GateEntry
      expect(`${field}=${bad}:${gateOpen(broken, ORIGIN, 1_000)}`).toBe(`${field}=${bad}:false`)
      expect(`${field}=${bad}:${gateShouldProbe(broken, ORIGIN, 1_000)}`).toBe(`${field}=${bad}:true`)
    }
  }
})

test('逾時時限不是有限正數就用預設（NaN、0、負數、Infinity 不能變成馬上逾時或永遠沒有時限）', async () => {
  const waits: number[] = []
  const expires = (ms: number): Promise<void> => { waits.push(ms); return Promise.resolve() }
  const hang = () => new Promise<SignedResponse>(() => {})
  for (const timeoutMs of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
    await probeChatGate({ origin: ORIGIN, trust: TRUST, fetch: hang, now: () => T0, sleep: expires, timeoutMs })
  }
  expect(waits).toEqual([GATE_FETCH_TIMEOUT_MS, GATE_FETCH_TIMEOUT_MS, GATE_FETCH_TIMEOUT_MS, GATE_FETCH_TIMEOUT_MS])
})

test('內文太長：沒簽章的 5xx／429 仍是暫時性，其他才是 bad-body', async () => {
  const text = 'x'.repeat(MAX_CAPABILITY_CHARS + 1)
  for (const status of [500, 503, 429]) {
    const r = await probe(async () => ({ status, headers: {}, text }))
    expect(`${status}:${r.reason}:${r.transient}`).toBe(`${status}:untrusted:true`)
  }
  const r = await probe(async () => ({ status: 200, headers: {}, text }))
  expect(`${r.reason}:${r.transient}`).toBe('bad-body:false')
})

test('閘門：晚到的舊結果不能把已經關掉的閘門重新打開（亂序）', async () => {
  const open = gateUpdate(undefined, ok(0), ORIGIN, 0)
  const closed = gateUpdate(open, old(10_000), ORIGIN, 10_000)       // t=10s 收到「舊中繼」
  const late = gateUpdate(closed, ok(5_000), ORIGIN, 10_500)         // 更早（t=5s）發出的 ok 在 t=10.5s 才回來
  expect(late).toEqual(closed)
  expect(gateOpen(late, ORIGIN, 10_500)).toBe(false)
  // 晚到的舊暫時性失敗也不改狀態
  expect(gateUpdate(closed, net(1_000), ORIGIN, 11_000)).toEqual(closed)
  // 比較新的 ok 當然可以重新打開
  expect(gateOpen(gateUpdate(closed, ok(20_000), ORIGIN, 20_100), ORIGIN, 20_100)).toBe(true)
  // 同一毫秒發出的：不讓 show 蓋過已經關掉的決定
  const tie = gateUpdate(closed, ok(10_000), ORIGIN, 10_001)
  expect(gateOpen(tie, ORIGIN, 10_001)).toBe(false)
  // 反過來，晚到的舊 404 也不能關掉比它新的 ok
  const fresh = gateUpdate(undefined, ok(50_000), ORIGIN, 50_100)
  expect(gateUpdate(fresh, old(40_000), ORIGIN, 50_200)).toEqual(fresh)
})

test('閘門：時鐘比最近一次探測更早 → 不信舊紀錄、立刻重問（探測之後才撥回的牆鐘偵測不到，接線時要用單調時鐘）', async () => {
  const open = gateUpdate(undefined, ok(1_000_000), ORIGIN, 1_000_000)
  const back = 1_000_000 - 3_600_000
  expect(gateOpen(open, ORIGIN, back)).toBe(false)
  expect(gateShouldProbe(open, ORIGIN, back)).toBe(true)
  // 倒退後拿到新結果：從新時鐘重新算，不繼承倒退前的紀錄
  const renewed = gateUpdate(open, old(back), ORIGIN, back + 10)
  expect(renewed.decidedAt).toBe(back)
  expect(gateOpen(renewed, ORIGIN, back + 10)).toBe(false)
})

test('閘門：換了中繼網址後，舊網址的暫時失敗保護不繼承', async () => {
  const open = gateUpdate(undefined, ok(0), 'https://a.test', 0)
  const b = gateUpdate(open, net(1), 'https://b.test', 1)
  expect(gateOpen(b, 'https://b.test', 1)).toBe(false)
  expect(gateOpen(b, 'https://a.test', 1)).toBe(false)
})

test('閘門：聊天路由出怪事 → 盡快重問（兩次至少隔 10 秒），結果出來前維持原狀', async () => {
  const open = gateUpdate(undefined, ok(0), ORIGIN, 0)      // checkedAt=0，nextCheckAt=300_000
  expect(gateOpen(gateMarkSuspect(open, 1_000), ORIGIN, 1_000)).toBe(true)
  expect(gateShouldProbe(gateMarkSuspect(open, 1_000), ORIGIN, 1_000)).toBe(false)   // 剛問過 1 秒，要等到 10 秒
  expect(gateShouldProbe(gateMarkSuspect(open, 1_000), ORIGIN, GATE_SUSPECT_MIN_GAP_MS)).toBe(true)
  // 剛問過（checkedAt 100_000）又出怪事：要等到 110_000 才再問，不是馬上
  const justChecked = gateUpdate(open, ok(100_000), ORIGIN, 100_000)
  const s1 = gateMarkSuspect(justChecked, 101_000) as GateEntry
  expect(gateShouldProbe(s1, ORIGIN, 101_000)).toBe(false)
  expect(gateShouldProbe(s1, ORIGIN, 100_000 + GATE_SUSPECT_MIN_GAP_MS)).toBe(true)
  // 標記不會把下一次檢查往後推
  const s2 = gateMarkSuspect(s1, 102_000) as GateEntry
  expect(s2.nextCheckAt).toBeLessThanOrEqual(s1.nextCheckAt)
  expect(gateMarkSuspect(undefined, 1)).toBe(undefined)
})

// ---- 完整流程：同一個假中繼先新、後回退、再升回 ----

test('流程：新 → 回退到舊 → 升回新，閘門跟著走', async () => {
  let relay: GateFetch = newRelay()
  const fetch: GateFetch = (path, headers) => relay(path, headers)
  let entry: GateEntry | undefined
  const tick = async (now: number) => {
    if (gateShouldProbe(entry, ORIGIN, now)) {
      const result = await probeChatGate({ origin: ORIGIN, trust: TRUST, fetch, now: () => now, sleep: never })
      entry = gateUpdate(entry, result, ORIGIN, now)
    }
    return gateOpen(entry, ORIGIN, now)
  }
  expect(await tick(0)).toBe(true)
  expect(await tick(60_000)).toBe(true)            // 還沒到再問的時間
  relay = oldRelay                                  // 部署出事，回滾到舊版
  expect(await tick(120_000)).toBe(true)           // 還沒到再問的時間：最多再開到下一次問（5 分鐘）
  expect(await tick(300_000)).toBe(false)          // 問到舊版，立刻關
  relay = newRelay()
  expect(await tick(400_000)).toBe(false)          // 負面結果 5 分鐘內不重問
  expect(await tick(600_001)).toBe(true)
})
