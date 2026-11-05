import {
  nobleEd25519Verify,
  nobleHmacSha256,
  nobleXChaCha20Poly1305Decrypt,
  nobleXChaCha20Poly1305Encrypt,
} from './noble-crypto.js'

const encoder = new TextEncoder()
// The plugin's TextDecoder types take no options, so a leading U+FEFF is preserved by decoding behind a sacrificial BOM (the decoder strips exactly one).
const decoder = new TextDecoder('utf-8')
const decodeKeepingBom = (bytes: Uint8Array): string => {
  const prefixed = new Uint8Array(bytes.length + 3)
  prefixed.set([0xef, 0xbb, 0xbf], 0)
  prefixed.set(bytes, 3)
  return decoder.decode(prefixed)
}
const tokenPattern = /^[A-Za-z0-9_-]{1,100}$/
const messageIdPattern = /^[A-Za-z0-9_-]{22}$/
const noncePattern = /^[A-Za-z0-9_-]{32}$/
const publicKeyPattern = /^[A-Za-z0-9_-]{43}$/
const signaturePattern = /^[A-Za-z0-9_-]{86}$/
const commitPattern = /^[A-Za-z0-9_-]{43}$/
const base64urlPattern = /^[A-Za-z0-9_-]+$/

/** Maximum UTF-8 bytes of the message text itself (what the user typed). */
export const MAX_CHAT_PLAINTEXT_BYTES = 2_000
/** Random per-message key of the commitment (A4). It travels inside the AEAD payload, in front of the text. */
export const CHAT_OPENING_BYTES = 32
/** AEAD payload = opening || UTF-8 text. */
export const MAX_CHAT_PAYLOAD_BYTES = CHAT_OPENING_BYTES + MAX_CHAT_PLAINTEXT_BYTES
export const MAX_CHAT_CIPHERTEXT_BYTES = MAX_CHAT_PAYLOAD_BYTES + 16

export type ChatEnvelopeV2 = Readonly<{
  version: 2
  groupId: string
  senderId: string
  deviceId: string
  messageId: string
  sentAt: number
  epoch: number
  nonce: string
  /** HMAC-SHA256(opening, canonical record), base64url. Covered by AAD and signature, so a report can open it without the epoch key. */
  commit: string
  ciphertext: string
  signature: string
}>

export type ChatUniquenessStore = Readonly<{
  /** Atomically claims both identifiers. After persisting true, implementations must not throw. */
  claim(messageId: string, epoch: number, nonce: string): boolean
}>

export type ChatCreateSourceV2 = Readonly<{
  groupId: string
  senderId: string
  deviceId: string
  messageId: string
  sentAt: number
  epoch: number
  nonce: string
  plaintext: string
  /** 32 fresh CSPRNG bytes per message (see newChatOpening). Never reused, never sent outside the AEAD payload. */
  opening: Uint8Array
  groupKey: Uint8Array
  uniquenessStore: ChatUniquenessStore
  sign(message: Uint8Array): Uint8Array
}>

export type ChatTrustV2 = Readonly<{
  expectedGroupId: string
  expectedSenderId: string
  expectedDeviceId: string
  trustedSenderDevicePublicKey: string
  currentEpoch: number
  groupKey: Uint8Array
  now: number
  maxMessageAgeMs: number
  maxFutureSkewMs: number
  replayStore: ChatUniquenessStore
}>

export type ChatVerifier = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean

export type ChatVerifyResult =
  /** `opening` (base64url): keep it with the envelope and text in pane memory only, with the lifetime of the verified plaintext - never in `$.store` (THREAT_MODEL 2.12, L22 a). It is the only way to report this message after the epoch key has been wiped (B3); after a restart messages received before it can no longer be reported. */
  | Readonly<{ ok: true; plaintext: string; envelope: ChatEnvelopeV2; opening: string }>
  | Readonly<{ ok: false; reason: 'format' | 'trust' | 'epoch' | 'time' | 'signature' | 'ciphertext' | 'commit' | 'replay' | 'adapter' }>

