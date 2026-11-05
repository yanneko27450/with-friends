// CHAT-4W：真的聊天模組（register.tsx 引用的 chat-register.tsx＋控制器＋畫面）的「聊天文字不外洩」隔離測試。
// 設計見 docs/drafts/chat4-iso-design.md §4（I1～I8）；框架見 tests/fixtures/chat-iso/；假中繼與佈建好的保管庫在 fixtures/chat-wire.ts。
// 跟假模組（chat-iso.test.ts）不同的是：這裡走的是真程式，一路都是真的——簽章驗得過的假中繼回應、真的裝置清單、真的 epoch 金鑰、真的加密與解密：
// 「對方」(alice) 用真的 ChatClient 把帶標記的訊息加密後放進假中繼的信箱，被測的這一邊 (bob) 由真模組輪詢、解密、畫出來。
import { expect } from 'claude-code/testing'

import { noticeSentences } from '../hooks/chat-wire-strings'
import { isoTest, networkAllow, READ_ONLY_ACTIONS, CHAT_ACTIONS, runMatrix } from './fixtures/chat-iso/subject'
import type { ChatSubject } from './fixtures/chat-iso/subject'
import type { IsoWorld, Violation } from './fixtures/chat-iso/world'
import { aliceSender, bobVault, MEMBERSHIP, newRelayState, ORIGIN, PANE_PROPS, replyOf, TRUST } from './fixtures/chat-wire'
import type { RelayState } from './fixtures/chat-wire'

const ATOM = { plugin: 'with-friends', key: 'chat' } as const

type Handle = { state: RelayState; send: ReturnType<typeof aliceSender>; w: IsoWorld | undefined }

