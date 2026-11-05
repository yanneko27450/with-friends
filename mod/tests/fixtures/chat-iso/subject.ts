// mod/tests/fixtures/chat-iso/subject.ts
// CHAT4-ISO：「被測的聊天模組」要提供什麼，以及把它跑過全部情境的 runMatrix。假模組（fake-chat.ts）和之後
// CHAT-4 的真模組都照 ChatSubject 這個形狀接上，同一套情境對它們一視同仁。
//
// 接真模組時（CHAT-4 的工作，寫在 chat-iso-real.test.ts）：只需要寫 realChatSubject()：
//   - deliver：照 CHAT3-CLIENT 的出口，把一則已解密的 ChatViewMessage 放進記憶體 atom（不走 $.store、不走網路）。
//     真模組在外掛的 hooks/ 裡、已經被引擎載入，不需要 plugin 欄位。
//   - mount：開出聊天分頁並回傳 $.ui.mount 的結果
//   - actions：每個情境怎麼觸發（按鈕、指令、讓假中繼回應）
//   - otherPanes：聊天分頁以外、同一個外掛會畫的其他面板（朋友列表等），框架會一併檢查它們不含聊天文字
// 沒辦法做的情境要明寫 skip 理由，框架把它回報出來，不能默默略過。

import { test } from 'claude-code/testing'

import type { ChatViewMessage } from '../../../hooks/chat-types'
import { makeMarker } from './markers'
import type { Marker } from './markers'
import { isoWorld } from './world'
import type { IsoOptions, IsoWorld, NetworkAllow } from './world'

export type MarkerSet = Readonly<Record<'text' | 'senderName' | 'draft' | 'hostile', Marker>>
export type MessageKind = 'text' | 'hostile' | 'url'

/** 一個情境動作；$ 是測試引擎的 $，c 給它目前的分頁、世界、標記 */
export type ChatActionFn = ($: any, c: ChatActionCtx) => Promise<void>
export type ChatActionCtx = Readonly<{
  w: IsoWorld
  /** 目前開著的聊天分頁（沒開＝undefined） */
  tab: any | undefined
  /** 這一輪準備好的標記：text／senderName／draft／hostile */
  markers: MarkerSet
  /** 開聊天分頁（動作之間共用同一個） */
  openTab: () => Promise<any>
  /** 關掉目前的聊天分頁 */
  closeTab: () => Promise<void>
  /** 把一則帶標記的訊息送進模組（經 subject.deliver），之後補一次畫面快照 */
  deliver: (kind: MessageKind, isTabOpen: boolean) => Promise<void>
  /** 跑一個斜線指令（例如 'friends status'），把回傳文字記進世界（指令回傳會進對話，必須掃） */
  run: ($: any, line: string) => Promise<unknown>
}>

/**
 * 情境清單。每個都對應一種「聊天文字可能跑出去」的真實路徑：
 *   openTab / closeTab / scroll：只是看，不該有任何出口
 *   typeDraft / send：我自己打的字也是聊天文字（草稿、送出前後）
 *   sendFails：中繼回錯誤（錯誤原文是敵意的；錯誤文字不准帶草稿，也不准把中繼的錯誤原文當成提示）
 *   receiveWhileHidden：聊天分頁沒開時收到訊息（只能更新未讀「數字」，不能 toast、不能更新別的分頁的預覽）
 *   receiveWhileOpen：開著時收到
 *   hostileMessage：對方的話像提示注入（內容仍只能畫在聊天分頁）
 *   urlInText：訊息含網址，不抓取、不預覽、不開瀏覽器（A6）
 *   command：打指令時回傳的文字不含聊天文字
 *   reconnect / leaveGroup / sessionEnd：生命週期，清掉記憶體、不寫盤
 */
export const CHAT_ACTIONS = [
  'openTab', 'closeTab', 'scroll', 'typeDraft', 'send', 'sendFails', 'receiveWhileHidden', 'receiveWhileOpen',
  'hostileMessage', 'urlInText', 'command', 'reconnect', 'leaveGroup', 'sessionEnd',
] as const
export type ChatAction = (typeof CHAT_ACTIONS)[number]

/** 只是「看」的情境：做這些時不該有任何對外網路請求（A6：不做連結預覽、不送已讀回條）。收訊息時輪詢中繼不算（那是 CHAT3 的路） */
export const READ_ONLY_ACTIONS: readonly ChatAction[] = ['openTab', 'closeTab', 'scroll', 'receiveWhileHidden', 'receiveWhileOpen', 'hostileMessage', 'urlInText']

