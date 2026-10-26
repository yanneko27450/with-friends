import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { nobleEd25519Verify, nobleSha512 } from '../hooks/noble-crypto.js'

const source = await readFile(new URL('./noble.test.ts', import.meta.url), 'utf8')
const vectorSource = source.match(/const rfc8032 = (\[[\s\S]*?\n\]) as const/)?.[1]
if (!vectorSource) throw new Error('Could not read RFC 8032 vectors from noble.test.ts')
// The vectors are static literals in this repository. Reading the same table keeps Node and plugin tests in sync.
const vectors = Function(`"use strict"; return (${vectorSource})`)()

const hex = value => {
  const clean = value.replaceAll(' ', '').replaceAll('\n', '')
  return Uint8Array.from(clean.match(/../g) ?? [], byte => Number.parseInt(byte, 16))
}
const toHex = value => Buffer.from(value).toString('hex')

for (const vector of vectors) {
  test(`Node verifies RFC 8032 section 7.1 ${vector.name}`, () => {
    const signature = hex(vector.signature)
    assert.equal(nobleEd25519Verify(signature, hex(vector.message), hex(vector.publicKey)), true)
    signature[0] ^= 1
    assert.equal(nobleEd25519Verify(signature, hex(vector.message), hex(vector.publicKey)), false)
  })
}

test('Node SHA-512 matches RFC 6234 standard vectors', () => {
  assert.equal(toHex(nobleSha512(new Uint8Array())), 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e')
  assert.equal(toHex(nobleSha512(new TextEncoder().encode('abc'))), 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f')
  assert.equal(toHex(nobleSha512(new TextEncoder().encode('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'))), '8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909')
  assert.equal(toHex(nobleSha512(new Uint8Array(1_000_000).fill(0x61))), 'e718483d0ce769644e2e42c7bc15b4638e1f98b13b2044285632a803afa973ebde0ff244877ea60a4cb0432ce577c31beb009c5c2c49aa2e4eadb217ad8cc09b')
})

test('Node rejects a ZIP-215 small-order public-key forgery', () => {
  const identity = hex(`01${'00'.repeat(31)}`)
  const forged = hex(`01${'00'.repeat(63)}`)
  assert.equal(nobleEd25519Verify(forged, new TextEncoder().encode('arbitrary message'), identity), false)
})

test('Node rejects malformed, altered, and S+L-malleated Ed25519 inputs', () => {
  const vector = vectors[0]
  const signature = hex(vector.signature)
  const publicKey = hex(vector.publicKey)
  assert.equal(nobleEd25519Verify(signature, hex('00'), publicKey), false)
  const wrongKey = publicKey.slice(); wrongKey[0] ^= 1
  assert.equal(nobleEd25519Verify(signature, hex(vector.message), wrongKey), false)
  const badS = signature.slice(); badS[63] ^= 0x80
  assert.equal(nobleEd25519Verify(badS, hex(vector.message), publicKey), false)
  const L = 2n ** 252n + 27742317777372353535851937790883648493n
  let s = 0n
  for (let i = 0; i < 32; i++) s += BigInt(signature[32 + i]) << BigInt(8 * i)
  let malleated = s + L
  const sPlusL = signature.slice()
  for (let i = 0; i < 32; i++) { sPlusL[32 + i] = Number(malleated & 255n); malleated >>= 8n }
  assert.equal(nobleEd25519Verify(sPlusL, hex(vector.message), publicKey), false)
  assert.throws(() => nobleEd25519Verify(signature.slice(0, 63), hex(vector.message), publicKey))
})

test('Node SHA-512 matches node:crypto across padding boundaries and lengths 0..300', () => {
  for (let length = 0; length <= 300; length++) {
    const message = Uint8Array.from({ length }, (_, i) => (i * 131 + length) & 255)
    assert.equal(toHex(nobleSha512(message)), createHash('sha512').update(message).digest('hex'))
  }
  for (const length of [111, 112, 127, 128]) {
    const message = new Uint8Array(length).fill(0xa5)
    assert.equal(toHex(nobleSha512(message)), createHash('sha512').update(message).digest('hex'))
  }
})

test('Node Ed25519 verifies 50 node:crypto signatures and rejects one-bit changes', () => {
  for (let i = 0; i < 50; i++) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const message = Uint8Array.from({ length: i * 7 }, (_, j) => (i + j * 17) & 255)
    const signature = new Uint8Array(sign(null, message, privateKey))
    const rawPublicKey = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32))
    assert.equal(nobleEd25519Verify(signature, message, rawPublicKey), true)
    signature[i % signature.length] ^= 1
    assert.equal(nobleEd25519Verify(signature, message, rawPublicKey), false)
  }
})
