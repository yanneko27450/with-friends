// mod/hooks/chat-members.ts
// CHAT-6 (docs/drafts/chat6-trust-design.md §3A): where a member's identity key comes from.
// The relay is never a source of trust. The root is the `wf1:` invitation text, which is passed outside the relay and pasted into the pane:
//   - it names the group owner's identity public key, so a joiner knows whose signatures count;
//   - it carries a one-invitation secret s = HKDF(R, n) that the relay never sees, so the joiner can prove "this identity key is mine and I hold
//     this invitation" (join proof, HMAC) and the relay cannot forge a proof for a ghost member or a swapped key.
// The owner signs the WHOLE member list (memberId -> identity key, owner id, version, issue time). Every member pins identity keys only from a list
// that verifies under the owner key it already trusts. The relay's own "isOwner" or member list never decides who is trusted.
// Pure functions and one small class; no $, no storage (chat-iso-static scans this file as 'pure').
import {
  nobleEd25519PublicKey,
  nobleEd25519Sign,
  nobleEd25519Verify,
  nobleHkdfSha256,
  nobleHmacSha256,
  nobleSha256,
  nobleXChaCha20Poly1305Decrypt,
  nobleXChaCha20Poly1305Encrypt,
} from './noble-crypto.js'
import { copyBytes, encoder, equalBytes, fail, fromB64, plain, safeCount, safePositive, toB64, validToken, wipe, type Fail } from './chat-codec.ts'

/** A list not re-signed for this long counts for nothing (same rule as device lists): a relay can hold back a newer list for at most this long. */
export const MEMBER_LIST_MAX_AGE_MS = 14 * 24 * 3_600_000
/** The owner re-signs (listVersion + 1) once the list is this old, so an online owner never lets it expire. */
export const MEMBER_LIST_REISSUE_MS = 7 * 24 * 3_600_000
/** A list claiming to be issued further ahead than this is refused. */
export const MEMBER_LIST_MAX_FUTURE_MS = 3_600_000
/** More than any relay allows per group (relay/core.mjs MAX_MEMBERS is 5); a hard cap keeps parsing bounded. */
export const MEMBER_LIST_MAX_MEMBERS = 16
/** How many used invitation numbers the owner remembers (each one admits one proof only). */
export const MAX_USED_INVITES = 256
const MAX_LIST_VERSION = 2 ** 31

const LIST_DOMAIN = 'with-friends member-list v1'
const JOIN_DOMAIN = 'with-friends join v1'
const SECRET_DOMAIN = 'with-friends invite-secret v1'
const ROOT_DOMAIN = 'with-friends invite-root v1'
const FP_DOMAIN = 'with-friends fp v1'
const json = (value: readonly unknown[]): Uint8Array => encoder.encode(JSON.stringify(value))

export type Random = (length: number) => Uint8Array
const defaultRandom: Random = length => crypto.getRandomValues(new Uint8Array(length))

// ---- keys -------------------------------------------------------------------------------------------------------------------------

/** The public half of an Ed25519 seed (32 bytes, base64url), or '' if the seed is malformed. */
export function publicKeyOf(seed: string): string {
  const bytes = fromB64(seed, 32)
  if (!bytes) return ''
  try { return toB64(nobleEd25519PublicKey(bytes)) } catch { return '' } finally { wipe(bytes) }
}

/** SHA-256("with-friends fp v1" || identity key), first 16 bytes (encryption.md §3.1). */
export function fingerprint(identityKey: string): string {
  const key = fromB64(identityKey, 32)
  if (!key) return ''
  const domain = encoder.encode(FP_DOMAIN)
  const message = new Uint8Array(domain.length + key.length)
  message.set(domain); message.set(key, domain.length)
  return toB64(nobleSha256(message).subarray(0, 16))
}

// ---- invitation secret and join proof -----------------------------------------------------------------------------------------------

/** s = HKDF(R, n): one secret per copied invitation. R is 32 bytes, n is 16 bytes (both base64url). */
export function inviteSecret(root: string, n: string): string {
  const r = fromB64(root, 32)
  const nonce = fromB64(n, 16)
  if (!r || !nonce) return ''
  try { return toB64(nobleHkdfSha256(r, encoder.encode(SECRET_DOMAIN), json([SECRET_DOMAIN, n]), 32)) } catch { return '' } finally { wipe(r) }
}

export type JoinProof = Readonly<{ n: string; identityKey: string; mac: string }>
export type JoinBinding = Readonly<{ groupId: string; ownerKey: string; memberId: string }>