export type ChatSubject = Readonly<{
  name: string
  /** 記憶體 atom 的名稱（world 靠它分辨「允許存聊天文字的唯一 state」） */
  atom: Readonly<{ plugin: string; key: string }>
  /** 聊天分頁畫面樹的 requestId（world 靠它分辨「唯一允許出現聊天文字的畫面」） */
  renderId: string
  /**
   * 聊天分頁和別的分頁共用同一個 requestId 時才填：props.key 以這個前綴開頭的子樹算聊天分頁，其餘部分照「別的畫面」掃。
   * 建議聊天分頁用獨立的 requestId，不要共用（不填＝整棵 renderId 的樹都算聊天分頁，聊天文字漏進同一棵樹的其他部分就抓不到）
   */
  chatKeyPrefix?: string
  /** 聊天分頁以外、要確認不含聊天文字的面板 */
  otherPanes: readonly Readonly<{ plugin: string; requestId: string }>[]
  /** 中繼位置：A6 檢查「只是看」的情境時，只准對這個來源的這些路徑發請求（輪詢收訊息）。其他一律算逃出（連結預覽、已讀回條） */
  network: Readonly<{ origin: string; readPaths: readonly string[]; bodyKeys?: Readonly<Record<string, readonly string[]>>; allowOps?: readonly string[] }>
  /** 假模組才有：內嵌外掛，交給 test 的 plugins 選項（真模組已在外掛的 register 裡，省略） */
  plugin?: Readonly<{ name: string; register: (on: any) => void }>
  /** 一開始放進 $.store 的東西（假模組用它選突變體）；真模組省略 */
  seed?: Readonly<Record<string, unknown>>
  /** 測試開始時給模組看世界（假模組要用假中繼和時鐘）；真模組不需要 */
  bind?: (w: IsoWorld) => void
  /** CHAT3-CLIENT 的出口：把一則已驗證、已解密的訊息放進記憶體 atom。不准走 $.store、不准走網路 */
  deliver: ($: any, message: ChatViewMessage, opts: { isTabOpen: boolean }) => Promise<void>
  /** 開聊天分頁 */
  mount: ($: any, surface: 'desktop' | 'terminal' | 'mobile') => Promise<any>
  /** 真模組額外要探測的「外掛當 hook 回答」事件：[事件名, 怎麼觸發]。回答會被 observe 並掃描（測試引擎觸發不了的事件，例如 UserPromptSubmit，只能靠靜態的 hook-answer 規則） */
  probes?: readonly (readonly [string, ($: any) => Promise<unknown>])[]
  /** 各情境怎麼觸發；不能做的寫 skip 理由 */
  actions: Readonly<Record<ChatAction, ChatActionFn | { skip: string }>>
}>

export type MatrixResult = Readonly<{
  /** 每個情境有沒有真的跑（含 skip 理由） */
  ran: Readonly<Record<ChatAction, 'ran' | { skipped: string }>>
  markers: MarkerSet
  /** 每個情境在 w.records 裡的範圍 [開始, 結束)，給 A6 這類「只看這一段」的檢查用 */
  slices: Readonly<Partial<Record<ChatAction, readonly [number, number]>>>
  /** 「外掛當 hook 回答引擎事件」的探測：哪些真的觸發成功（回答已掃描）、哪些觸發不了（不能默默略過） */
  probes: Readonly<{ ok: readonly string[]; failed: readonly string[] }>
}>

const PANE_PROPS = {
  title: 'Chat', isFocused: false, bodyColumns: 40, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 }, view: {},
}

let counter = 0

/** 這一輪用的四個標記（每次隨機，失敗時報告印出標記的 label 和命中的片段） */
export function freshMarkers(): MarkerSet {
  counter++
  return {
    text: makeMarker('text', counter),
    senderName: makeMarker('senderName', counter),
    draft: makeMarker('draft', counter),
    hostile: makeMarker('hostile', counter),
  }
}

/** 把標記包成 ChatViewMessage：寄件人名字和內文都是標記，網址只當文字 */
export function messageOf(markers: MarkerSet, kind: MessageKind, at: number, isMe = false): ChatViewMessage {
  const base = kind === 'hostile' ? markers.hostile.full : markers.text.full
  const text = kind === 'url' ? `${base} https://${markers.text.cores[0]!.value.toLowerCase()}.example.test/p?q=1` : base
  return {
    id: `iso${at}`.padEnd(22, 'A').slice(0, 22),
    senderId: 'm2',
    senderName: markers.senderName.full,
    isMe,
    sentAt: at,
    receivedAt: at,
    text,
  }
}

/**
 * 把全部情境照順序跑一遍。每個情境之後讓時鐘走一下（讓計時器、延遲的輪詢把東西送出去），
 * 並且補一次畫面快照：開著的聊天分頁、以及 otherPanes 各畫一次，樹記進世界（外層 hook 答掉的畫面 on('*') 看不到）。
 * 掃描不在這裡做：呼叫端拿 w.violations(...) 判斷，才能分辨「哪個情境、哪個出口」。
 */