/** What a reporter hands over: the envelope, the plaintext text and the per-message opening. No epoch key. */
export type ChatDisclosure = Readonly<{
  envelope: unknown
  text: string
  opening: string
}>
export type ChatDisclosureTrust = Readonly<{
  expectedGroupId: string
  expectedSenderId: string
  expectedDeviceId: string
  trustedSenderDevicePublicKey: string
}>
export type ChatDisclosureResult =
  | Readonly<{ ok: true; envelope: ChatEnvelopeV2; text: string }>
  | Readonly<{ ok: false; reason: 'format' | 'trust' | 'signature' | 'commit' | 'adapter' }>

export class ChatCreateError extends Error {
  readonly code: 'format' | 'nonce' | 'encrypt' | 'sign' | 'adapter'
  constructor(code: ChatCreateError['code']) {
    super(`chat-create:${code}`)
    this.name = 'ChatCreateError'
    this.code = code
  }
}

export function createMemoryChatUniquenessStore(): ChatUniquenessStore {
  const messageIds = new Set<string>()
  const nonces = new Set<string>()
  return Object.freeze({
    claim(messageId: string, epoch: number, nonce: string): boolean {
      const nonceKey = `${epoch}:${nonce}`
      if (messageIds.has(messageId) || nonces.has(nonceKey)) return false
      messageIds.add(messageId)
      nonces.add(nonceKey)
      return true
    },
  })
}

const toBase64url = (value: Uint8Array): string => {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const decodeBase64url = (value: unknown, minimum: number, maximum = minimum): Uint8Array | null => {
  const maximumCharacters = Math.ceil(maximum * 4 / 3)
  if (typeof value !== 'string' || value.length > maximumCharacters || !base64urlPattern.test(value)) return null
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    if (bytes.length < minimum || bytes.length > maximum || toBase64url(bytes) !== value) return null
    return bytes
  } catch { return null }
}

const dataSnapshot = (value: unknown, expected: readonly string[]): Readonly<Record<string, unknown>> | null => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== expected.length || keys.some(key => typeof key !== 'string')
      || expected.some(key => !keys.includes(key))) return null
    const snapshot: Record<string, unknown> = {}
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) return null
      snapshot[key] = descriptor.value
    }
    return Object.freeze(snapshot)
  } catch { return null }
}

const copyBytes = (value: unknown, length: number): Uint8Array | null => {
  try {
    if (!value || Object.getPrototypeOf(value) !== Uint8Array.prototype) return null
    const copy = new Uint8Array(value as Uint8Array) // not slice(): a species hook could hand back the caller's own object
    return copy.length === length ? copy : null
  } catch { return null }
}
const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let different = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) different |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return different === 0
}

const safePositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const safeEpoch = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0)
const validToken = (value: unknown): value is string => typeof value === 'string' && tokenPattern.test(value)
const hasUnpairedSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) return true
  }
  return false
}
const validText = (value: unknown): value is string => {
  if (typeof value !== 'string' || hasUnpairedSurrogate(value)) return false
  const length = encoder.encode(value).length
  return length > 0 && length <= MAX_CHAT_PLAINTEXT_BYTES
}

const envelopeSnapshot = (value: unknown): ChatEnvelopeV2 | null => {
  const raw = dataSnapshot(value, ['ciphertext', 'commit', 'deviceId', 'epoch', 'groupId', 'messageId', 'nonce', 'senderId', 'sentAt', 'signature', 'version'])
  if (!raw || raw.version !== 2 || !validToken(raw.groupId) || !validToken(raw.senderId) || !validToken(raw.deviceId)
    || typeof raw.messageId !== 'string' || !messageIdPattern.test(raw.messageId)
    || decodeBase64url(raw.messageId, 16) === null || !safePositiveInteger(raw.sentAt) || !safeEpoch(raw.epoch)
    || typeof raw.nonce !== 'string' || !noncePattern.test(raw.nonce) || decodeBase64url(raw.nonce, 24) === null
    || typeof raw.commit !== 'string' || !commitPattern.test(raw.commit) || decodeBase64url(raw.commit, 32) === null
    || typeof raw.ciphertext !== 'string' || decodeBase64url(raw.ciphertext, CHAT_OPENING_BYTES + 1 + 16, MAX_CHAT_CIPHERTEXT_BYTES) === null
    || typeof raw.signature !== 'string' || !signaturePattern.test(raw.signature)
    || decodeBase64url(raw.signature, 64) === null) return null
  return Object.freeze({ version: 2, groupId: raw.groupId, senderId: raw.senderId, deviceId: raw.deviceId,
    messageId: raw.messageId,
    sentAt: raw.sentAt, epoch: raw.epoch, nonce: raw.nonce, commit: raw.commit, ciphertext: raw.ciphertext, signature: raw.signature })
}