const joinBytes = (binding: JoinBinding, n: string, identityKey: string): Uint8Array =>
  json([JOIN_DOMAIN, binding.groupId, fingerprint(binding.ownerKey), n, binding.memberId, identityKey])

/** The joiner's proof: HMAC(s, domain ‖ group ‖ owner fingerprint ‖ n ‖ my member id ‖ my identity key). Null on bad input. */
export function makeJoinProof(binding: JoinBinding, invite: Readonly<{ n: string; s: string }>, identityKey: string): JoinProof | null {
  const s = fromB64(invite.s, 32)
  if (!s || !fromB64(invite.n, 16) || !fromB64(identityKey, 32) || !validToken(binding.groupId) || !validToken(binding.memberId) || !fingerprint(binding.ownerKey)) { wipe(s); return null }
  try { return Object.freeze({ n: invite.n, identityKey, mac: toB64(nobleHmacSha256(s, joinBytes(binding, invite.n, identityKey))) }) } catch { return null } finally { wipe(s) }
}

/** A proof from the relay, read once into a plain snapshot; null when malformed. */
export function parseJoinProof(value: unknown): JoinProof | null {
  const raw = plain(value, ['identityKey', 'mac', 'n'])
  if (!raw || !fromB64(raw.n, 16) || !fromB64(raw.identityKey, 32) || !fromB64(raw.mac, 32)) return null
  return Object.freeze({ n: raw.n as string, identityKey: raw.identityKey as string, mac: raw.mac as string })
}

/** The owner checks a proof with the secret it derives again from R; constant-time comparison. */
export function verifyJoinProof(binding: JoinBinding, root: string, proof: JoinProof): boolean {
  const s = fromB64(inviteSecret(root, proof.n), 32)
  const mac = fromB64(proof.mac, 32)
  if (!s || !mac) { wipe(s); return false }
  try { return equalBytes(nobleHmacSha256(s, joinBytes(binding, proof.n, proof.identityKey)), mac) } catch { return false } finally { wipe(s) }
}

// ---- invitation root, carried to members inside the signed list ---------------------------------------------------------------------

export type SealedRoot = Readonly<{ epoch: number; nonce: string; box: string }>

const rootKey = (epochKey: Uint8Array, groupId: string, epoch: number): Uint8Array =>
  nobleHkdfSha256(epochKey, encoder.encode(ROOT_DOMAIN), json([ROOT_DOMAIN, groupId, epoch]), 32)

/** R encrypted under a key derived from the current group epoch key: only members who hold that epoch can read it (the relay cannot). */
export function sealInviteRoot(input: Readonly<{ epochKey: Uint8Array; groupId: string; epoch: number; root: string; random?: Random }>): SealedRoot | null {
  const key = copyBytes(input.epochKey, 32)
  const root = fromB64(input.root, 32)
  if (!key || !root || !validToken(input.groupId) || !safeCount(input.epoch)) { wipe(key, root); return null }
  let derived: Uint8Array | null = null
  try {
    const nonce = (input.random ?? defaultRandom)(24)
    if (!(nonce instanceof Uint8Array) || nonce.length !== 24) return null
    derived = rootKey(key, input.groupId, input.epoch)
    const box = nobleXChaCha20Poly1305Encrypt(derived, nonce, root, json([ROOT_DOMAIN, input.groupId, input.epoch]))
    return Object.freeze({ epoch: input.epoch, nonce: toB64(nonce), box: toB64(box) })
  } catch { return null } finally { wipe(key, root, derived) }
}

/** Opens R with the epoch key the member holds; '' when the epoch differs or the box does not open. */
export function openInviteRoot(sealed: SealedRoot, epochKey: Uint8Array, groupId: string, epoch: number): string {
  if (sealed.epoch !== epoch) return ''
  const key = copyBytes(epochKey, 32)
  const nonce = fromB64(sealed.nonce, 24)
  const box = fromB64(sealed.box, 48)
  if (!key || !nonce || !box) { wipe(key); return '' }
  let derived: Uint8Array | null = null
  let opened: Uint8Array | null = null
  try {
    derived = rootKey(key, groupId, epoch)
    opened = nobleXChaCha20Poly1305Decrypt(derived, nonce, box, json([ROOT_DOMAIN, groupId, epoch]))
    return opened.length === 32 ? toB64(opened) : ''
  } catch { return '' } finally { wipe(key, derived, opened) }
}

