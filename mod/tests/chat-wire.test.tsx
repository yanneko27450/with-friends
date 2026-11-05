// CHAT-4W：聊天分頁接線的行為測試（外掛引擎裡跑，真的 register.tsx／chat-register.tsx／控制器／畫面）。
// 重點：①聊天只在「簽章驗過的 /capability 說相容」時才畫出來，其餘每一種情況都是固定文字、而且完全沒碰 /chat/*、/dm/* 路由
// ②三種介面（桌面、手機、終端機）各有各的畫面 ③聊天總開關中途關掉（403 chat-disabled）：信封留著、閘門關起來、恢復後自己送出，不當成被拒絕
// ④計時器的節拍夠密（舊鑰最多再留 1 小時要靠有人定期呼叫）。
import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { chatStateText } from '../hooks/chat-states'
import { PREVIEW_STRINGS } from '../hooks/chat-preview-strings'
import { CHAT_STRINGS } from '../hooks/chat-strings'
import { CHAT_TICK_MS, CLOSED_EVERY, HTTP_TIMEOUT_MS, LEASE_MS } from '../hooks/chat-register'
import { INITIAL_CHAT_VIEW } from '../hooks/chat-view'
import { WIRE_STRINGS } from '../hooks/chat-wire-strings'
import { isoWorld } from './fixtures/chat-iso/world'
import { aliceSender, bobVault, MEMBERSHIP, newRelayState, ORIGIN, PANE_PROPS, replyOf, TRUST } from './fixtures/chat-wire'
import type { Capability, RelayState } from './fixtures/chat-wire'

const ATOM = { plugin: 'with-friends', key: 'chat' } as const
const SURFACES = ['desktop', 'mobile', 'terminal'] as const
const EN = (key: keyof typeof WIRE_STRINGS.en) => WIRE_STRINGS.en[key]

type Setup = { capability?: Capability; membership?: boolean; vault?: boolean; aliceHasList?: boolean; chatDisabled?: boolean; badChatSignature?: boolean; leaseElsewhere?: boolean }
function setup(on: On, s: Setup = {}) {
  const store: Record<string, unknown> = { relay: ORIGIN, relayTrustV1: TRUST, lang: 'en', onboarded: true }
  if (s.membership !== false) store.membership = MEMBERSHIP
  if (s.leaseElsewhere) store.chatLeaseV1 = { conn: 'another-conversation', until: Date.now() + 3_600_000 }
  if (s.vault !== false) store.chatVaultV1 = bobVault({ aliceList: s.aliceHasList !== false })
  const w = isoWorld(on, { store, atom: ATOM, renderId: 'friends-chat', now: Date.now() })
  const state: RelayState = { ...newRelayState(), capability: s.capability ?? 'ok', aliceHasList: s.aliceHasList ?? true, chatDisabled: s.chatDisabled ?? false, badChatSignature: s.badChatSignature ?? false }
  w.fetch.handler = (url, init) => replyOf(state, url, init)
  return { w, state, alice: aliceSender(state) }
}
const start = ($: any) => $.session.start({ cwd: 'D:/work/site', surface: 'terminal', isInteractive: true })
const mount = async ($: any, w: any, surface: (typeof SURFACES)[number]) => {
  w.panes.add('friends-chat')
  return $.ui.mount({ plugin: 'with-friends', surface, component: 'Pane', requestId: 'friends-chat', props: PANE_PROPS })
}
const textOf = async (ui: any) => JSON.stringify(await ui.drawn())
const chatPaths = (state: RelayState) => state.paths.filter(p => p.startsWith('/chat/') || p.startsWith('/dm/'))

// ---- 不顯示聊天的情況：各自固定文字，而且完全沒碰聊天路由 ----