export function realSubject(): ChatSubject & { handle: Handle } {
  const state = newRelayState()
  const handle: Handle = { state, send: aliceSender(state), w: undefined }
  const inputKey = async (tab: any): Promise<string> => {
    const keys: string[] = []
    const walk = (v: any): void => {
      if (Array.isArray(v)) { v.forEach(walk); return }
      if (!v || typeof v !== 'object') return
      if (v.type === 'Input' && typeof v.props?.key === 'string') keys.push(v.props.key)
      if (Array.isArray(v.children)) v.children.forEach(walk)
    }
    walk(await tab.drawn())
    if (keys.length === 0) throw new Error('聊天分頁畫面裡沒有輸入框')
    return keys[0]!
  }
  // 真外掛的畫面樹 on('*') 看不到，要自己記進世界（observe）才會被掃描、也才找得到正向對照
  const press = async (t: any, key: string) => {
    await t.press({ key })
    await handle.w!.clock.settle()
    await t.redraw()
    handle.w!.observe('ui.render', { requestId: 'friends-chat', surface: 'desktop' }, await t.drawn())
  }
  /** 打開私訊分頁、進 alice 的對話（畫面上才看得到私訊的文字）；用完回到群組 */
  const viewDm = async (t: any, then?: () => Promise<void>) => {
    await press(t, 'chat-tab-dm')
    await press(t, 'chat-dm-open-alice')
    if (then) await then()
    await press(t, 'chat-dm-back')
    await press(t, 'chat-tab-group')
  }
  return {
    handle,
    name: 'chat-4w',
    atom: ATOM,
    renderId: 'friends-chat',
    otherPanes: [{ plugin: 'with-friends', requestId: 'friends' }],
    network: {
      origin: ORIGIN,
      // /dm/send 在這裡是因為私訊的換鑰控制訊息（框 kind r）也走 /dm/send、看了私訊就可能發起；下面另外限制次數與 body 欄位
      readPaths: ['/chat/poll', '/dm/poll', '/dm/list', '/dm/send', '/chat/roster/get', '/chat/roster/put', '/chat/epoch/get', '/chat/members/get', '/chat/join/put', '/chat/device', '/capability', '/status', '/friends'],
      bodyKeys: {
        '/chat/poll': ['after'], '/dm/poll': ['boxes'], '/chat/epoch/get': ['after'], '/chat/roster/put': ['list'], '/chat/join/put': ['proof'], '/chat/members/get': [], '/chat/device': ['deviceId', 'publicKey'], '/dm/send': ['code', 'envelope'],
        '/status': ['state', 'conn', 'action', 'subject', 'paused', 'version', 'avatar', 'pauseSeq'],
      },
    },
    seed: { membership: MEMBERSHIP, relay: ORIGIN, relayTrustV1: TRUST, chatVaultV1: bobVault(), lang: 'en', onboarded: true },
    bind: w => { handle.w = w; w.fetch.handler = (url, init) => replyOf(state, url, init) },
    // 真模組的出口：對方 (alice) 把訊息加密放進假中繼的信箱，等 bob 的計時器輪詢、解密、放進記憶體 atom
    deliver: async (_$, message, { isTabOpen }) => {
      const w = handle.w!
      state.aliceName = message.senderName
      await handle.send.group(message.text)
      await handle.send.dm(message.text)
      await w.clock.advance(isTabOpen ? 31_000 : 61_000)
      await w.clock.settle()
    },
    mount: ($, surface) => $.ui.mount({ plugin: 'with-friends', surface, component: 'Pane', requestId: 'friends-chat', props: PANE_PROPS }),
    actions: {
      openTab: async (_$, c) => { await c.openTab(); c.w.panes.add('friends-chat') },
      closeTab: async (_$, c) => { await c.closeTab(); c.w.panes.delete('friends-chat') },
      scroll: async (_$, c) => { const t = await c.openTab(); c.w.panes.add('friends-chat'); await t.key({ key: 'down' }).catch(() => {}); await t.redraw() },
      // 逐步輸入（kind: 'change'）但不送出：這個畫面沒有 onInput，草稿只活在輸入元件自己裡
      typeDraft: async (_$, c) => {
        const t = await c.openTab()
        c.w.panes.add('friends-chat')
        const key = await inputKey(t)
        const full = c.markers.draft.full
        for (const upto of [Math.ceil(full.length / 3), Math.ceil(full.length * 2 / 3), full.length]) await t.input({ key, text: full.slice(0, upto), kind: 'change' })
      },
      send: async (_$, c) => {
        const t = await c.openTab()
        c.w.panes.add('friends-chat')
        await t.input({ key: await inputKey(t), text: c.markers.draft.full })
        await c.w.clock.settle()
        // 私訊也送一則（同一段帶標記的文字）
        state.dmOn = true
        await c.w.clock.advance(31_000) // 私訊連結清單 30 秒問一次
        await c.w.clock.settle()
        await viewDm(t, async () => { await t.input({ key: await inputKey(t), text: c.markers.draft.full }); await c.w.clock.settle(); await t.redraw() })
      },
      // 中繼回錯誤，錯誤原文是敵意的：畫面只能顯示固定句子
      sendFails: async (_$, c) => {
        const t = await c.openTab()
        c.w.panes.add('friends-chat')
        state.publishStatus = 500
        state.hostileError = c.markers.hostile.full
        await t.input({ key: await inputKey(t), text: c.markers.draft.full })
        await c.w.clock.advance(6_000)
        await c.w.clock.settle()
        state.publishStatus = 200
        // 中繼恢復後，排隊中的那一則會在下一輪輪詢前自己重送：讓它在這個情境裡送完，不要拖到後面「只是看」的情境才發生
        await c.w.clock.advance(6_000)
        await c.w.clock.settle()
      },
      receiveWhileHidden: async (_$, c) => { await c.closeTab(); c.w.panes.delete('friends-chat'); await c.deliver('text', false) },
      receiveWhileOpen: async (_$, c) => { const t = await c.openTab(); c.w.panes.add('friends-chat'); await c.deliver('text', true); await viewDm(t) },
      hostileMessage: async (_$, c) => { const t = await c.openTab(); c.w.panes.add('friends-chat'); await c.deliver('hostile', true); await viewDm(t) },
      urlInText: async (_$, c) => { const t = await c.openTab(); c.w.panes.add('friends-chat'); await c.deliver('url', true); await viewDm(t) },
      command: async ($, c) => { await c.run($, 'friends'); await c.run($, 'friends status') },
      reconnect: async (_$, c) => { await c.openTab(); c.w.panes.add('friends-chat'); await c.w.clock.advance(60_000); await c.w.clock.settle() },
      leaveGroup: async ($, c) => { await c.run($, 'friends leave --force'); await c.w.clock.advance(61_000); await c.w.clock.settle(); await c.closeTab(); c.w.panes.delete('friends-chat') },
      sessionEnd: async ($) => { await $.session.end({ sessionId: 's1' }) },
    },
  }
}

