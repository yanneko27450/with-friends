import { expect, test } from 'claude-code/testing'

import { nobleEd25519Sign, nobleX25519PublicKey } from '../hooks/noble-crypto.js'
import { CHAT_REPLAY_WINDOW_MS, ChatClient } from '../hooks/chat-client.ts'
import type { ChatTransport } from '../hooks/chat-client.ts'
import { createMemoryChatUniquenessStore } from '../hooks/chat-envelope.ts'
import { SendChains, SeqTracker } from '../hooks/chat-frame.ts'
import { GroupKeyring } from '../hooks/chat-keys.ts'
import { createPersistentReplayStore } from '../hooks/chat-replay.ts'
import { Roster, deviceListBytes } from '../hooks/chat-roster.ts'

// Runs inside the plugin engine itself (`claude plugin test`): the CHAT3-CLIENT flows (device lists, frames and order checks, persistent replay
// store, group epoch keys, per-device DM keys) must behave in the real sandbox the same as in Node. Fixed keys, no network.

const hex = (value: string): Uint8Array => {
  const out = new Uint8Array(value.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return out
}
const b64 = (value: Uint8Array): string => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const T0 = 1_800_000_000_000
const GROUP = 'group-one'

// seeds and public keys derived outside (SHA-256 of a label, Ed25519 via Node crypto)
const keys = {
  aliceIdentity: { seed: hex('eb1be37e716a03011b3c0905d2f5c9158b75b037d5c82de4856090f434122f36'), pub: '0b51092a88cffe42c7e77bab2c4848876497e3240cdac41820533c434d4c7329' },
  aliceLaptop: { seed: hex('07a7d6760b8e956da1e3bddc4166d7d4f1e454ff70c6b72cd9e4869b56e66a9c'), pub: '7eb49bc90e36416db27ce44d273dc985f2cc402b229c483dfbacfcd364cdc6ae' },
  bobIdentity: { seed: hex('2b78fbf20bd0d96def4e2527cf0e711f57d39edc243171ec019d0a31c682a653'), pub: '5d130fa04ca18d7005b75ed5a4c2dcf48ee80e494c25b67108b7fecc500c27b7' },
  bobLaptop: { seed: hex('170927a99ee33a58caed5b97b202a81344367b3c81b04217e4ee6ce09c8ce0a7'), pub: '5a1dd6e9dbf7dd05800240fa18ccf078d235baeab3a8f66dee735af77d83120e' },
}
const aliceEnc = hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4')
const bobEnc = hex('4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d')

const list = (userId: string, deviceId: string, signKey: string, encPrivate: Uint8Array, identitySeed: Uint8Array) => {
  const unsigned = { version: 2 as const, userId, listVersion: 1, issuedAt: T0, devices: [{ deviceId, signKey: b64(hex(signKey)), encKey: b64(nobleX25519PublicKey(encPrivate)) }] }
  return { ...unsigned, signature: b64(nobleEd25519Sign(deviceListBytes(unsigned), identitySeed)) }
}
const aliceList = list('alice', 'alice-laptop', keys.aliceLaptop.pub, aliceEnc, keys.aliceIdentity.seed)
const bobList = list('bob', 'bob-laptop', keys.bobLaptop.pub, bobEnc, keys.bobIdentity.seed)

type Relay = { group: { sequence: number; envelope: unknown }[]; boxes: Map<string, { sequence: number; envelope: unknown }[]> }
const transport = (relay: Relay): ChatTransport => {
  const push = (list: { sequence: number; envelope: unknown }[], envelope: unknown) => { list.push({ sequence: list.length + 1, envelope }) }
  return {
    publish: async envelope => { push(relay.group, envelope); return { ok: true } },
    dmSend: async (code, envelope) => { if (!relay.boxes.has(code)) relay.boxes.set(code, []); push(relay.boxes.get(code)!, envelope); return { ok: true } },
    poll: async after => ({ ok: true, messages: relay.group.filter(m => m.sequence > after) }),
    dmPoll: async boxes => ({ ok: true, boxes: Object.fromEntries(boxes.map(({ code, after }) => [code, { messages: (relay.boxes.get(code) ?? []).filter(m => m.sequence > after) }])) }),
  }
}
const makeClient = (who: 'alice' | 'bob', now: () => number) => {
  const roster = Roster.create({ now })!
  roster.pin('alice', b64(hex(keys.aliceIdentity.pub)))
  roster.pin('bob', b64(hex(keys.bobIdentity.pub)))
  expect(roster.acceptList(aliceList).ok).toBe(true)
  expect(roster.acceptList(bobList).ok).toBe(true)
  const me = who === 'alice'
    ? { userId: 'alice', deviceId: 'alice-laptop', encPrivate: aliceEnc, sign: (m: Uint8Array) => nobleEd25519Sign(m, keys.aliceLaptop.seed) }
    : { userId: 'bob', deviceId: 'bob-laptop', encPrivate: bobEnc, sign: (m: Uint8Array) => nobleEd25519Sign(m, keys.bobLaptop.seed) }
  const keyring = GroupKeyring.create({ groupId: GROUP })!
  const replay = createPersistentReplayStore({ windowMs: CHAT_REPLAY_WINDOW_MS, now, save: () => {} })!
  const client = ChatClient.create({ groupId: GROUP, me, roster, keyring, sendChains: SendChains.create()!, tracker: SeqTracker.create()!, replay, sent: createMemoryChatUniquenessStore(), now, persistPending: () => {} })!
  return { client, keyring }
}

test('group chat in the plugin engine: signed device lists, epoch key, order checks, replay refusal and clean display text', async () => {
  let clock = T0
  const relay: Relay = { group: [], boxes: new Map() }
  const alice = makeClient('alice', () => clock)
  const bob = makeClient('bob', () => clock)
  const first = alice.keyring.rotate()!
  expect(bob.keyring.install(first.epoch, first.key)).toBe('ok')
  const rlo = String.fromCodePoint(0x202e)
  for (const text of ['one', 'two', `three${rlo}`]) { expect((await alice.client.sendGroup(transport(relay), text)).ok).toBe(true); clock += 1000 }
  relay.group.splice(1, 1) // the relay drops "two"
  const summary = await bob.client.pollGroup(transport(relay))
  if (!('delivered' in summary)) throw new Error('poll failed')
  expect(summary.delivered.map(m => m.text).join('|')).toBe('one|three')
  expect(summary.delivered.map(m => m.order.status).join('|')).toBe('ok|gap')
  expect(summary.delivered[1]!.order.missing).toBe(1)
  expect(summary.delivered[1]!.report.text.includes(rlo)).toBe(true)
  // the same envelope again is a replay
  expect(bob.client.openGroup(relay.group[0]!.envelope).ok).toBe(false)
  expect((alice.client.prepare('token: abcd1234efgh5678') as { ok: boolean; reason?: string }).reason).toBe('secret-hint')
})

test('direct messages in the plugin engine: per-device keys, only the addressed device reads, other mailboxes and group keys do not open it', async () => {
  const clock = T0
  const relay: Relay = { group: [], boxes: new Map() }
  const alice = makeClient('alice', () => clock)
  const bob = makeClient('bob', () => clock)
  const sent = await alice.client.sendDm(transport(relay), { code: 'box-ab', peerUserId: 'bob', text: 'hello bob' })
  expect('results' in sent && sent.ok).toBe(true)
  const got = await bob.client.pollDm(transport(relay), [{ code: 'box-ab', peerUserId: 'alice' }])
  if ('ok' in got) throw new Error('poll failed')
  const box = got['box-ab']!
  expect(box.delivered.map(m => `${m.kind}:${m.text}`).join('|')).toBe('dm:hello bob')
  const envelope = relay.boxes.get('box-ab')![0]!.envelope
  const other = makeClient('bob', () => clock)
  expect(other.client.openDm({ code: 'box-other', peerUserId: 'alice', value: envelope }).ok).toBe(false)
  expect(other.client.openGroup(envelope).ok).toBe(false)
})
