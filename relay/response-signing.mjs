const te = new TextEncoder()

export const RESPONSE_NONCE_RE = /^[A-Za-z0-9_-]{16,100}$/
export const RESPONSE_KEY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

export const b64url = bytes => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const fromB64url = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('bad base64url')
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  if (b64url(bytes) !== value) throw new Error('non-canonical base64url')
  return bytes
}

/** Exact bytes signed by both relay implementations and verified by the plugin. */
export const responseEnvelope = ({ nonce, origin, method, path, status, body }) => te.encode(JSON.stringify([
  'friends-response-v1', nonce, origin, method, path, status, body,
]))

export async function responseSigner(privateKeyB64url, keyId) {
  if (!RESPONSE_KEY_ID_RE.test(keyId ?? '')) throw new Error('RESPONSE_SIGNING_KEY_ID 格式不對')
  let key
  try {
    const privateKey = fromB64url(privateKeyB64url)
    key = await crypto.subtle.importKey('pkcs8', privateKey, { name: 'Ed25519' }, false, ['sign'])
  } catch {
    throw new Error('RESPONSE_SIGNING_PRIVATE_KEY 不是 Ed25519 PKCS#8 base64url')
  }
  return async fields => ({
    keyId,
    signature: b64url(new Uint8Array(await crypto.subtle.sign('Ed25519', key, responseEnvelope(fields)))),
  })
}

export function requestSigningContext(request) {
  const nonce = request.headers.get('x-friends-nonce') ?? ''
  const origin = request.headers.get('x-friends-origin') ?? ''
  return {
    nonce: RESPONSE_NONCE_RE.test(nonce) ? nonce : '',
    origin: /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(origin) ? origin : '',
  }
}