for (const [name, s, text] of [
  ['沒加入群組', { membership: false }, chatStateText('notInGroup', 'en')],
  ['中繼沒有 /capability（簽章過的 404，舊版中繼）', { capability: 'old' }, chatStateText('unavailable', 'en')],
  ['中繼聊天總開關關著（enabled:false）', { capability: 'disabled' }, chatStateText('unavailable', 'en')],
  ['中繼不收這版的信封（wire 不含 2）', { capability: 'wire' }, chatStateText('unavailable', 'en')],
  ['中繼少了必要能力', { capability: 'no-features' }, chatStateText('unavailable', 'en')],
  ['/capability 簽章不對', { capability: 'bad-signature' }, EN('relayBad')],
  ['/capability 內容不是約定格式（簽章有效）', { capability: 'bad-body' }, EN('relayBad')],
  ['/capability 回 503（簽章有效）', { capability: 'server-error' }, EN('relayBad')],
  ['群組裡其他人都還沒放裝置清單（外掛太舊）', { aliceHasList: false }, EN('peersOld')],
  ['這台電腦沒有準備好的聊天金鑰（保管庫）', { vault: false }, EN('setupNeeded')],
  ['另一個對話正在負責聊天（租約在別人手上）', { leaseElsewhere: true }, EN('otherSession')],
] as const satisfies readonly (readonly [string, Setup, string])[]) {
  test(`不顯示聊天：${name} → 固定文字，沒有訊息，沒碰聊天路由`, async ($, on) => {
    const { w, state } = setup(on, s)
    await start($)
    await w.clock.advance(70_000)
    await w.clock.settle()
    for (const surface of SURFACES) {
      const ui = await mount($, w, surface)
      const shown = await textOf(ui)
      expect(shown, `${surface}`).toContain(text)
      expect(await ui.find({ type: 'Input' }), `${surface} 沒有輸入框`).toBeUndefined()
      expect(shown, `${surface} 沒有預覽標籤（聊天沒開就不說聊天的限制）`).not.toContain(PREVIEW_STRINGS.en.previewBadge)
      await ui.unmount()
    }
    // 聊天路由完全沒碰：只准問 /capability（甚至沒加入群組時連它都不問）。peers-old 與 setup-needed 是中繼相容、本機自己的狀況：
    // setup-needed 不碰聊天路由；peers-old 需要同步名冊（/chat/roster/get）才知道，這兩個不在這條斷言裡
    if (!('aliceHasList' in s) && !('vault' in s) && !('leaseElsewhere' in s)) expect(chatPaths(state), '沒有任何 /chat/*、/dm/* 請求').toEqual([])
    if ('vault' in s || 'leaseElsewhere' in s) expect(chatPaths(state), '沒有保管庫、或別的對話負責＝不碰聊天路由').toEqual([])
    if ('leaseElsewhere' in s) expect(w.records.filter(r => r.op === 'store.set' && (r.input as { key?: string }).key === 'chatVaultV1'), '別的對話負責時，這個對話一個字都不寫保管庫').toEqual([])
    if ('membership' in s) expect(state.paths.includes('/capability'), '沒加入群組連 /capability 都不問').toBe(false)
  })
}

// ---- 顯示聊天：三種介面 ----

test('顯示聊天（中繼相容、金鑰在、對方有清單）：桌面／終端機有輸入框、手機沒有；預覽標籤與「沒有前向保密」那一句三種介面都在；收到的訊息畫得出來', async ($, on) => {
  const { w, alice } = setup(on)
  await start($)
  await w.clock.advance(16_000)
  await w.clock.settle()
  await alice('hi <b>x</b>')
  await w.clock.advance(16_000)
  await w.clock.settle()
  for (const surface of SURFACES) {
    const ui = await mount($, w, surface)
    await ui.redraw()
    const shown = await textOf(ui)
    expect(shown, `${surface} 訊息`).toContain('hi <b>x</b>')
    expect(shown, `${surface} 預覽`).toContain(PREVIEW_STRINGS.en.previewBadge)
    expect(shown, `${surface} 沒有前向保密`).toContain(PREVIEW_STRINGS.en.previewNoFs)
    const input = await ui.find({ type: 'Input' })
    if (surface === 'mobile') {
      expect(input, '手機沒有輸入框').toBeUndefined()
      expect(shown).toContain(EN('mobileInputHint'))
    } else {
      expect(input, `${surface} 有輸入框`).toBeDefined()
      expect(input?.props.label).toBe(CHAT_STRINGS.en.inputName)
    }
    if (surface === 'terminal') {
      expect(shown, '終端機預設只放第一句（沒有前向保密），換鑰的限制按「這是什麼意思」才展開').not.toContain(PREVIEW_STRINGS.en.previewGroupRekey)
      expect(await ui.find({ type: 'Button', key: 'chat-more' })).toBeDefined()
    } else expect(shown, `${surface} 兩句都在`).toContain(PREVIEW_STRINGS.en.previewGroupRekey)
    expect(await ui.findAll({ type: 'Markdown' }), `${surface} 不用 Markdown`).toEqual([])
    expect(await ui.findAll({ type: 'Link' }), `${surface} 不用 Link`).toEqual([])
    await ui.unmount()
  }
})