type AdapterSnapshot = Readonly<{
  receiver: object
  claim(messageId: string, epoch: number, nonce: string): unknown
}>
const adapterSnapshot = (value: unknown): AdapterSnapshot | null => {
  const raw = dataSnapshot(value, ['claim'])
  if (!raw || typeof raw.claim !== 'function') return null
  return Object.freeze({ receiver: value as object, claim: raw.claim as AdapterSnapshot['claim'] })
}

type CreateSnapshot = Readonly<{
  groupId: string
  senderId: string
  deviceId: string
  messageId: string
  sentAt: number
  epoch: number
  nonce: string
  plaintext: string
  opening: Uint8Array
  groupKey: Uint8Array
  uniquenessStore: AdapterSnapshot
  signReceiver: object
  sign: ChatCreateSourceV2['sign']
}>
const createSnapshot = (value: unknown): CreateSnapshot | null => {
  const raw = dataSnapshot(value, ['deviceId', 'epoch', 'groupId', 'groupKey', 'messageId', 'nonce', 'opening', 'plaintext', 'senderId', 'sentAt', 'sign', 'uniquenessStore'])
  if (!raw || !validToken(raw.groupId) || !validToken(raw.senderId) || !validToken(raw.deviceId)
    || typeof raw.messageId !== 'string' || !messageIdPattern.test(raw.messageId) || decodeBase64url(raw.messageId, 16) === null
    || !safePositiveInteger(raw.sentAt) || !safeEpoch(raw.epoch)
    || typeof raw.nonce !== 'string' || !noncePattern.test(raw.nonce) || decodeBase64url(raw.nonce, 24) === null
    || !validText(raw.plaintext) || typeof raw.sign !== 'function') return null
  const groupKey = copyBytes(raw.groupKey, 32)
  const opening = copyBytes(raw.opening, CHAT_OPENING_BYTES)
  const uniquenessStore = adapterSnapshot(raw.uniquenessStore)
  // An all-zero opening would make the commitment guessable from the envelope header (hiding relies on a fresh CSPRNG opening).
  if (!groupKey || !opening || !uniquenessStore || opening.every(byte => byte === 0)) return null
  return Object.freeze({ groupId: raw.groupId, senderId: raw.senderId, deviceId: raw.deviceId,
    messageId: raw.messageId,
    sentAt: raw.sentAt, epoch: raw.epoch, nonce: raw.nonce, plaintext: raw.plaintext, opening, groupKey,
    uniquenessStore, signReceiver: value as object, sign: raw.sign as ChatCreateSourceV2['sign'] })
}

