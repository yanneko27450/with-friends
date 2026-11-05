// CHAT-5R：外掛端拿「中繼實際產生的位元組」跑閘門（relay/chat5r.test.mjs 逐位元組保證夾具＝中繼的 capabilityBody() 輸出）。
// chat-capability.test.ts 用手寫的本文；這支補上「手寫的和真的不一樣」這個縫：中繼多一個少一個 feature、改了 wire、改了上限，這裡會紅。
import { expect, test } from 'claude-code/testing'

import {
  CAPABILITY_PATH, CHAT_REQUIRED, GATE_MAX_TTL_MS, GATE_MIN_TTL_MS, evaluateChatCapability, gateOpen, gateShouldProbe, gateUpdate, parseChatCapability, probeChatGate,
} from '../hooks/chat-capability'
import type { GateEntry, GateFetch, GateResult, SignedResponse } from '../hooks/chat-capability'
import { nobleEd25519Sign } from '../hooks/noble-crypto.js'
import { fromB64url, responseEnvelope } from '../hooks/response-signing'
import { SEC16B_TEST_KEY } from './fixtures/sec-16b-test-key'
import { RELAY_CAPABILITY_DISABLED, RELAY_CAPABILITY_ENABLED } from './fixtures/relay-capability-bodies'

const ORIGIN = 'https://relay.test'
const T0 = 5_000_000
const TRUST = { keyId: SEC16B_TEST_KEY.keyId, publicKey: SEC16B_TEST_KEY.publicKey }
const PRIVATE = fromB64url(SEC16B_TEST_KEY.privateKeyPkcs8).slice(-32)

const b64url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

type Sign = { nonce?: string; origin?: string; method?: string; path?: string; status?: number; body?: string; keyId?: string }

/** 假中繼只負責簽章（用跟真中繼同一把測試金鑰）；本文是中繼實際產生的位元組 */
function signed(nonce: string, status: number, text: string, sign: Sign = {}): SignedResponse {
  const signature = b64url(nobleEd25519Sign(responseEnvelope({
    nonce: sign.nonce ?? nonce, origin: sign.origin ?? ORIGIN, method: sign.method ?? 'GET',
    path: sign.path ?? CAPABILITY_PATH, status: sign.status ?? status, body: sign.body ?? text,
  }), PRIVATE))
  return { status, text, headers: { 'x-friends-nonce': nonce, 'x-friends-key-id': sign.keyId ?? TRUST.keyId, 'x-friends-signature': signature } }
}
const nonceOf = (headers: Record<string, string>): string => headers['x-friends-nonce']!
const relayReturning = (body: string, sign: Sign = {}, status = 200): GateFetch => async (_path, headers) => signed(nonceOf(headers), status, body, sign)
/** 0.5.8 以前的中繼：沒有 /capability，簽過章的 404 */
const oldRelay: GateFetch = async (_path, headers) => signed(nonceOf(headers), 404, '{"error":"not found"}')
const never = (): Promise<void> => new Promise<void>(() => {})
const probe = (fetch: GateFetch, now = T0) => probeChatGate({ origin: ORIGIN, trust: TRUST, version: '0.6.0', fetch, now: () => now, sleep: never })

type Body = { v?: unknown; chat?: Record<string, unknown>; ttlSec?: unknown; [key: string]: unknown }
const real = (): Body => JSON.parse(RELAY_CAPABILITY_ENABLED) as Body
const mutated = (change: (body: Body) => void): string => { const body = real(); change(body); return JSON.stringify(body) }
const verdict = async (text: string): Promise<GateResult> => probe(relayReturning(text))

test('夾具就是中繼的本文：欄位、wire、上限、features 與外掛的要求逐項對得上（雙向：中繼多宣告的 feature 外掛要知道）', () => {
  const body = real()
  expect(Object.keys(body)).toEqual(['v', 'chat', 'ttlSec'])
  expect(body.chat!.wire).toEqual([CHAT_REQUIRED.wire])
  expect(body.chat!.maxCiphertextBytes).toBe(CHAT_REQUIRED.minCiphertextBytes)
  expect([...(body.chat!.features as string[])].sort()).toEqual([...CHAT_REQUIRED.features].sort())
  const parsed = parseChatCapability(RELAY_CAPABILITY_ENABLED)
  expect(parsed).not.toBeNull()
  expect(parsed!.enabled).toBe(true)
  expect(parseChatCapability(RELAY_CAPABILITY_DISABLED)!.enabled).toBe(false)
  expect(RELAY_CAPABILITY_DISABLED).toBe(RELAY_CAPABILITY_ENABLED.replace('"enabled":true', '"enabled":false'))
})

test('矩陣 新外掛×新中繼（開）：中繼真正的本文 → 顯示聊天，信 10 分鐘', async () => {
  const r = await verdict(RELAY_CAPABILITY_ENABLED)
  expect(r).toEqual({ show: true, reason: 'ok', ttlMs: 600_000, transient: false, startedAt: T0 })
})

