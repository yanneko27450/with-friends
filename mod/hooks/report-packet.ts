import { nobleEd25519Verify, nobleSha512 } from './noble-crypto.js'
import { fromB64url } from './response-signing.ts'

const encoder = new TextEncoder()
const token = /^[A-Za-z0-9_-]{1,100}$/
const publicKey = /^[A-Za-z0-9_-]{43}$/
const signature = /^[A-Za-z0-9_-]{86}$/
const reportId = /^[A-Za-z0-9_-]{22}$/

export type ReportMessageV1 = Readonly<{
  messageId: string
  sentAt: number
  senderId: string
  deviceId: string
  aad: string
  plaintext: string
}>

export type DeviceAuthorizationV1 = Readonly<{
  issuedAt: number
  expiresAt: number
  authEpoch: number
  signature: string
}>

export type ReportReporterV1 = Readonly<{
  reporterId: string
  deviceId: string
  devicePublicKey: string
}>

export type ReportPacketV1 = Readonly<{
  version: 1
  kind: 'friends-report'
  groupId: string
  reportId: string
  selectedAt: number
  identityPublicKey: string
  devicePublicKey: string
  deviceAuthorization: DeviceAuthorizationV1
  messageSignature: string
  message: ReportMessageV1
  reporter: ReportReporterV1
  reportSignature: string
}>

export type StoredReportMessageV1 = Readonly<Pick<ReportPacketV1,
  'identityPublicKey' | 'devicePublicKey' | 'deviceAuthorization' | 'messageSignature' | 'message'>>

export type ReportVerifier = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean
export type ReportReplayStore = Readonly<{
  /** Atomically claims an ID. After persisting a successful claim, implementations must not throw. */
  claim(reportId: string): boolean
}>