type TrustSnapshot = Readonly<{
  expectedGroupId: string
  expectedSenderId: string
  expectedDeviceId: string
  trustedSenderDevicePublicKey: Uint8Array
  currentEpoch: number
  groupKey: Uint8Array
  now: number
  maxMessageAgeMs: number
  maxFutureSkewMs: number
  replayStore: AdapterSnapshot
}>
const trustSnapshot = (value: unknown): TrustSnapshot | null => {
  const raw = dataSnapshot(value, ['currentEpoch', 'expectedDeviceId', 'expectedGroupId', 'expectedSenderId', 'groupKey', 'maxFutureSkewMs', 'maxMessageAgeMs', 'now', 'replayStore', 'trustedSenderDevicePublicKey'])
  if (!raw || !validToken(raw.expectedGroupId) || !validToken(raw.expectedSenderId) || !validToken(raw.expectedDeviceId)
    || typeof raw.trustedSenderDevicePublicKey !== 'string' || !publicKeyPattern.test(raw.trustedSenderDevicePublicKey)
    || !safeEpoch(raw.currentEpoch) || !safePositiveInteger(raw.now) || !safePositiveInteger(raw.maxMessageAgeMs)
    || !Number.isSafeInteger(raw.maxFutureSkewMs) || (raw.maxFutureSkewMs as number) < 0 || Object.is(raw.maxFutureSkewMs, -0)
    || (raw.now as number) > Number.MAX_SAFE_INTEGER - (raw.maxFutureSkewMs as number)) return null
  const trustedSenderDevicePublicKey = decodeBase64url(raw.trustedSenderDevicePublicKey, 32)
  const groupKey = copyBytes(raw.groupKey, 32)
  const replayStore = adapterSnapshot(raw.replayStore)
  if (!trustedSenderDevicePublicKey || !groupKey || !replayStore) return null
  return Object.freeze({ expectedGroupId: raw.expectedGroupId, expectedSenderId: raw.expectedSenderId,
    expectedDeviceId: raw.expectedDeviceId, trustedSenderDevicePublicKey, currentEpoch: raw.currentEpoch,
    groupKey, now: raw.now, maxMessageAgeMs: raw.maxMessageAgeMs,
    maxFutureSkewMs: raw.maxFutureSkewMs as number, replayStore })
}

type ChatRecordFields = Pick<ChatEnvelopeV2, 'version' | 'groupId' | 'senderId' | 'deviceId' | 'messageId' | 'sentAt' | 'epoch'>
type ChatAadFields = ChatRecordFields & Pick<ChatEnvelopeV2, 'nonce' | 'commit'>
export const chatAadBytes = (value: ChatAadFields): Uint8Array => encoder.encode(JSON.stringify([
  'friends-chat/aead/v2', value.version, value.groupId, value.senderId, value.deviceId, value.messageId,
  value.sentAt, value.epoch, value.nonce, value.commit,
]))

export const chatSignatureBytes = (value: Omit<ChatEnvelopeV2, 'signature'>): Uint8Array => encoder.encode(JSON.stringify([
  'friends-chat/signature/v2', value.version, value.groupId, value.senderId, value.deviceId, value.messageId,
  value.sentAt, value.epoch, value.nonce, value.commit, value.ciphertext,
]))

/** Canonical record that the commitment binds: every header field a report needs to show, plus the text. */
export const chatRecordBytes = (value: ChatRecordFields, text: string): Uint8Array => encoder.encode(JSON.stringify([
  'friends-chat/record/v2', value.version, value.groupId, value.senderId, value.deviceId, value.messageId,
  value.sentAt, value.epoch, text,
]))

/** Fresh opening for one message. Throws if the platform RNG misbehaves. */
export function newChatOpening(): Uint8Array {
  const bytes = crypto.getRandomValues(new Uint8Array(CHAT_OPENING_BYTES))
  if (!(bytes instanceof Uint8Array) || bytes.length !== CHAT_OPENING_BYTES) throw new Error('chat opening randomness must return 32 bytes')
  return bytes
}