const fmt = (v: readonly Violation[]) => v.map(x => `${x.channel} ${x.op}#${x.n} ${x.where} ${x.path} [${x.marker} ${x.variant}${x.via === 'direct' ? '' : ' via ' + x.via}: ${x.window.slice(0, 24)}]`)
/** 朋友列表本來就會畫成員名單上的名字（對方的暱稱）：那不是聊天內容。其餘出口與其餘標記一律照掃 */
export const notFriendList = (w: IsoWorld) => (v: Violation): boolean => {
  if (v.marker.indexOf('senderName') < 0) return true
  // 朋友列表的畫面與它的 atom（with-friends/friends）：成員名單上的名字本來就在那裡
  if (v.channel === 'extra-atom') return !v.path.startsWith('with-friends/friends')
  if (v.channel !== 'render') return true
  const rec = w.records[v.n - 1]
  return (rec?.input as { requestId?: string } | undefined)?.requestId !== 'friends'
}

/** 聊天以外、外掛原本就會跳的固定句子（這個測試的情境不會觸發，留空；有就列在這裡並說明） */
const NON_CHAT_TOASTS: readonly string[] = []

const real = realSubject()
isoTest('CHAT-4W：真的聊天模組對全部情境（I1～I8），沒有任何出口出現聊天文字', real, async ($, w) => {
  const result = await runMatrix($, w, real)
  const all = Object.values(result.markers)
  // I1：14 個情境全部真的跑了
  for (const name of CHAT_ACTIONS) expect(result.ran[name], `I1 情境 ${name}`).toBe('ran')
  // I2：沒有違規、沒有沒歸類的 op、探測都成功
  expect(fmt(w.violations(all).filter(notFriendList(w)))).toEqual([])
  expect(w.unknownOps(), 'I2 沒有沒歸類的 op').toEqual([])
  for (const op of ['prompt.section', 'attribution.text', 'skill.prompt', 'prompt.context']) expect(result.probes.ok, `探測 ${op}`).toContain(op)
  expect(result.probes.failed, 'I2 探測失敗的事件').toEqual([])
  // I3：正向對照——訊息、寄件人名字、提示注入句、我自己送出的字，都在聊天分頁畫面裡出現過
  const shown = w.rendered(all)
  expect(shown.some(h => h.marker === result.markers.text.label), 'I3 訊息內文').toBe(true)
  expect(shown.some(h => h.marker === result.markers.senderName.label), 'I3 寄件人名字').toBe(true)
  expect(shown.some(h => h.marker === result.markers.hostile.label), 'I3 提示注入句只畫在聊天分頁').toBe(true)
  expect(shown.some(h => h.marker === result.markers.draft.label), 'I3 我自己送出的字').toBe(true)
  // 私訊畫面也真的畫出了對方的字（不只是群組）
  const dmTrees = w.records.filter(r => r.op === 'ui.render' && (r.input as { requestId?: string }).requestId === 'friends-chat' && JSON.stringify(r.result).includes('chat-dm-back'))
  expect(dmTrees.some(r => JSON.stringify(r.result).includes(result.markers.text.cores[0]!.value)), 'I3 私訊對話畫面有對方的字').toBe(true)
  // I4：A6——只是「看」的情境沒有白名單以外的請求；畫面樹只有 Box／Text／Button／Input
  for (const name of READ_ONLY_ACTIONS) {
    const [from, to] = result.slices[name]!
    expect(w.networkEscapes(w.records.slice(from, to), networkAllow(real)), `I4 A6：${name}`).toEqual([])
  }
  expect(w.treeProblems(), 'I4 畫面樹元素白名單').toEqual([])
  // 「只是看」的情境裡的 /dm/send 只可能是私訊的換鑰控制訊息（不是已讀回條）：次數很少、body 只有 code 與 envelope
  const dmSends = READ_ONLY_ACTIONS.flatMap(name => { const [from, to] = result.slices[name]!; return w.records.slice(from, to).filter(r => r.op === 'http.fetch' && String((r.input as { url?: string }).url).endsWith('/dm/send')) })
  expect(dmSends.length, 'I4 看的時候最多發起幾次換鑰').toBeLessThanOrEqual(2)
  const surfaces = new Set(w.records.filter(r => r.op === 'ui.render' && (r.input as { requestId?: string }).requestId === 'friends-chat').map(r => (r.input as { surface?: string }).surface).filter(Boolean))
  expect([...surfaces].sort(), '三種介面都畫過').toEqual(['desktop', 'mobile', 'terminal'])
  // I5：atom 實測——真模組寫的是聊天 atom（state.set，鍵 with-friends/chat），被放行；其他 atom 的 state.set 都不含聊天文字（violations 已掃，這裡確認真的有寫）
  const writes = w.records.filter(r => r.op === 'state.set' && (r.input as { plugin?: string; key?: string }).plugin === 'with-friends' && (r.input as { key?: string }).key === 'chat')
  expect(writes.length, 'I5 有寫聊天 atom').toBeGreaterThan(0)
  expect(JSON.stringify(writes.map(r => (r.input as { value: unknown }).value)).includes(result.markers.text.cores[0]!.value), 'I5 聊天文字確實進了聊天 atom').toBe(true)
  // I8：通知類出口（toast／notify／status／notice）的文字，與固定句子清單逐字比對
  const notices = w.records.filter(r => ['ui.toast', 'ui.notify', 'ui.notice', 'ui.status'].includes(r.op)).map(r => String((r.input as { text?: unknown }).text ?? ''))
  const fixed = new Set<string>([...noticeSentences(), ...NON_CHAT_TOASTS])
  expect(notices.filter(text => !fixed.has(text)), 'I8 通知只准固定句子').toEqual([])
  expect(notices.some(text => noticeSentences().includes(text)), 'I8 沒開分頁時收到訊息，真的跳了那句固定提醒').toBe(true)
  // 朋友列表那一頁讀聊天 atom 的只有未讀數字：有聊天按鈕，violations 已掃過它沒有聊天文字
  const friendsTrees = w.records.filter(r => r.op === 'ui.render' && (r.input as { requestId?: string }).requestId === 'friends').map(r => JSON.stringify(r.result))
  expect(friendsTrees.some(s => /Chat/.test(s)), '朋友列表有聊天按鈕').toBe(true)
  // 朋友列表上寄件人的名字出現的次數有固定的上限（那一格的文字、頭像的 alt、頭像 SVG 的 title 共 3 處）：聊天按鈕不准再多帶名字（新訊息提醒不帶人名）
  const nameCore = result.markers.senderName.cores[0]!.value
  for (const s of friendsTrees) expect(s.split(nameCore).length - 1, '朋友列表那一頁裡寄件人的名字（卡片文字、頭像 alt、頭像 SVG title 最多 3 處）').toBeLessThanOrEqual(3)
  // 聊天按鈕底下的字只有「聊天」加上未讀數字：直接檢查，不靠次數門檻
  const chatButtonTexts: string[] = []
  const walk = (node: any, inButton: boolean): void => {
    if (Array.isArray(node)) { node.forEach(n => walk(n, inButton)); return }
    if (typeof node === 'string') { if (inButton) chatButtonTexts.push(node); return }
    if (!node || typeof node !== 'object') return
    const mine = inButton || (node.type === 'Button' && node.props?.key === 'chat-open')
    if (Array.isArray(node.children)) walk(node.children, mine)
  }
  for (const r of w.records) if (r.op === 'ui.render' && (r.input as { requestId?: string }).requestId === 'friends') walk(r.result, false)
  expect(chatButtonTexts.length, '找得到聊天按鈕的字').toBeGreaterThan(0)
  for (const text of chatButtonTexts) expect(text, '聊天按鈕上只有「聊天／Chat」加未讀數字').toMatch(/^(Chat|聊天)( \d+\+?)?$/)
}, { now: Date.now() })