test('矩陣 新外掛×新中繼（旗標關著，部署後第一個狀態）：簽章過、內容完整但 enabled:false → 不顯示，原因 disabled，不算暫時', async () => {
  const r = await verdict(RELAY_CAPABILITY_DISABLED)
  expect(r).toEqual({ show: false, reason: 'disabled', ttlMs: 0, transient: false, startedAt: T0 })
})

test('矩陣 新外掛×舊中繼：簽過章的 404 → 不顯示（relay-old）；而且閘門不開、之後也不會自己打開', async () => {
  const r = await probe(oldRelay)
  expect(r).toMatchObject({ show: false, reason: 'relay-old', transient: false })
  const entry = gateUpdate(undefined, r, ORIGIN, T0)
  expect(gateOpen(entry, ORIGIN, T0)).toBe(false)
  expect(gateOpen(entry, ORIGIN, T0 + 3_600_000)).toBe(false)
})

test('部署後回滾 D→C：開著的閘門遇到簽過章的 404（舊中繼）立刻關，不等 ttl 過期', async () => {
  const open = gateUpdate(undefined, await probe(relayReturning(RELAY_CAPABILITY_ENABLED), T0), ORIGIN, T0)
  expect(gateOpen(open, ORIGIN, T0 + 1_000)).toBe(true)
  const rolledBack = gateUpdate(open, await probe(oldRelay, T0 + 60_000), ORIGIN, T0 + 60_000)
  expect(gateOpen(rolledBack, ORIGIN, T0 + 60_001)).toBe(false)
})

test('緊急關閉 D→關：開著的閘門收到 enabled:false 立刻關；5 分鐘後才再問', async () => {
  const open = gateUpdate(undefined, await probe(relayReturning(RELAY_CAPABILITY_ENABLED), T0), ORIGIN, T0)
  const closed = gateUpdate(open, await probe(relayReturning(RELAY_CAPABILITY_DISABLED), T0 + 1_000), ORIGIN, T0 + 1_000)
  expect(gateOpen(closed, ORIGIN, T0 + 1_001)).toBe(false)
  expect(gateShouldProbe(closed, ORIGIN, T0 + 1_000 + 299_999)).toBe(false)
  expect(gateShouldProbe(closed, ORIGIN, T0 + 1_000 + 300_000)).toBe(true)
})

test('過期：照 ttlSec（600 秒）信到整 10 分鐘，不多一毫秒；ttlSec 過大被夾到 10 分鐘、過小被夾到 30 秒', async () => {
  const entry = gateUpdate(undefined, await verdict(RELAY_CAPABILITY_ENABLED), ORIGIN, T0)
  expect(gateOpen(entry, ORIGIN, T0 + 599_999)).toBe(true)
  expect(gateOpen(entry, ORIGIN, T0 + 600_000)).toBe(false)
  expect((await verdict(mutated(b => { b.ttlSec = 86_400 }))).ttlMs).toBe(GATE_MAX_TTL_MS)
  expect((await verdict(mutated(b => { b.ttlSec = 1 }))).ttlMs).toBe(GATE_MIN_TTL_MS)
})

test('簽章被竄改：nonce、網址、方法、路徑、狀態碼、本文、key id 任一不符 → 不顯示（untrusted），內容再漂亮也一樣', async () => {
  const text = RELAY_CAPABILITY_ENABLED
  const cases: Array<[string, Sign]> = [
    ['nonce', { nonce: 'A'.repeat(22) }], ['origin', { origin: 'https://evil.test' }], ['method', { method: 'POST' }],
    ['path', { path: '/health' }], ['status', { status: 201 }], ['body', { body: RELAY_CAPABILITY_DISABLED }], ['key id', { keyId: 'OTHER-KEY' }],
  ]
  for (const [label, sign] of cases) {
    const r = await probe(relayReturning(text, sign))
    expect({ label, show: r.show, reason: r.reason }).toEqual({ label, show: false, reason: 'untrusted' })
  }
})

test('簽章缺或壞：沒有簽章標頭、簽章被改一個字、簽章是空的 → 不顯示', async () => {
  const good = async (_p: string, headers: Record<string, string>): Promise<SignedResponse> => signed(nonceOf(headers), 200, RELAY_CAPABILITY_ENABLED)
  const strip = (patch: (h: Record<string, unknown>) => Record<string, unknown>): GateFetch => async (p, h) => { const r = await good(p, h); return { ...r, headers: patch({ ...r.headers }) } }
  for (const fetch of [
    strip(h => { delete h['x-friends-signature']; return h }),
    strip(h => ({ ...h, 'x-friends-signature': '' })),
    strip(h => ({ ...h, 'x-friends-signature': `${String(h['x-friends-signature']).slice(0, -2)}AA` })),
    strip(h => { delete h['x-friends-nonce']; return h }),
    strip(h => { delete h['x-friends-key-id']; return h }),
  ]) {
    const r = await probe(fetch)
    expect(r.show).toBe(false)
    expect(r.reason).toBe('untrusted')
  }
})