export function createChatEnvelope(value: unknown): ChatEnvelopeV2 {
  const source = createSnapshot(value)
  if (!source) throw new ChatCreateError('format')
  let claimed: unknown
  try {
    claimed = Reflect.apply(source.uniquenessStore.claim, source.uniquenessStore.receiver,
      [source.messageId, source.epoch, source.nonce])
  } catch { throw new ChatCreateError('adapter') }
  if (claimed === false) throw new ChatCreateError('nonce')
  if (claimed !== true) throw new ChatCreateError('adapter')
  const header = Object.freeze({ version: 2 as const, groupId: source.groupId, senderId: source.senderId,
    deviceId: source.deviceId, messageId: source.messageId, sentAt: source.sentAt, epoch: source.epoch })
  let unsigned: Readonly<ChatRecordFields & { nonce: string; commit: string }>
  let ciphertext: string
  try {
    const text = encoder.encode(source.plaintext)
    // commit = HMAC-SHA256(key = opening, message = canonical record); the opening travels only inside the AEAD payload.
    unsigned = Object.freeze({ ...header, nonce: source.nonce,
      commit: toBase64url(nobleHmacSha256(source.opening, chatRecordBytes(header, source.plaintext))) })
    const payload = new Uint8Array(CHAT_OPENING_BYTES + text.length)
    payload.set(source.opening, 0)
    payload.set(text, CHAT_OPENING_BYTES)
    const encrypted = nobleXChaCha20Poly1305Encrypt(source.groupKey, decodeBase64url(source.nonce, 24)!,
      payload, chatAadBytes(unsigned))
    payload.fill(0)
    source.groupKey.fill(0) // our private copies of the key and the opening are not needed any more
    source.opening.fill(0)
    const copied = copyBytes(encrypted, CHAT_OPENING_BYTES + text.length + 16)
    if (!copied) throw new Error('invalid encrypted output')
    ciphertext = toBase64url(copied)
  } catch { throw new ChatCreateError('encrypt') }
  const signable = Object.freeze({ ...unsigned, ciphertext })
  try {
    const signed = Reflect.apply(source.sign, source.signReceiver, [chatSignatureBytes(signable)])
    const copied = copyBytes(signed, 64)
    if (!copied) throw new Error('invalid signature')
    return Object.freeze({ ...signable, signature: toBase64url(copied) })
  } catch { throw new ChatCreateError('sign') }
}

export function verifyAndDecryptChatEnvelope(value: unknown, trusted: unknown, verify: ChatVerifier = nobleEd25519Verify): ChatVerifyResult {
  const envelope = envelopeSnapshot(value)
  const trust = trustSnapshot(trusted)
  if (!envelope || !trust || typeof verify !== 'function') return Object.freeze({ ok: false, reason: 'format' })
  if (envelope.groupId !== trust.expectedGroupId || envelope.senderId !== trust.expectedSenderId
    || envelope.deviceId !== trust.expectedDeviceId) return Object.freeze({ ok: false, reason: 'trust' })
  if (envelope.epoch !== trust.currentEpoch) return Object.freeze({ ok: false, reason: 'epoch' })
  if (envelope.sentAt < trust.now - trust.maxMessageAgeMs || envelope.sentAt > trust.now + trust.maxFutureSkewMs) return Object.freeze({ ok: false, reason: 'time' })
  try {
    const verified = Reflect.apply(verify, undefined, [decodeBase64url(envelope.signature, 64)!,
      chatSignatureBytes(envelope), trust.trustedSenderDevicePublicKey])
    if (verified === false) return Object.freeze({ ok: false, reason: 'signature' })
    if (verified !== true) return Object.freeze({ ok: false, reason: 'adapter' })
  } catch { return Object.freeze({ ok: false, reason: 'adapter' }) }
  let plaintext: string
  let opening: Uint8Array
  try {
    const decrypted = nobleXChaCha20Poly1305Decrypt(trust.groupKey, decodeBase64url(envelope.nonce, 24)!,
      decodeBase64url(envelope.ciphertext, CHAT_OPENING_BYTES + 1 + 16, MAX_CHAT_CIPHERTEXT_BYTES)!, chatAadBytes(envelope))
    const copied = copyBytes(decrypted, decrypted.length)
    if (!copied || copied.length < CHAT_OPENING_BYTES + 1 || copied.length > MAX_CHAT_PAYLOAD_BYTES) throw new Error('invalid plaintext')
    opening = copied.slice(0, CHAT_OPENING_BYTES)
    const textBytes = copied.slice(CHAT_OPENING_BYTES)
    plaintext = decodeKeepingBom(textBytes)
    if (!validText(plaintext) || !bytesEqual(encoder.encode(plaintext), textBytes)) throw new Error('invalid plaintext')
    copied.fill(0)
  } catch { return Object.freeze({ ok: false, reason: 'ciphertext' }) } finally { trust.groupKey.fill(0) }
  // Receiver-side franking check: a sender must not be able to send a message that cannot be reported later.
  try {
    if (!bytesEqual(nobleHmacSha256(opening, chatRecordBytes(envelope, plaintext)), decodeBase64url(envelope.commit, 32)!)) {
      return Object.freeze({ ok: false, reason: 'commit' })
    }
  } catch { return Object.freeze({ ok: false, reason: 'commit' }) }
  let claimed: unknown
  try {
    claimed = Reflect.apply(trust.replayStore.claim, trust.replayStore.receiver,
      [envelope.messageId, envelope.epoch, envelope.nonce])
  } catch { return Object.freeze({ ok: false, reason: 'adapter' }) }
  if (claimed === false) return Object.freeze({ ok: false, reason: 'replay' })
  if (claimed !== true) return Object.freeze({ ok: false, reason: 'adapter' })
  return Object.freeze({ ok: true, plaintext, envelope, opening: toBase64url(opening) })
}