export class MemoryReportReplayStore implements ReportReplayStore {
  readonly #seen = new Set<string>()
  claim(id: string): boolean {
    if (this.#seen.has(id)) return false
    this.#seen.add(id)
    return true
  }
}

export type ReportTrustV1 = Readonly<{
  expectedGroupId: string
  expectedSenderId: string
  expectedSenderDeviceId: string
  trustedIdentityPublicKey: string
  trustedSenderDevicePublicKey: string
  currentAuthEpoch: number
  expectedReporterId: string
  expectedReporterDeviceId: string
  trustedReporterDevicePublicKey: string
  now: number
  maxMessageAgeMs: number
  maxSelectionAgeMs: number
  maxFutureSkewMs: number
  replayStore: ReportReplayStore
}>

export type ReportSelectionSourceV1 = Readonly<{
  groupId: string
  selectedMessageIds: readonly string[]
  loadMessage(messageId: string): StoredReportMessageV1 | undefined
  selectedAt: number
  reporter: ReportReporterV1
  signEnvelope(message: Uint8Array): Uint8Array
}>

const toB64url = (value: Uint8Array): string => {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const decode = (value: string, length: number): Uint8Array | null => {
  if ((length === 32 ? !publicKey.test(value) : !signature.test(value))) return null
  try {
    const out = fromB64url(value)
    return out.length === length ? out : null
  } catch { return null }
}
const dataSnapshot = (value: unknown, expected: readonly string[]): Readonly<Record<string, unknown>> | null => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== expected.length || ownKeys.some(key => typeof key !== 'string')
      || expected.some(key => !ownKeys.includes(key))) return null
    const snapshot: Record<string, unknown> = {}
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) return null
      snapshot[key] = descriptor.value
    }
    return Object.freeze(snapshot)
  } catch { return null }
}
const singleSelectionSnapshot = (value: unknown): readonly [unknown] | null => {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== 2 || !keys.includes('0') || !keys.includes('length')) return null
    const item = Object.getOwnPropertyDescriptor(value, '0')
    const length = Object.getOwnPropertyDescriptor(value, 'length')
    if (!item || item.enumerable !== true || !('value' in item)
      || !length || length.enumerable !== false || !('value' in length) || length.value !== 1) return null
    return Object.freeze([item.value]) as readonly [unknown]
  } catch { return null }
}
const safePositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const safeEpoch = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0)
const validToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100 && token.test(value)
const validUtf8 = (value: unknown, maximum: number, allowEmpty: boolean): value is string => {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximum) return false
  const length = encoder.encode(value).length
  return (allowEmpty || length > 0) && length <= maximum
}
const messageSnapshot = (value: unknown): ReportMessageV1 | null => {
  const raw = dataSnapshot(value, ['aad', 'deviceId', 'messageId', 'plaintext', 'senderId', 'sentAt'])
  if (!raw || !validToken(raw.messageId) || !safePositiveInteger(raw.sentAt)
    || !validToken(raw.senderId) || !validToken(raw.deviceId)
    || !validUtf8(raw.aad, 1_000, false) || !validUtf8(raw.plaintext, 4_000, true)) return null
  return Object.freeze({ messageId: raw.messageId, sentAt: raw.sentAt, senderId: raw.senderId,
    deviceId: raw.deviceId, aad: raw.aad, plaintext: raw.plaintext })
}
const authorizationSnapshot = (value: unknown): DeviceAuthorizationV1 | null => {
  const raw = dataSnapshot(value, ['authEpoch', 'expiresAt', 'issuedAt', 'signature'])
  if (!raw || !safePositiveInteger(raw.issuedAt) || !safePositiveInteger(raw.expiresAt)
    || !safeEpoch(raw.authEpoch) || typeof raw.signature !== 'string' || decode(raw.signature, 64) === null) return null
  return Object.freeze({ issuedAt: raw.issuedAt, expiresAt: raw.expiresAt,
    authEpoch: raw.authEpoch, signature: raw.signature })
}
const reporterSnapshot = (value: unknown): ReportReporterV1 | null => {
  const raw = dataSnapshot(value, ['deviceId', 'devicePublicKey', 'reporterId'])
  if (!raw || !validToken(raw.reporterId) || !validToken(raw.deviceId)
    || typeof raw.devicePublicKey !== 'string' || decode(raw.devicePublicKey, 32) === null) return null
  return Object.freeze({ reporterId: raw.reporterId, deviceId: raw.deviceId, devicePublicKey: raw.devicePublicKey })
}
const storedMessageSnapshot = (value: unknown): StoredReportMessageV1 | null => {
  const raw = dataSnapshot(value, ['deviceAuthorization', 'devicePublicKey', 'identityPublicKey', 'message', 'messageSignature'])
  if (!raw || typeof raw.identityPublicKey !== 'string' || decode(raw.identityPublicKey, 32) === null
    || typeof raw.devicePublicKey !== 'string' || decode(raw.devicePublicKey, 32) === null
    || typeof raw.messageSignature !== 'string' || decode(raw.messageSignature, 64) === null) return null
  const deviceAuthorization = authorizationSnapshot(raw.deviceAuthorization)
  const message = messageSnapshot(raw.message)
  if (!deviceAuthorization || !message) return null
  return Object.freeze({ identityPublicKey: raw.identityPublicKey, devicePublicKey: raw.devicePublicKey,
    deviceAuthorization, messageSignature: raw.messageSignature, message })
}
const packetSnapshot = (value: unknown): ReportPacketV1 | null => {
  const raw = dataSnapshot(value, ['deviceAuthorization', 'devicePublicKey', 'groupId', 'identityPublicKey', 'kind', 'message', 'messageSignature', 'reporter', 'reportId', 'reportSignature', 'selectedAt', 'version'])
  if (!raw || raw.version !== 1 || raw.kind !== 'friends-report' || !validToken(raw.groupId)
    || typeof raw.reportId !== 'string' || !reportId.test(raw.reportId) || fromB64url(raw.reportId).length !== 16
    || !safePositiveInteger(raw.selectedAt)
    || typeof raw.identityPublicKey !== 'string' || decode(raw.identityPublicKey, 32) === null
    || typeof raw.devicePublicKey !== 'string' || decode(raw.devicePublicKey, 32) === null
    || typeof raw.messageSignature !== 'string' || decode(raw.messageSignature, 64) === null
    || typeof raw.reportSignature !== 'string' || decode(raw.reportSignature, 64) === null) return null
  const deviceAuthorization = authorizationSnapshot(raw.deviceAuthorization)
  const message = messageSnapshot(raw.message)
  const reporter = reporterSnapshot(raw.reporter)
  if (!deviceAuthorization || !message || !reporter) return null
  return Object.freeze({ version: 1, kind: 'friends-report', groupId: raw.groupId, reportId: raw.reportId,
    selectedAt: raw.selectedAt, identityPublicKey: raw.identityPublicKey, devicePublicKey: raw.devicePublicKey,
    deviceAuthorization, messageSignature: raw.messageSignature, message, reporter, reportSignature: raw.reportSignature })
}

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let different = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) different |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return different === 0
}

