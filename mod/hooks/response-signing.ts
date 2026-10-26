import { nobleEd25519Verify } from './noble-crypto.js'

const te = new TextEncoder()
const NONCE_RE = /^[A-Za-z0-9_-]{16,100}$/
const KEY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/

export const OFFICIAL_RESPONSE_KEYS: Readonly<Record<string, string>> = {
  'official-2026-10': 'fVZcxT7eQ5kAE6b-EpkvP-aIetKFF8SRxxsUpK13dF8',
}

export function responseEnvelope(fields: { nonce: string; origin: string; method: string; path: string; status: number; body: string }): Uint8Array {
  return te.encode(JSON.stringify(['friends-response-v1', fields.nonce, fields.origin, fields.method, fields.path, fields.status, fields.body]))
}

export function fromB64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('bad base64url')
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  let canonical = ''
  for (const byte of bytes) canonical += String.fromCharCode(byte)
  canonical = btoa(canonical).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  if (canonical !== value) throw new Error('non-canonical base64url')
  return bytes
}

function constantTimeTextEqual(a: unknown, b: string, width: number): boolean {
  if (typeof a !== 'string' || a.length > width || b.length > width) return false
  const aa = te.encode(a)
  const bb = te.encode(b)
  let different = aa.length ^ bb.length
  for (let i = 0; i < width; i++) different |= (aa[i] ?? 0) ^ (bb[i] ?? 0)
  return different === 0
}

export function newResponseNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function isResponsePublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !PUBLIC_KEY_RE.test(value)) return false
  try { return fromB64url(value).length === 32 } catch { return false }
}

export function verifyRelaySignature(fields: {
  nonce: string; origin: string; method: string; path: string; status: number; body: string
  returnedNonce: unknown; keyId: unknown; expectedKeyId: string; signature: unknown; publicKey: string
}): boolean {
  try {
    if (!NONCE_RE.test(fields.nonce) || typeof fields.returnedNonce !== 'string' || fields.returnedNonce.length > 100 || !constantTimeTextEqual(fields.returnedNonce, fields.nonce, 100)) return false
    if (!KEY_ID_RE.test(fields.expectedKeyId) || typeof fields.keyId !== 'string' || fields.keyId.length > 64 || !constantTimeTextEqual(fields.keyId, fields.expectedKeyId, 64)) return false
    if (typeof fields.signature !== 'string' || fields.signature.length !== 86 || fields.publicKey.length !== 43) return false
    const signature = fromB64url(fields.signature)
    const publicKey = fromB64url(fields.publicKey)
    if (signature.length !== 64 || publicKey.length !== 32) return false
    return nobleEd25519Verify(signature, responseEnvelope(fields), publicKey)
  } catch {
    return false
  }
}
