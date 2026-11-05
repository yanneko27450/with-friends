// mod/hooks/chat-http-map.ts
// CHAT-4W：中繼對聊天路由的回應 → 聊天用戶端要的結果（TransportResult／SyncResult）。純函式，沒有 $。
// 對照表來自 chat3-client-design §8.3、chat3b-client-design §2；CHAT-5R 多了一條：403 `chat-disabled`（聊天總開關關著）。
// 中繼回的 reason 是對方（中繼）控制的字串：只有在固定清單裡的才往下傳，其餘一律當 'unknown'，原文不會進任何地方。
import type { TransportResult } from './chat-client.ts'
import type { SyncResult } from './chat-sync.ts'

/** 一次 HTTP 的結果；reason 是回應本文裡的 reason 欄位（沒有就是 ''）。status 0＝連不上或逾時。signed 是簽章有沒有驗過 */
export type HttpOutcome = Readonly<{ status: number; reason: string; signed: boolean }>

/** 外掛認得的 reason 代碼（其餘的當 unknown） */
export const KNOWN_REASONS = ['invalid', 'forbidden', 'device-revoked', 'duplicate', 'sender-limit', 'mailbox-full', 'mailbox-unwritable', 'unknown-box', 'stale',
  'unreachable', 'conflict', 'rollback', 'not-owner', 'chat-disabled'] as const
const KNOWN: ReadonlySet<string> = new Set(KNOWN_REASONS)
export const reasonOf = (value: unknown): string => (typeof value === 'string' && KNOWN.has(value) ? value : value === undefined || value === '' ? '' : 'unknown')

export const isChatDisabled = (o: HttpOutcome): boolean => o.signed && o.status === 403 && o.reason === 'chat-disabled'

/**
 * 聊天路由「出怪事」：連不上、5xx、簽章不對、或簽章有效的 404 但沒有 reason（路由不見了）。
 * 這時閘門要盡快重問（gateMarkSuspect）。`/dm/send` 的 404 `unknown-box` 是正常回應，不算。
 */
export function isSuspect(o: HttpOutcome): boolean {
  if (o.status === 0 || !o.signed) return true
  if (o.status >= 500) return true
  return o.status === 404 && o.reason === ''
}

/** `/chat/publish`、`/dm/send` 的結果。resend：先前那次可能已經到了中繼（答案遺失或程序重啟） */
export function toTransportResult(route: 'publish' | 'dmSend', o: HttpOutcome, resend: boolean): TransportResult {
  if (!o.signed) return { ok: false, kind: 'retry', reason: 'untrusted' }
  if (o.status === 200) return { ok: true }
  if (isChatDisabled(o)) return { ok: false, kind: 'retry', reason: 'chat-disabled' } // 不是被拒絕：關著是暫時的，信封留著
  if (o.status === 409 && o.reason === 'duplicate' && (route === 'publish' || resend)) return { ok: false, kind: 'duplicate' }
  if (o.status === 400 || o.status === 403 || o.status === 404 || o.status === 409) return { ok: false, kind: 'rejected', reason: reasonOf(o.reason) }
  return { ok: false, kind: 'retry', reason: reasonOf(o.reason) } // 429、5xx、401、連不上、其他：不確定就重送
}

/** 其他同步／私訊路由：200 → ok；這些 reason → rejected；其餘（5xx、429、連不上、簽章不對、chat-disabled）→ retry */
const REJECTED_REASONS: ReadonlySet<string> = new Set(['rollback', 'conflict', 'device-revoked', 'not-owner', 'invalid', 'forbidden', 'stale', 'unknown-box'])
export function toSyncFailure(o: HttpOutcome): Readonly<{ ok: false; kind: 'retry' | 'rejected'; reason?: string }> {
  if (!o.signed) return { ok: false, kind: 'retry', reason: 'untrusted' }
  if (isChatDisabled(o)) return { ok: false, kind: 'retry', reason: 'chat-disabled' }
  if (o.status >= 400 && o.status < 500 && o.status !== 429 && o.status !== 401 && (REJECTED_REASONS.has(o.reason) || o.status === 400)) return { ok: false, kind: 'rejected', reason: reasonOf(o.reason) }
  return { ok: false, kind: 'retry', reason: reasonOf(o.reason) }
}

export type { SyncResult }