export const deviceAuthorizationBytes = (packet: Pick<ReportPacketV1, 'version' | 'groupId' | 'identityPublicKey' | 'devicePublicKey' | 'deviceAuthorization' | 'message'>): Uint8Array => encoder.encode(JSON.stringify([
  'friends-report/device-authorization/v1', packet.version, packet.groupId, packet.identityPublicKey,
  packet.message.senderId, packet.message.deviceId, packet.devicePublicKey,
  packet.deviceAuthorization.issuedAt, packet.deviceAuthorization.expiresAt, packet.deviceAuthorization.authEpoch,
]))

export const reportMessageBytes = (packet: Pick<ReportPacketV1, 'version' | 'groupId' | 'deviceAuthorization' | 'message'>): Uint8Array => encoder.encode(JSON.stringify([
  'friends-report/message/v1', packet.version, packet.groupId, packet.deviceAuthorization.authEpoch,
  packet.message.messageId, packet.message.sentAt, packet.message.senderId, packet.message.deviceId,
  packet.message.aad, packet.message.plaintext,
]))

export const reportEvidenceHash = (packet: Pick<ReportPacketV1, 'version' | 'groupId' | 'deviceAuthorization' | 'message'>): string => toB64url(nobleSha512(reportMessageBytes(packet)))

export const reportEnvelopeBytes = (packet: Pick<ReportPacketV1, 'version' | 'kind' | 'groupId' | 'reportId' | 'selectedAt' | 'reporter' | 'deviceAuthorization' | 'message'>): Uint8Array => encoder.encode(JSON.stringify([
  'friends-report/envelope/v1', packet.version, packet.kind, packet.groupId, packet.reportId, packet.selectedAt,
  packet.reporter.reporterId, packet.reporter.deviceId, packet.reporter.devicePublicKey, reportEvidenceHash(packet),
]))

const freshReportId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) throw new Error('Report ID randomness must return 16 bytes')
  return toB64url(bytes)
}

type SelectionSourceSnapshot = Readonly<{
  groupId: string
  selectedMessageIds: readonly [string]
  loadMessage: ReportSelectionSourceV1['loadMessage']
  selectedAt: number
  reporter: ReportReporterV1
  signEnvelope: ReportSelectionSourceV1['signEnvelope']
}>
const selectionSourceSnapshot = (value: unknown): SelectionSourceSnapshot | null => {
  const raw = dataSnapshot(value, ['groupId', 'loadMessage', 'reporter', 'selectedAt', 'selectedMessageIds', 'signEnvelope'])
  if (!raw) return null
  const selectedMessageIds = singleSelectionSnapshot(raw.selectedMessageIds)
  const reporter = reporterSnapshot(raw.reporter)
  if (!selectedMessageIds || !validToken(selectedMessageIds[0]) || !validToken(raw.groupId)
    || !safePositiveInteger(raw.selectedAt) || !reporter
    || typeof raw.loadMessage !== 'function' || typeof raw.signEnvelope !== 'function') return null
  return Object.freeze({ groupId: raw.groupId, selectedMessageIds: Object.freeze([selectedMessageIds[0]]) as readonly [string],
    loadMessage: raw.loadMessage as ReportSelectionSourceV1['loadMessage'], selectedAt: raw.selectedAt,
    reporter, signEnvelope: raw.signEnvelope as ReportSelectionSourceV1['signEnvelope'] })
}

