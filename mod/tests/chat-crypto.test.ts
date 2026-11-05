import { expect, test } from 'claude-code/testing'

import {
  nobleEd25519Sign,
  nobleHkdfSha256,
  nobleHmacSha256,
  nobleX25519PublicKey,
  nobleX25519SharedSecret,
} from '../hooks/noble-crypto.js'
import {
  createChatEnvelope,
  createMemoryChatUniquenessStore,
  newChatOpening,
  verifyAndDecryptChatEnvelope,
  verifyChatDisclosure,
} from '../hooks/chat-envelope.ts'
import { RekeySession } from '../hooks/chat-rekey.ts'

// These run inside the plugin engine itself (`claude plugin test`), not Node: they check that the commitment, the rekey
// primitives and the text handling behave the same in the real sandbox (CHAT060-SEC).

const hex = (value: string): Uint8Array => {
  const clean = value.replaceAll(' ', '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}
const toHex = (value: Uint8Array): string => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')
const b64 = (value: Uint8Array): string => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const random = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length))

// RFC 8032 test 1 and 2 key pairs, used as two devices' signing keys
const alice = { seed: hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'), publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a' }
const bob = { seed: hex('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'), publicKey: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c' }

test('HMAC-SHA256, HKDF-SHA256 and X25519 match the standard vectors in the plugin engine', () => {
  expect(toHex(nobleHmacSha256(hex('0b'.repeat(20)), new TextEncoder().encode('Hi There')))).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7')
  expect(toHex(nobleHkdfSha256(hex('0b'.repeat(22)), hex('000102030405060708090a0b0c'), hex('f0f1f2f3f4f5f6f7f8f9'), 42)))
    .toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865')
  const a = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a')
  const b = hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb')
  expect(toHex(nobleX25519PublicKey(a))).toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a')
  expect(toHex(nobleX25519SharedSecret(a, nobleX25519PublicKey(b)))).toBe('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742')
  expect(() => nobleX25519SharedSecret(a, new Uint8Array(32))).toThrow()
})

test('chat envelope with commitment: round trip, leading U+FEFF and U+FFFD kept, disclosure without the key', () => {
  const groupKey = random(32)
  const sentAt = Date.now()
  for (const [index, text] of ['hello', '﻿with a leading BOM', 'a�b', 'emoji \u{1F44B} and 中文'].entries()) {
    const opening = newChatOpening()
    const envelope = createChatEnvelope({
      groupId: 'group-one', senderId: 'alice', deviceId: 'alice-phone', messageId: b64(random(16)), sentAt: sentAt + index, epoch: 1,
      nonce: b64(random(24)), plaintext: text, opening, groupKey: Uint8Array.from(groupKey), uniquenessStore: createMemoryChatUniquenessStore(),
      sign: (message: Uint8Array) => nobleEd25519Sign(message, alice.seed),
    })
    const received = verifyAndDecryptChatEnvelope(envelope, {
      expectedGroupId: 'group-one', expectedSenderId: 'alice', expectedDeviceId: 'alice-phone', trustedSenderDevicePublicKey: b64(hex(alice.publicKey)),
      currentEpoch: 1, groupKey: Uint8Array.from(groupKey), now: sentAt + 10, maxMessageAgeMs: 60_000, maxFutureSkewMs: 1_000,
      replayStore: createMemoryChatUniquenessStore(),
    })
    expect(received.ok).toBe(true)
    if (!received.ok) return
    expect(received.plaintext).toBe(text)
    const report = verifyChatDisclosure({ envelope: received.envelope, text: received.plaintext, opening: received.opening }, {
      expectedGroupId: 'group-one', expectedSenderId: 'alice', expectedDeviceId: 'alice-phone', trustedSenderDevicePublicKey: b64(hex(alice.publicKey)),
    })
    expect(report.ok).toBe(true)
    const forged = verifyChatDisclosure({ envelope: received.envelope, text: `${text}!`, opening: received.opening }, {
      expectedGroupId: 'group-one', expectedSenderId: 'alice', expectedDeviceId: 'alice-phone', trustedSenderDevicePublicKey: b64(hex(alice.publicKey)),
    })
    expect(forged.ok).toBe(false)
  }
})

test('rekey session: signed ephemeral exchange gives both devices the same key in the plugin engine, and the old key is gone', () => {
  const make = (me: typeof alice, meId: string, peer: typeof alice, peerId: string) => RekeySession.create({
    conversationId: 'dm-alice-bob', local: { userId: meId, deviceId: `${meId}-laptop` }, remote: { userId: peerId, deviceId: `${peerId}-laptop` },
    remoteDevicePublicKey: b64(hex(peer.publicKey)), sign: message => nobleEd25519Sign(message, me.seed),
  })
  const a = make(alice, 'alice', bob, 'bob')
  const b = make(bob, 'bob', alice, 'alice')
  expect(a).not.toBe(null)
  expect(b).not.toBe(null)
  if (!a || !b) return
  const t = Date.now()
  const init = a.startRekey(t)
  expect(init.ok).toBe(true)
  if (!init.ok) return
  const response = b.handleInit(init.message, t + 1)
  expect(response.ok).toBe(true)
  if (!response.ok) return
  const confirm = a.handleResponse(response.message, t + 2)
  expect(confirm.ok).toBe(true)
  if (!confirm.ok) return
  expect(b.handleConfirm(confirm.message, t + 3).ok).toBe(true)
  const sendKey = a.nextSendKey(t + 4)
  expect(sendKey.ok).toBe(true)
  if (!sendKey.ok) return
  expect(toHex(b.receiveKey(1, t + 5) ?? new Uint8Array())).toBe(toHex(sendKey.key))
  expect(a.receiveKey(2, t + 5)).toBe(null)
  a.wipe()
  expect(a.snapshot()).toBe(null)
})