// ---- the owner-signed member list -------------------------------------------------------------------------------------------------

export type MemberEntry = Readonly<{ memberId: string; identityKey: string }>
export type MemberListV1 = Readonly<{
  version: 1
  groupId: string
  listVersion: number
  issuedAt: number
  ownerId: string
  members: readonly MemberEntry[]
  inviteRoot: SealedRoot | null
  signature: string
}>
export type UnsignedMemberList = Omit<MemberListV1, 'signature' | 'version'>

export const memberListBytes = (list: Omit<MemberListV1, 'signature'>): Uint8Array => json([
  LIST_DOMAIN, list.version, list.groupId, list.listVersion, list.issuedAt, list.ownerId,
  list.members.map(member => [member.memberId, member.identityKey]),
  list.inviteRoot ? [list.inviteRoot.epoch, list.inviteRoot.nonce, list.inviteRoot.box] : null,
])

const rootSnapshot = (value: unknown): SealedRoot | null | undefined => {
  if (value === null) return null
  const raw = plain(value, ['box', 'epoch', 'nonce'])
  if (!raw || !safeCount(raw.epoch) || !fromB64(raw.nonce, 24) || !fromB64(raw.box, 48)) return undefined
  return Object.freeze({ epoch: raw.epoch as number, nonce: raw.nonce as string, box: raw.box as string })
}

/** Reads a list once into a frozen plain snapshot. Members sorted by id (one byte sequence per list), no repeated key, the owner is listed. */
export function parseMemberList(value: unknown): MemberListV1 | null {
  const raw = plain(value, ['groupId', 'inviteRoot', 'issuedAt', 'listVersion', 'members', 'ownerId', 'signature', 'version'])
  if (!raw || raw.version !== 1 || !validToken(raw.groupId) || !validToken(raw.ownerId) || !safePositive(raw.listVersion) || (raw.listVersion as number) > MAX_LIST_VERSION
    || !safePositive(raw.issuedAt) || !fromB64(raw.signature, 64)) return null
  const inviteRoot = rootSnapshot(raw.inviteRoot)
  if (inviteRoot === undefined) return null
  const members = raw.members
  if (!Array.isArray(members) || members.length < 1 || members.length > MEMBER_LIST_MAX_MEMBERS) return null
  const entries: MemberEntry[] = []
  const keys = new Set<string>()
  for (let index = 0; index < members.length; index++) {
    const member = plain(members[index], ['identityKey', 'memberId'])
    if (!member || !validToken(member.memberId) || member.memberId === '__proto__' || !fromB64(member.identityKey, 32)) return null
    const previous = entries[index - 1]
    if (previous && !(previous.memberId < (member.memberId as string))) return null
    if (keys.has(member.identityKey as string)) return null
    keys.add(member.identityKey as string)
    entries.push(Object.freeze({ memberId: member.memberId as string, identityKey: member.identityKey as string }))
  }
  if (!entries.some(entry => entry.memberId === raw.ownerId)) return null
  return Object.freeze({
    version: 1 as const, groupId: raw.groupId as string, listVersion: raw.listVersion as number, issuedAt: raw.issuedAt as number, ownerId: raw.ownerId as string,
    members: Object.freeze(entries), inviteRoot, signature: raw.signature as string,
  })
}

/** The owner signs a list with its identity seed. Members are sorted here; a list that would not parse back gives null. */
export function signMemberList(unsigned: UnsignedMemberList, identitySeed: string): MemberListV1 | null {
  const seed = fromB64(identitySeed, 32)
  if (!seed) return null
  try {
    const members = [...unsigned.members].map(member => Object.freeze({ memberId: member.memberId, identityKey: member.identityKey }))
      .sort((left, right) => (left.memberId < right.memberId ? -1 : left.memberId > right.memberId ? 1 : 0))
    const body = { version: 1 as const, groupId: unsigned.groupId, listVersion: unsigned.listVersion, issuedAt: unsigned.issuedAt, ownerId: unsigned.ownerId, members, inviteRoot: unsigned.inviteRoot }
    const signature = toB64(nobleEd25519Sign(memberListBytes(body), seed))
    return parseMemberList({ groupId: body.groupId, inviteRoot: body.inviteRoot === null ? null : { box: body.inviteRoot.box, epoch: body.inviteRoot.epoch, nonce: body.inviteRoot.nonce },
      issuedAt: body.issuedAt, listVersion: body.listVersion, members: members.map(member => ({ identityKey: member.identityKey, memberId: member.memberId })), ownerId: body.ownerId, signature, version: 1 })
  } catch { return null } finally { wipe(seed) }
}