test('缺欄位：中繼本文少任何一個欄位（v、chat、enabled、wire、maxCiphertextBytes、features、ttlSec）→ 不顯示（bad-body）', async () => {
  const removals: Array<[string, (b: Body) => void]> = [
    ['v', b => { delete b.v }], ['chat', b => { delete b.chat }], ['enabled', b => { delete b.chat!.enabled }], ['wire', b => { delete b.chat!.wire }],
    ['maxCiphertextBytes', b => { delete b.chat!.maxCiphertextBytes }], ['features', b => { delete b.chat!.features }], ['ttlSec', b => { delete b.ttlSec }],
  ]
  for (const [label, remove] of removals) {
    const r = await verdict(mutated(remove))
    expect({ label, show: r.show, reason: r.reason }).toEqual({ label, show: false, reason: 'bad-body' })
  }
})

test('欄位型別不對一律不收：enabled 是字串、v 是 2、wire 不是陣列、features 裡有數字、ttlSec 是 0', async () => {
  const wrong: Array<(b: Body) => void> = [
    b => { b.chat!.enabled = 'true' }, b => { b.chat!.enabled = 1 }, b => { b.v = 2 }, b => { b.v = '1' }, b => { b.chat!.wire = '2' }, b => { b.chat!.features = [1, 2] },
    b => { b.chat!.maxCiphertextBytes = '2048' }, b => { b.ttlSec = 0 }, b => { b.ttlSec = '600' },
  ]
  for (const change of wrong) expect(await verdict(mutated(change))).toMatchObject({ show: false, reason: 'bad-body' })
  expect(await verdict('not json')).toMatchObject({ show: false, reason: 'bad-body' })
  expect(await verdict('[]')).toMatchObject({ show: false, reason: 'bad-body' })
})

test('內容不相容：wire 不含 2、密文上限 2047、少任何一項必要能力 → 各自的原因，不顯示', async () => {
  expect(await verdict(mutated(b => { b.chat!.wire = [1] }))).toMatchObject({ show: false, reason: 'wire' })
  expect(await verdict(mutated(b => { b.chat!.wire = [] }))).toMatchObject({ show: false, reason: 'wire' })
  expect(await verdict(mutated(b => { b.chat!.maxCiphertextBytes = 2_047 }))).toMatchObject({ show: false, reason: 'size' })
  for (const feature of CHAT_REQUIRED.features) {
    const r = await verdict(mutated(b => { b.chat!.features = (b.chat!.features as string[]).filter(f => f !== feature) }))
    expect({ feature, show: r.show, reason: r.reason }).toEqual({ feature, show: false, reason: 'features' })
  }
})

test('將來的中繼可以多宣告：多的 feature、多的 wire、更大的上限、多的欄位都不影響（但已知欄位型別錯就不收）', async () => {
  const text = mutated(b => {
    b.chat!.features = [...(b.chat!.features as string[]), 'future-thing']
    b.chat!.wire = [2, 3]
    b.chat!.maxCiphertextBytes = 4096
    b.chat!.extra = { anything: true }
    b.extra = 'ignored'
    b.relayVersion = '0.7.0'
  })
  expect(await verdict(text)).toMatchObject({ show: true, reason: 'ok' })
})

test('簽章有效但狀態不是 200：中繼 503（缺私鑰時沒簽章）是暫時性、不推翻開著的閘門；簽過章的 500 也是暫時性', async () => {
  const open = gateUpdate(undefined, await verdict(RELAY_CAPABILITY_ENABLED), ORIGIN, T0)
  const unsigned503 = await probe(async () => ({ status: 503, headers: {}, text: '{"error":"x"}' }), T0 + 1_000)
  expect(unsigned503).toMatchObject({ show: false, transient: true })
  const stillOpen = gateUpdate(open, unsigned503, ORIGIN, T0 + 1_000)
  expect(gateOpen(stillOpen, ORIGIN, T0 + 2_000)).toBe(true)
  expect(gateOpen(stillOpen, ORIGIN, T0 + 600_000)).toBe(false) // 不延長
  const signed500 = await probe(relayReturning('{"error":"x"}', {}, 500), T0 + 1_000)
  expect(signed500).toMatchObject({ show: false, reason: 'http-error', transient: true })
})

test('evaluateChatCapability 直接吃中繼的真本文也一樣（不經 probe）', () => {
  const nonce = 'N'.repeat(22)
  const entry = (r: SignedResponse): GateResult => evaluateChatCapability({ nonce, origin: ORIGIN, response: r, trust: TRUST, startedAt: T0 })
  expect(entry(signed(nonce, 200, RELAY_CAPABILITY_ENABLED)).show).toBe(true)
  expect(entry(signed(nonce, 200, RELAY_CAPABILITY_ENABLED, { body: RELAY_CAPABILITY_DISABLED })).reason).toBe('untrusted')
  const gate: GateEntry | undefined = undefined
  expect(gateOpen(gate, ORIGIN, T0)).toBe(false)
})