const disclosureSnapshot = (value: unknown): { envelope: ChatEnvelopeV2; text: string; opening: Uint8Array } | null => {
  const raw = dataSnapshot(value, ['envelope', 'opening', 'text'])
  if (!raw || !validText(raw.text)) return null
  const envelope = envelopeSnapshot(raw.envelope)
  const opening = decodeBase64url(raw.opening, CHAT_OPENING_BYTES)
  if (!envelope || !opening) return null
  return { envelope, text: raw.text, opening }
}
const disclosureTrustSnapshot = (value: unknown): { expectedGroupId: string; expectedSenderId: string; expectedDeviceId: string; key: Uint8Array } | null => {
  const raw = dataSnapshot(value, ['expectedDeviceId', 'expectedGroupId', 'expectedSenderId', 'trustedSenderDevicePublicKey'])
  if (!raw || !validToken(raw.expectedGroupId) || !validToken(raw.expectedSenderId) || !validToken(raw.expectedDeviceId)
    || typeof raw.trustedSenderDevicePublicKey !== 'string' || !publicKeyPattern.test(raw.trustedSenderDevicePublicKey)) return null
  const key = decodeBase64url(raw.trustedSenderDevicePublicKey, 32)
  return key ? { expectedGroupId: raw.expectedGroupId, expectedSenderId: raw.expectedSenderId, expectedDeviceId: raw.expectedDeviceId, key } : null
}

/**
 * Report-side check (A4): proves that the trusted sender device signed an envelope whose commitment opens to `text`,
 * using only the envelope, the text and the per-message opening. It needs no epoch key and consumes no replay claim
 * (a report may be examined long after the message left the replay window). It does not decrypt the ciphertext.
 */
export function verifyChatDisclosure(value: unknown, trusted: unknown, verify: ChatVerifier = nobleEd25519Verify): ChatDisclosureResult {
  const disclosure = disclosureSnapshot(value)
  const trust = disclosureTrustSnapshot(trusted)
  if (!disclosure || !trust || typeof verify !== 'function') return Object.freeze({ ok: false, reason: 'format' })
  const { envelope, text, opening } = disclosure
  if (envelope.groupId !== trust.expectedGroupId || envelope.senderId !== trust.expectedSenderId
    || envelope.deviceId !== trust.expectedDeviceId) return Object.freeze({ ok: false, reason: 'trust' })
  try {
    const verified = Reflect.apply(verify, undefined, [decodeBase64url(envelope.signature, 64)!, chatSignatureBytes(envelope), trust.key])
    if (verified === false) return Object.freeze({ ok: false, reason: 'signature' })
    if (verified !== true) return Object.freeze({ ok: false, reason: 'adapter' })
  } catch { return Object.freeze({ ok: false, reason: 'adapter' }) }
  try {
    if (!bytesEqual(nobleHmacSha256(opening, chatRecordBytes(envelope, text)), decodeBase64url(envelope.commit, 32)!)) {
      return Object.freeze({ ok: false, reason: 'commit' })
    }
  } catch { return Object.freeze({ ok: false, reason: 'commit' }) }
  return Object.freeze({ ok: true, envelope, text })
}