// ---- MemberBook: what one member believes about the group ------------------------------------------------------------------------

export type BookFailure = 'format' | 'group' | 'signature' | 'adapter' | 'rollback' | 'conflict' | 'expired' | 'time' | 'missing-self'
export type BookAccept = Readonly<{ ok: true; changed: boolean; removed: boolean }> | Fail<BookFailure>
export type BookSnapshot = Readonly<{ version: 1; ownerKey: string; floor: number; list: MemberListV1 | null; signedBy: string }>
type Verifier = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean

/**
 * One member's view: the owner key it trusts (first from the invitation, later from each accepted list's owner entry), the version floor, and the
 * newest accepted list. `self` is this member's own id and identity key: the first list a joiner accepts must contain exactly that pair
 * (a relay cannot hand a newcomer an old list from before the newcomer was added).
 */
export class MemberBook {
  readonly #groupId: string
  readonly #self: MemberEntry
  readonly #now: () => number
  readonly #verify: Verifier
  #ownerKey: string
  #floor: number
  #list: MemberListV1 | null
  #signedBy = ''
  #digest = ''

  private constructor(groupId: string, self: MemberEntry, now: () => number, verify: Verifier, ownerKey: string, floor: number, list: MemberListV1 | null) {
    this.#groupId = groupId; this.#self = self; this.#now = now; this.#verify = verify; this.#ownerKey = ownerKey; this.#floor = floor; this.#list = list
    if (list) this.#digest = toB64(nobleSha256(memberListBytes(list)))
  }