test('終端機：按「這是什麼意思」展開換鑰的限制；私訊分頁用私訊的那一句', async ($, on) => {
  const { w } = setup(on)
  await start($)
  await w.clock.advance(16_000)
  await w.clock.settle()
  const ui = await mount($, w, 'terminal')
  await ui.press({ key: 'chat-more' })
  await w.clock.settle()
  await ui.redraw()
  expect(await textOf(ui)).toContain(PREVIEW_STRINGS.en.previewGroupRekey)
  await ui.press({ key: 'chat-tab-dm' })
  await w.clock.settle()
  await ui.redraw()
  const shown = await textOf(ui)
  expect(shown).toContain(PREVIEW_STRINGS.en.previewDmRekey)
  expect(shown).not.toContain(PREVIEW_STRINGS.en.previewGroupRekey)
  await ui.unmount()
})

test('輸入框：送出後換一個新的（key 跟著換），太長時顯示超出多少、文字留在框裡（key 不變）', async ($, on) => {
  const { w, state } = setup(on)
  await start($)
  await w.clock.advance(16_000)
  await w.clock.settle()
  const ui = await mount($, w, 'desktop')
  await ui.redraw()
  const first = (await ui.find({ type: 'Input' }))!.props.key as string
  await ui.input({ key: first, text: 'x'.repeat(2000) })
  await w.clock.settle()
  await ui.redraw()
  expect(await textOf(ui)).toContain(chatStateText('tooLong', 'en', 100))
  expect((await ui.find({ type: 'Input' }))!.props.key, '失敗時輸入框不換').toBe(first)
  await ui.input({ key: first, text: 'hello' })
  await w.clock.advance(1_000)
  await w.clock.settle()
  await ui.redraw()
  const second = (await ui.find({ type: 'Input' }))!.props.key as string
  expect(second, '送出成功後換成新的空輸入框').not.toBe(first)
  expect(state.group.length, '真的送到中繼').toBe(1)
  await ui.unmount()
})

// ---- 聊天總開關中途關掉 ----

test('聊天總開關中途關掉（路由回 403 chat-disabled）：信封留著，閘門馬上關，恢復後自己送出，沒有被當成拒絕或裝置撤銷', async ($, on) => {
  const { w, state } = setup(on)
  await start($)
  await w.clock.advance(16_000)
  await w.clock.settle()
  const ui = await mount($, w, 'desktop')
  await ui.redraw()
  state.chatDisabled = true
  state.capability = 'disabled'
  await ui.input({ key: (await ui.find({ type: 'Input' }))!.props.key as string, text: 'sent while the switch is off' })
  await w.clock.advance(20_000)
  await w.clock.settle()
  await ui.redraw()
  const closed = await textOf(ui)
  expect(closed, '閘門關起來，顯示固定的「這個中繼還沒有聊天功能」').toContain(chatStateText('unavailable', 'en'))
  expect(state.group.length, '關著的時候沒有送出任何東西').toBe(0)
  const saved = w.records.filter(r => r.op === 'store.set' && (r.input as { key?: string }).key === 'chatVaultV1').at(-1)
  const vault = (saved!.input as { value: { client: { pending: unknown[] } } }).value
  expect(vault.client.pending.length, '信封存在保管庫等重送（不是被丟掉）').toBe(1)
  state.chatDisabled = false
  state.capability = 'ok'
  await w.clock.advance(6 * 60_000) // 閘門每 5 分鐘重問一次
  await w.clock.settle()
  await ui.redraw()
  expect(await textOf(ui)).not.toContain(chatStateText('unavailable', 'en'))
  expect(state.group.length, '恢復後自己送出了，只送一次').toBe(1)
  await ui.unmount()
})