type TrustSnapshot = Readonly<{
  expectedGroupId: unknown
  expectedSenderId: unknown
  expectedSenderDeviceId: unknown
  trustedIdentityPublicKey: unknown
  trustedSenderDevicePublicKey: unknown
  currentAuthEpoch: unknown
  expectedReporterId: unknown
  expectedReporterDeviceId: unknown
  trustedReporterDevicePublicKey: unknown
  now: unknown
  maxMessageAgeMs: unknown
  maxSelectionAgeMs: unknown
  maxFutureSkewMs: unknown
  claimReportId(reportId: string): unknown
}>
const trustSnapshot = (value: unknown): TrustSnapshot | null => {
  const raw = dataSnapshot(value, ['currentAuthEpoch', 'expectedGroupId', 'expectedReporterDeviceId', 'expectedReporterId',
    'expectedSenderDeviceId', 'expectedSenderId', 'maxFutureSkewMs', 'maxMessageAgeMs', 'maxSelectionAgeMs', 'now',
    'replayStore', 'trustedIdentityPublicKey', 'trustedReporterDevicePublicKey', 'trustedSenderDevicePublicKey'])
  if (!raw || (!raw.replayStore || (typeof raw.replayStore !== 'object' && typeof raw.replayStore !== 'function'))) return null
  let claim: unknown
  try { claim = Reflect.get(raw.replayStore, 'claim') } catch { return null }
  if (typeof claim !== 'function') return null
  const replayStore = raw.replayStore
  return Object.freeze({
    expectedGroupId: raw.expectedGroupId, expectedSenderId: raw.expectedSenderId,
    expectedSenderDeviceId: raw.expectedSenderDeviceId, trustedIdentityPublicKey: raw.trustedIdentityPublicKey,
    trustedSenderDevicePublicKey: raw.trustedSenderDevicePublicKey, currentAuthEpoch: raw.currentAuthEpoch,
    expectedReporterId: raw.expectedReporterId, expectedReporterDeviceId: raw.expectedReporterDeviceId,
    trustedReporterDevicePublicKey: raw.trustedReporterDevicePublicKey, now: raw.now,
    maxMessageAgeMs: raw.maxMessageAgeMs, maxSelectionAgeMs: raw.maxSelectionAgeMs,
    maxFutureSkewMs: raw.maxFutureSkewMs,
    claimReportId: (id: string): unknown => Reflect.apply(claim as (...args: unknown[]) => unknown, replayStore, [id]),
  })
}

const signatureBytesSnapshot = (value: unknown): Uint8Array | null => {
  try {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Uint8Array.prototype) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== 64 || keys.some((key, index) => key !== String(index))) return null
    const copy = new Uint8Array(64)
    for (let index = 0; index < 64; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)
        || !Number.isInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > 255) return null
      copy[index] = descriptor.value
    }
    return copy
  } catch { return null }
}

export type ReportPacketCreationErrorCode = 'source' | 'load-message' | 'message-unavailable' | 'stored-message' | 'report-id' | 'sign-envelope'

export class ReportPacketCreationError extends Error {
  readonly code: ReportPacketCreationErrorCode
  constructor(code: ReportPacketCreationErrorCode) {
    super(`report-packet:${code}`)
    this.name = 'ReportPacketCreationError'
    this.code = code
  }
}

const creationError = (code: ReportPacketCreationErrorCode): never => { throw new ReportPacketCreationError(code) }

export function createReportPacket(source: ReportSelectionSourceV1): ReportPacketV1 {
  const sourceCopy = selectionSourceSnapshot(source)
  if (!sourceCopy) return creationError('source')
  const selectedId = sourceCopy.selectedMessageIds[0]
  let loaded: StoredReportMessageV1 | undefined
  try { loaded = sourceCopy.loadMessage(selectedId) } catch { return creationError('load-message') }
  if (!loaded) return creationError('message-unavailable')
  const stored = storedMessageSnapshot(loaded)
  if (!stored || stored.message.messageId !== selectedId) return creationError('stored-message')
  let generatedReportId: string
  try { generatedReportId = freshReportId() } catch { return creationError('report-id') }
  const unsigned = Object.freeze({
    version: 1 as const,
    kind: 'friends-report' as const,
    groupId: sourceCopy.groupId,
    reportId: generatedReportId,
    selectedAt: sourceCopy.selectedAt,
    identityPublicKey: stored.identityPublicKey,
    devicePublicKey: stored.devicePublicKey,
    deviceAuthorization: stored.deviceAuthorization,
    messageSignature: stored.messageSignature,
    message: stored.message,
    reporter: sourceCopy.reporter,
  })
  let reportSignature: string
  try {
    const returned = sourceCopy.signEnvelope(reportEnvelopeBytes(unsigned))
    const copied = signatureBytesSnapshot(returned)
    if (!copied) throw new Error('invalid signer result')
    reportSignature = toB64url(copied)
  } catch { return creationError('sign-envelope') }
  const packet = packetSnapshot({ ...unsigned, reportSignature })
  if (!packet) return creationError('stored-message')
  return packet
}

export type ReportVerification = Readonly<{ ok: true } | { ok: false; reason: 'format' | 'group' | 'sender' | 'sender-device' | 'identity' | 'reporter' | 'time' | 'auth-epoch' | 'device-authorization' | 'message-signature' | 'report-signature' | 'duplicate' | 'adapter' }>