  /**
   * A fresh book (from the invitation: list null, ownerKey from wf1) or one restored from a snapshot; null when anything is malformed.
   * A restored list is verified again against the key that signed it (`signedBy`, kept because after a transfer the signer is the previous owner), and
   * the trusted owner key must be the key the list itself names for its owner. Age is not checked on restore (an expired list just stays expired).
   */
  static create(options: Readonly<{ groupId: string; self: MemberEntry; now: () => number; verify?: Verifier }>, snapshot: BookSnapshot): MemberBook | null {
    if (!options || !validToken(options.groupId) || typeof options.now !== 'function' || !validToken(options.self?.memberId) || !fromB64(options.self?.identityKey, 32)) return null
    const raw = plain(snapshot, ['floor', 'list', 'ownerKey', 'signedBy', 'version'])
    if (!raw || raw.version !== 1 || !fromB64(raw.ownerKey, 32) || !safeCount(raw.floor) || (raw.floor as number) > MAX_LIST_VERSION) return null
    const verify = options.verify ?? nobleEd25519Verify
    const book = new MemberBook(options.groupId, Object.freeze({ memberId: options.self.memberId, identityKey: options.self.identityKey }), options.now, verify, raw.ownerKey as string, raw.floor as number, null)
    if (raw.list === null) return raw.signedBy === '' ? book : null
    const list = parseMemberList(raw.list)
    const owner = list?.members.find(member => member.memberId === list.ownerId)
    if (!list || list.groupId !== options.groupId || !owner || owner.identityKey !== raw.ownerKey || !fromB64(raw.signedBy, 32) || !book.#signed(list, raw.signedBy as string)) return null
    if (list.listVersion > (raw.floor as number)) return null
    book.#list = list
    book.#signedBy = raw.signedBy as string
    book.#digest = toB64(nobleSha256(memberListBytes(list)))
    return book
  }

  #signed(list: MemberListV1, key: string): boolean {
    const signature = fromB64(list.signature, 64)
    const publicKey = fromB64(key, 32)
    if (!signature || !publicKey) return false
    try { return this.#verify(signature, memberListBytes(list), publicKey) === true } catch { return false }
  }

  /** Accepts a list from the relay if the trusted owner key signed it, it is newer (or the same), fresh, and (first time) contains this member. */
  accept(value: unknown): BookAccept {
    const list = parseMemberList(value)
    if (!list) return fail('format')
    if (list.groupId !== this.#groupId) return fail('group')
    const signature = fromB64(list.signature, 64)
    const publicKey = fromB64(this.#ownerKey, 32)
    if (!signature || !publicKey) return fail('adapter')
    let verified: unknown
    try { verified = this.#verify(signature, memberListBytes(list), publicKey) } catch { return fail('adapter') }
    if (verified === false) return fail('signature')
    if (verified !== true) return fail('adapter')
    const now = this.#now()
    if (!safePositive(now)) return fail('adapter')
    if (list.issuedAt > now + MEMBER_LIST_MAX_FUTURE_MS) return fail('time')
    if (now - list.issuedAt > MEMBER_LIST_MAX_AGE_MS) return fail('expired')
    if (list.listVersion < this.#floor) return fail('rollback')
    const digest = toB64(nobleSha256(memberListBytes(list)))
    if (this.#list) {
      if (list.listVersion < this.#list.listVersion) return fail('rollback')
      if (list.listVersion === this.#list.listVersion) return digest === this.#digest ? Object.freeze({ ok: true as const, changed: false, removed: !this.#holdsSelf(list) }) : fail('conflict')
    } else if (!this.#holdsSelf(list)) return fail('missing-self')
    this.#list = list
    this.#signedBy = this.#ownerKey
    this.#digest = digest
    this.#floor = list.listVersion
    // ownership moves only through a list the current owner signed; from then on only the new owner's key counts
    const owner = list.members.find(member => member.memberId === list.ownerId)!
    this.#ownerKey = owner.identityKey
    return Object.freeze({ ok: true as const, changed: true, removed: !this.#holdsSelf(list) })
  }

  #holdsSelf(list: MemberListV1): boolean {
    return list.members.some(member => member.memberId === this.#self.memberId && member.identityKey === this.#self.identityKey)
  }

  /** 'none' before the first list, 'expired' when the newest one is too old, 'removed' when it no longer lists this member, else 'fresh'. */
  status(): 'none' | 'fresh' | 'expired' | 'removed' {
    const list = this.#list
    if (!list) return 'none'
    if (!this.#holdsSelf(list)) return 'removed'
    const now = this.#now()
    return !safePositive(now) || now - list.issuedAt > MEMBER_LIST_MAX_AGE_MS ? 'expired' : 'fresh'
  }

  get list(): MemberListV1 | null { return this.#list }
  get ownerKey(): string { return this.#ownerKey }
  get floor(): number { return this.#floor }
  /** The owner named by the newest accepted list ('' before the first one). Never the relay's word. */
  get ownerId(): string { return this.#list?.ownerId ?? '' }
  get listVersion(): number { return this.#list?.listVersion ?? 0 }
  /** Members of the newest list, only while it is fresh (an expired list vouches for nobody). */
  members(): readonly MemberEntry[] { return this.status() === 'fresh' ? this.#list!.members : [] }

  snapshot(): BookSnapshot { return Object.freeze({ version: 1 as const, ownerKey: this.#ownerKey, floor: this.#floor, list: this.#list, signedBy: this.#signedBy }) }
}

// ---- wf1: invitation text ----------------------------------------------------------------------------------------------------------

export type Wf1Invite = Readonly<{ relay: string; invite: string; ownerKey: string; n: string; s: string; floor: number }>

const WF1_RE = /^wf1:([\w.-]{4,200}):([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{43}):(\d{1,10}):(https?:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?)$/

/** wf1:<invite code>:<owner identity key>:<n>:<s>:<list version floor>:<relay origin>. Only the invite code is ever sent to the relay. */
export function formatWf1(invite: Wf1Invite): string {
  return `wf1:${invite.invite}:${invite.ownerKey}:${invite.n}:${invite.s}:${invite.floor}:${invite.relay}`
}

/** Strict parse; null for anything else (a pasted sentence, a URL, a truncated line). */
export function parseWf1(raw: unknown): Wf1Invite | null {
  if (typeof raw !== 'string') return null
  const m = WF1_RE.exec(raw.trim())
  if (!m) return null
  const floor = Number(m[5])
  if (!fromB64(m[2], 32) || !fromB64(m[3], 16) || !fromB64(m[4], 32) || !safeCount(floor) || floor > MAX_LIST_VERSION) return null
  return Object.freeze({ invite: m[1]!, ownerKey: m[2]!, n: m[3]!, s: m[4]!, floor, relay: m[6]! })
}

/** A fresh (n, s) for one copied invitation, from R. */
export function mintInvite(root: string, random: Random = defaultRandom): Readonly<{ n: string; s: string }> | null {
  const bytes = random(16)
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) return null
  const n = toB64(bytes)
  const s = inviteSecret(root, n)
  return s ? Object.freeze({ n, s }) : null
}