export async function runMatrix($: any, w: IsoWorld, subject: ChatSubject, only?: readonly ChatAction[]): Promise<MatrixResult> {
  const markers = freshMarkers()
  let tab: any | undefined
  let seq = 0
  const snapshot = async () => {
    if (tab) {
      await tab.redraw()
      w.observe('ui.render', { requestId: subject.renderId, surface: 'desktop' }, await tab.drawn())
    }
    for (const p of subject.otherPanes) {
      const ui = await $.ui.mount({ plugin: p.plugin, surface: 'desktop', component: 'Pane', requestId: p.requestId, props: PANE_PROPS })
      w.observe('ui.render', { requestId: p.requestId, surface: 'desktop' }, await ui.drawn())
      await ui.unmount()
    }
  }
  const ctx = (): ChatActionCtx => ({
    w, markers,
    get tab() { return tab },
    openTab: async () => { tab ??= await subject.mount($, 'desktop'); return tab },
    closeTab: async () => { if (tab) { await tab.unmount(); tab = undefined } },
    deliver: async (kind, isTabOpen) => {
      await subject.deliver($, messageOf(markers, kind, 1_000 + seq++), { isTabOpen })
      await snapshot()
    },
    run: async (_$, line) => {
      const [command = '', ...rest] = line.split(' ')
      const r = await $.command.run({ command, args: rest.join(' '), origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
      w.observe('command.run', { command, args: rest.join(' ') }, r)
      return r
    },
  })
  const ran = {} as Record<ChatAction, 'ran' | { skipped: string }>
  const slices: Partial<Record<ChatAction, readonly [number, number]>> = {}
  const probes = { ok: [] as string[], failed: [] as string[] }
  // 外掛「當 hook 回答引擎事件」的回傳值會進模型脈絡，而真外掛的 hook 在測試 hook 外層、on('*') 看不到它的答案。
  // 所以每個情境之後，主動把這些事件各觸發一次，把最後的回答補記進世界（observe）掃描。觸發不了的列在 probes.failed，不默默略過
  const PROBES: readonly (readonly [string, () => Promise<unknown>])[] = [
    ...(subject.probes ?? []).map(([op, call]) => [op, () => call($)] as const),
    ['prompt.section', () => $.prompt.section({ name: 'iso-probe', text: 'base' })],
    ['prompt.context', () => $.prompt.context({ blocks: [] })],
    ['attribution.text', () => $.attribution.text({ kind: 'commit', text: 'base' })],
    ['skill.prompt', () => $.skill.prompt({ skill: 'iso-probe', text: 'base' })],
  ]
  const runProbes = async () => {
    for (const [op, call] of PROBES) {
      try {
        const r = await call()
        w.observe(op, { probe: true }, r)
        if (!probes.ok.includes(op)) probes.ok.push(op)
      } catch (err) {
        const msg = `${op}: ${String((err as Error)?.message ?? err).slice(0, 120)}`
        if (!probes.failed.includes(msg)) probes.failed.push(msg)
      }
    }
  }
  await $.session.start({ cwd: 'D:/work/site', surface: 'terminal', isInteractive: true })
  for (const name of CHAT_ACTIONS) {
    if (only && !only.includes(name)) continue
    const fn = subject.actions[name]
    if ('skip' in fn) { ran[name] = { skipped: fn.skip }; continue }
    const from = w.mark()
    await fn($, ctx())
    await w.clock.advance(1_000)
    await w.clock.settle()
    await snapshot()
    slices[name] = [from, w.mark()]
    ran[name] = 'ran'
    await runProbes()
  }
  // 收尾：讓虛擬時間再走 5 分鐘（延遲很久的計時器也要有機會發作），三種介面的畫面各畫一次
  await w.clock.advance(300_000)
  await w.clock.settle()
  if (tab) await tab.unmount()
  tab = undefined
  for (const surface of ['desktop', 'terminal', 'mobile'] as const) {
    try {
      const ui = await subject.mount($, surface)
      await ui.redraw()
      w.observe('ui.render', { requestId: subject.renderId, surface }, await ui.drawn())
      await ui.unmount()
    } catch (err) {
      probes.failed.push(`mount ${surface}: ${String((err as Error)?.message ?? err).slice(0, 120)}`)
    }
  }
  await runProbes()
  return { ran, markers, slices, probes }
}

/** A6 的網路白名單：給 w.networkEscapes 用 */
export function networkAllow(subject: ChatSubject): NetworkAllow {
  return { origin: subject.network.origin, paths: subject.network.readPaths, bodyKeys: subject.network.bodyKeys, allowOps: subject.network.allowOps }
}

/**
 * 一個隔離測試：建世界、把被測模組（假模組是內嵌外掛）裝上、再跑 body。
 * 順序固定：world 的 on('*') 必須比任何別的 hook 先登記（先登記的在最外層），不然別的 hook 直接把事件答掉，on('*') 就看不到。
 * 測試一律用這個，不要自己拼。
 */
export function isoTest(name: string, subject: ChatSubject, body: ($: any, w: IsoWorld) => Promise<void>, opts: Omit<IsoOptions, 'atom' | 'renderId'> = {}): void {
  test(name, { ...(subject.plugin ? { plugins: [subject.plugin as never] } : {}), timeoutMs: 60_000 }, async ($, on) => {
    const w = isoWorld(on, { ...opts, store: { ...opts.store, ...subject.seed }, atom: subject.atom, renderId: subject.renderId, chatKeyPrefix: subject.chatKeyPrefix })
    subject.bind?.(w)
    await body($, w)
  })
}