export function verifyReportPacket(value: unknown, trust: ReportTrustV1, verify: ReportVerifier = nobleEd25519Verify): ReportVerification {
  try {
    const packet = packetSnapshot(value)
    if (!packet) return { ok: false, reason: 'format' }
    const trusted = trustSnapshot(trust)
    if (!trusted) return { ok: false, reason: 'adapter' }
    if (!validToken(trusted.expectedGroupId) || packet.groupId !== trusted.expectedGroupId) return { ok: false, reason: 'group' }
    if (!validToken(trusted.expectedSenderId) || packet.message.senderId !== trusted.expectedSenderId) return { ok: false, reason: 'sender' }
    const trustedIdentity = typeof trusted.trustedIdentityPublicKey === 'string' ? decode(trusted.trustedIdentityPublicKey, 32) : null
    const trustedSenderDevice = typeof trusted.trustedSenderDevicePublicKey === 'string' ? decode(trusted.trustedSenderDevicePublicKey, 32) : null
    const trustedReporter = typeof trusted.trustedReporterDevicePublicKey === 'string' ? decode(trusted.trustedReporterDevicePublicKey, 32) : null
    if (!trustedIdentity || !bytesEqual(decode(packet.identityPublicKey, 32)!, trustedIdentity)) return { ok: false, reason: 'identity' }
    if (!validToken(trusted.expectedSenderDeviceId) || packet.message.deviceId !== trusted.expectedSenderDeviceId
      || !trustedSenderDevice || !bytesEqual(decode(packet.devicePublicKey, 32)!, trustedSenderDevice)) return { ok: false, reason: 'sender-device' }
    if (!validToken(trusted.expectedReporterId) || !validToken(trusted.expectedReporterDeviceId)
      || packet.reporter.reporterId !== trusted.expectedReporterId || packet.reporter.deviceId !== trusted.expectedReporterDeviceId
      || !trustedReporter || !bytesEqual(decode(packet.reporter.devicePublicKey, 32)!, trustedReporter)) return { ok: false, reason: 'reporter' }
    if (!safeEpoch(trusted.currentAuthEpoch) || packet.deviceAuthorization.authEpoch !== trusted.currentAuthEpoch) return { ok: false, reason: 'auth-epoch' }
    if (!safePositiveInteger(trusted.now) || !safePositiveInteger(trusted.maxMessageAgeMs)
      || !safePositiveInteger(trusted.maxSelectionAgeMs) || !safeEpoch(trusted.maxFutureSkewMs)) return { ok: false, reason: 'time' }
    const now = trusted.now
    const earliestMessage = now - trusted.maxMessageAgeMs
    const earliestSelection = now - trusted.maxSelectionAgeMs
    const latest = now + trusted.maxFutureSkewMs
    if (![earliestMessage, earliestSelection, latest].every(Number.isSafeInteger)
      || packet.message.sentAt < earliestMessage || packet.message.sentAt > latest
      || packet.selectedAt < earliestSelection || packet.selectedAt > latest || packet.selectedAt < packet.message.sentAt
      || packet.deviceAuthorization.issuedAt > packet.message.sentAt || packet.deviceAuthorization.expiresAt <= packet.message.sentAt
      || packet.deviceAuthorization.issuedAt > latest || packet.deviceAuthorization.expiresAt <= now
      || packet.deviceAuthorization.expiresAt <= packet.deviceAuthorization.issuedAt) return { ok: false, reason: 'time' }
    let verification: unknown
    try { verification = verify(decode(packet.deviceAuthorization.signature, 64)!, deviceAuthorizationBytes(packet), trustedIdentity) }
    catch { return { ok: false, reason: 'adapter' } }
    if (verification !== true) return { ok: false, reason: verification === false ? 'device-authorization' : 'adapter' }
    try { verification = verify(decode(packet.messageSignature, 64)!, reportMessageBytes(packet), trustedSenderDevice) }
    catch { return { ok: false, reason: 'adapter' } }
    if (verification !== true) return { ok: false, reason: verification === false ? 'message-signature' : 'adapter' }
    try { verification = verify(decode(packet.reportSignature, 64)!, reportEnvelopeBytes(packet), trustedReporter) }
    catch { return { ok: false, reason: 'adapter' } }
    if (verification !== true) return { ok: false, reason: verification === false ? 'report-signature' : 'adapter' }
    let claim: unknown
    try { claim = trusted.claimReportId(packet.reportId) } catch { return { ok: false, reason: 'adapter' } }
    if (claim === false) return { ok: false, reason: 'duplicate' }
    if (claim !== true) return { ok: false, reason: 'adapter' }
    return { ok: true }
  } catch { return { ok: false, reason: 'format' } }
}