// ---- 總開關關了、/capability 還說開著 ----

test('路由回 403 chat-disabled 但 /capability 還說開著：閘門先關起來（固定文字），隔 10 秒才重問，恢復後重開，不會每 5 秒閃一次', async ($, on) => {
  const { w, state } = setup(on)
  await start($)
  await w.clock.advance(16_000)
  await w.clock.settle()
  const ui = await mount($, w, 'desktop')
  await ui.redraw()
  const probesBefore = state.paths.filter(p => p === '/capability').length
  state.chatDisabled = true // /capability 仍是 ok
  await ui.input({ key: (await ui.find({ type: 'Input' }))!.props.key as string, text: 'sent while the routes refuse' })
  await w.clock.advance(6_000)
  await w.clock.settle()
  await ui.redraw()
  expect(await textOf(ui), '403 之後閘門馬上關起來，隔一小段時間才重問').toContain(chatStateText('unavailable', 'en'))
  expect(state.paths.filter(p => p === '/capability').length - probesBefore, '關起來的這 6 秒裡沒有每拍都重問').toBeLessThanOrEqual(1)
  state.chatDisabled = false
  await w.clock.advance(12_000)
  await w.clock.settle()
  await ui.redraw()
  expect(await textOf(ui), '重問之後 /capability 說開著，聊天回來').not.toContain(chatStateText('unavailable', 'en'))
  expect(state.group.length, '排隊的那則恢復後送出').toBe(1)
  await ui.unmount()
})

// ---- 節拍 ----

test('計時器的節拍：分頁關著最慢 60 秒一拍（舊鑰最多再留 1 小時要靠定期呼叫），一次請求最多等 10 秒，租約續約比到期快', () => {
  expect(CHAT_TICK_MS * CLOSED_EVERY).toBeLessThanOrEqual(60_000)
  expect(HTTP_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
  expect(LEASE_MS, '租約撐得過分頁關著時的兩拍').toBeGreaterThan(CHAT_TICK_MS * CLOSED_EVERY * 2)
  expect(LEASE_MS / 2, '剩不到一半就續約：分頁關著的一拍（60 秒）之內一定會續').toBeGreaterThan(CHAT_TICK_MS * CLOSED_EVERY)
  expect(INITIAL_CHAT_VIEW.availability).toBe('checking')
})

test('離開群組：聊天分頁馬上變成「先建立或加入群組」，訊息清空、金鑰從記憶體清掉（保管庫的檔案留著給下次）', async ($, on) => {
  const { w, alice } = setup(on)
  await start($)
  await w.clock.advance(16_000)
  await w.clock.settle()
  await alice('secret chatter')
  await w.clock.advance(16_000)
  await w.clock.settle()
  const ui = await mount($, w, 'desktop')
  await ui.redraw()
  expect(await textOf(ui)).toContain('secret chatter')
  const out = await $.command.run({ command: 'friends', args: 'leave --force', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(JSON.stringify(out)).not.toContain('secret chatter')
  await w.clock.advance(16_000)
  await w.clock.settle()
  await ui.redraw()
  const shown = await textOf(ui)
  expect(shown).toContain(chatStateText('notInGroup', 'en'))
  expect(shown).not.toContain('secret chatter')
  await ui.unmount()
})

test('聊天路由的回應簽章不對：不採用（訊息不出現）、畫面只說連不上；中繼回的字一個都不顯示', async ($, on) => {
  const { w, state, alice } = setup(on, { badChatSignature: true })
  await start($)
  await alice('should never appear')
  await w.clock.advance(30_000)
  await w.clock.settle()
  const ui = await mount($, w, 'desktop')
  await ui.redraw()
  const shown = await textOf(ui)
  expect(shown).not.toContain('should never appear')
  expect(shown).toContain(chatStateText('unreachable', 'en'))
  expect(chatPaths(state).length, '有去問，只是不信').toBeGreaterThan(0)
  await ui.unmount()
})
