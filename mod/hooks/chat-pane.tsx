// mod/hooks/chat-pane.tsx
// CHAT-4W：聊天分頁的畫面。只畫（讀 view、呼叫 actions 給的函式），不碰 $、不 import 引擎、不寫任何地方：
// 元件（Box／Text／Button／Input）由接線層用 $.ui.resolve 取好傳進來；按鈕要做的事都是 actions 裡的函式（接線層決定怎麼做）。
// 畫面只用 Box／Text／Button／Input：不用 Markdown、Link、Image，不放 href／src（A6：不做連結預覽，訊息裡的網址只是文字）。
import { chatStateText, chatStateTone } from './chat-states'
import { formatMessageLine, formatMessageTime, sortMessages, tailWindow, truncateToCells } from './chat-list'
import { CHAT_STRINGS } from './chat-strings'
import { DM_STRINGS, dmEmptyConv, dmUnread, dmWith } from './dm-strings'
import { previewLines, PREVIEW_STRINGS } from './chat-preview-strings'
import { resolveTheme } from './chat-theme-resolve'
import { DEFAULT_THEME_ID, themeOrDefault } from './chat-themes'
import type { ChatViewMessage, Lang } from './chat-types'
import type { ChatAvailability, ChatViewState, DmRow } from './chat-view'
import { WIRE_STRINGS } from './chat-wire-strings'
import { formatUnreadBadge } from './chat-unread'

export type ChatSurface = 'desktop' | 'mobile' | 'terminal'

/** 接線層做好的元件。Input 沒有的介面（手機）給 undefined */
export type ChatElements = Readonly<{ Box: any; Text: any; Button: any; Input: any | undefined }>

export type ChatPaneActions = Readonly<{
  send(text: string): void
  sendDm(code: string, text: string): void
  setMode(mode: 'group' | 'dm-list'): void
  openThread(code: string): void
  dmRequest(peerId: string): void
  dmAccept(peerId: string): void
  dmDecline(peerId: string): void
  dmBlock(peerId: string): void
  dmUnblock(peerId: string): void
  toggleMute(code: string, isMuted: boolean): void
  resetDm(code: string): void
  toggleMore(): void
}>

export type ChatPaneInput = Readonly<{
  view: ChatViewState
  lang: Lang
  surface: ChatSurface
  /** 面板可用的行數、欄數（絕對值，來自 props.scroll.bodyRows／bodyColumns） */
  rows: number
  columns: number
  now: number
  tzOffsetMin: number
  actions: ChatPaneActions
}>

/** 不能聊天時畫面上那一句固定文字（每一種各有自己的字，不帶中繼或對方的任何字） */
export function unavailableText(availability: Exclude<ChatAvailability, 'ready'>, lang: Lang): string {
  switch (availability) {
    case 'checking': return chatStateText('loading', lang)
    case 'not-in-group': return chatStateText('notInGroup', lang)
    case 'relay-unsupported': return chatStateText('unavailable', lang)
    case 'relay-bad': return WIRE_STRINGS[lang].relayBad
    case 'peers-old': return WIRE_STRINGS[lang].peersOld
    case 'setup-needed': return WIRE_STRINGS[lang].setupNeeded
    case 'other-session': return WIRE_STRINGS[lang].otherSession
  }
}

const SECRET_HINT: Record<Lang, string> = {
  en: 'This looks like a password or key. Press Send again to send it anyway.',
  'zh-TW': '這段看起來像密碼或金鑰，要照送的話再按一次送出',
}

/** 狀況那一行的字：固定句子（tooLong 帶超出的位元組數；secretHint 是這個接線自己的一句） */
export function noticeText(view: ChatViewState, lang: Lang): string {
  if (view.state === null) return ''
  if (view.state === 'secretHint') return SECRET_HINT[lang]
  return chatStateText(view.state, lang, view.over)
}

const wrapRows = (cells: number, width: number): number => Math.max(1, Math.ceil(Math.max(1, cells) / Math.max(1, width)))

export function renderChatPane(els: ChatElements, input: ChatPaneInput) {
  const { Box, Text, Button, Input } = els
  const { view, lang, surface, actions } = input
  const s = CHAT_STRINGS[lang]
  const w = WIRE_STRINGS[lang]
  const theme = resolveTheme(themeOrDefault(DEFAULT_THEME_ID), surface, { svg: false, pattern: false })
  const c = theme.colors
  const isTerminal = surface === 'terminal'
  const cols = Math.max(20, Math.floor(input.columns))
  const rows = Math.max(6, Math.floor(input.rows))

  const preview = (kind: 'group' | 'dm') => {
    const lines = previewLines(kind, lang)
    // 終端機的面板很矮：預覽標籤＋第一句（沒有前向保密）一直在，第二句（換鑰的限制）按「這是什麼意思」才展開；桌面／手機兩句都在
    const shown = isTerminal && !view.previewMore ? lines.slice(0, 1) : lines
    return (
      <Box key="chat-preview" flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold color={c.warn}>{PREVIEW_STRINGS[lang].previewBadge}</Text>
          {isTerminal && <Button key="chat-more" label={PREVIEW_STRINGS[lang].previewLearnMore} onPress={() => actions.toggleMore()} />}
        </Box>
        {shown.map((line, i) => <Text key={'chat-preview-' + i} dimColor>{line}</Text>)}
      </Box>
    )
  }

  const title = (
    <Box key="chat-title" flexDirection="row" justifyContent="space-between" gap={1}>
      <Text bold color={c.text}>{s.tabChat}</Text>
      {view.unread > 0 && <Text color={c.badgeTx} backgroundColor={c.badgeBg} bold>{' ' + formatUnreadBadge(view.unread) + ' '}</Text>}
    </Box>
  )

  if (view.availability !== 'ready') {
    return (
      <Box flexDirection="column" gap={1}>
        {title}
        <Text key="chat-unavailable" dimColor wrap="wrap">{unavailableText(view.availability, lang)}</Text>
      </Box>
    )
  }

  const inDm = view.mode !== 'group'
  const dmUnreadTotal = view.dms.reduce((sum, row) => sum + row.unread, 0)
  const groupUnread = Math.max(0, view.unread - dmUnreadTotal)
  const tabs = (
    <Box key="chat-tabs" flexDirection="row" gap={1}>
      <Button key="chat-tab-group" label={s.tabChatName(groupUnread)} onPress={() => actions.setMode('group')}>
        <Text bold={!inDm} underline={!inDm}>{w.groupTab + (groupUnread > 0 ? ' ' + formatUnreadBadge(groupUnread) : '')}</Text>
      </Button>
      <Button key="chat-tab-dm" label={DM_STRINGS[lang].dmListTitle + (dmUnreadTotal > 0 ? ', ' + s.unreadBadgeName(dmUnreadTotal) : '')} onPress={() => actions.setMode('dm-list')}>
        <Text bold={inDm} underline={inDm}>{w.dmTab + (dmUnreadTotal > 0 ? ' ' + formatUnreadBadge(dmUnreadTotal) : '')}</Text>
      </Button>
    </Box>
  )

  const tone = view.state === null ? 'dim' : chatStateTone(view.state === 'secretHint' ? 'sendFailed' : view.state)
  const notice = view.state !== null ? (
    <Text key="chat-notice" color={tone === 'dim' ? undefined : c.warn} dimColor={tone === 'dim'} wrap="wrap">{noticeText(view, lang)}</Text>
  ) : null
  const clock = view.clockWarning ? <Text key="chat-clock" dimColor wrap="wrap">{w.clockWarning}</Text> : null

  // ---- 訊息列表 ----
  const fixedRows = 1 /* 標題 */ + 1 /* 分頁 */ + (isTerminal ? 3 : 5) /* 預覽 */ + (notice ? 1 : 0) + (clock ? 2 : 0) + 3 /* 輸入框＋間距 */
  const budget = Math.max(2, rows - fixedRows - (inDm ? 3 : 0))
  const bubble = (m: ChatViewMessage) => {
    const sent = formatMessageTime(m.sentAt, input.now, lang, input.tzOffsetMin)
    const named = Object.hasOwn(view.names, m.senderId) ? view.names[m.senderId]! : m.senderName
    const who = m.isMe ? s.youLabel : truncateToCells(named === '' ? '?' : named, 20)
    const a11y = m.isMe ? s.ownMessageName(sent) : s.messageName(who, sent)
    if (isTerminal) {
      return <Text key={'chat-m-' + m.id} color={m.isMe ? c.mine : c.theirs} wrap="truncate-end">{formatMessageLine({ ...m, senderName: named }, input.now, lang, input.tzOffsetMin, cols)}</Text>
    }
    return (
      <Box key={'chat-m-' + m.id} flexDirection="column" alignItems={m.isMe ? 'flex-end' : 'flex-start'}>
        <Text bold={theme.isNameBold} dimColor wrap="truncate-end">{a11y}</Text>
        <Box borderStyle={theme.borderStyle} borderColor={c.theirsline} paddingX={theme.padX} backgroundColor={m.isMe ? c.mine : c.theirs}>
          <Text color={m.isMe ? c.minetext : c.theirstext} wrap="wrap">{m.text}</Text>
        </Box>
      </Box>
    )
  }
  const list = (messages: readonly ChatViewMessage[], empty: string) => {
    const sorted = sortMessages(messages)
    if (sorted.length === 0) return <Text key="chat-empty" dimColor wrap="wrap">{empty}</Text>
    // 一則訊息在桌面版佔 3 行以上（名字行＋框＋內文），終端機 1 行
    const per = isTerminal ? 1 : 3
    const { shown, hiddenOlder } = tailWindow(sorted, Math.max(1, Math.floor(budget / per)))
    return (
      <Box key="chat-list" flexDirection="column" gap={theme.rowGap}>
        {hiddenOlder > 0 && <Text dimColor>{s.olderHidden(hiddenOlder)}</Text>}
        {shown.map(m => bubble(m))}
      </Box>
    )
  }

  // ---- 輸入框（手機沒有輸入框：官方型別 mobile 不給 Input） ----
  const composer = (submit: (text: string) => void) => (Input
    ? <Input key={'chat-input-' + view.inputGen} label={s.inputName} placeholder={s.inputPlaceholder} submitLabel={s.sendButton} onSubmit={(value: string) => submit(value)} />
    : <Text key="chat-no-input" dimColor wrap="wrap">{w.mobileInputHint}</Text>)

  // ---- 群組 ----
  if (view.mode === 'group') {
    const alone = view.dms.length === 0 && view.messages.length === 0
    return (
      <Box flexDirection="column" gap={1}>
        {title}
        {preview('group')}
        {tabs}
        {notice}
        {clock}
        {list(view.messages, alone ? chatStateText('aloneInGroup', lang) : chatStateText('empty', lang))}
        {composer(actions.send)}
      </Box>
    )
  }

  // ---- 私訊清單 ----
  if (view.mode === 'dm-list') {
    const dm = DM_STRINGS[lang]
    const rowsView = view.dms.map(row => dmRow(row))
    function dmRow(row: DmRow) {
      const tag = row.state === 'requested' ? w.dmRequested : row.state === 'incoming' ? w.dmIncoming : row.state === 'blocked' ? dm.dmBlockedTag : row.muted ? dm.dmMutedTag : ''
      const badge = row.unread > 0 ? ' ' + dmUnread(row.unread) : ''
      const key = row.peerId
      return (
        <Box key={'chat-dm-' + key} flexDirection="row" gap={1} alignItems="center">
          <Text bold wrap="truncate-end">{truncateToCells(row.peerName === '' ? '?' : row.peerName, 16) + badge}</Text>
          {tag !== '' && <Text dimColor>{tag}</Text>}
          {row.state === 'active' && <Button key={'chat-dm-open-' + key} label={w.dmOpen} onPress={() => actions.openThread(row.code)} />}
          {row.state === 'none' && <Button key={'chat-dm-start-' + key} label={w.dmStart} onPress={() => actions.dmRequest(row.peerId)} />}
          {row.state === 'incoming' && <Button key={'chat-dm-accept-' + key} label={w.dmAccept} onPress={() => actions.dmAccept(row.peerId)} />}
          {row.state === 'incoming' && <Button key={'chat-dm-decline-' + key} label={w.dmDecline} onPress={() => actions.dmDecline(row.peerId)} />}
          {row.state === 'blocked' && <Button key={'chat-dm-unblock-' + key} label={dm.dmUnblockButton} onPress={() => actions.dmUnblock(row.peerId)} />}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap={1}>
        {title}
        {preview('dm')}
        {tabs}
        {notice}
        {clock}
        <Text bold>{dm.dmListTitle}</Text>
        {rowsView.length === 0 ? <Text dimColor wrap="wrap">{view.dms.length === 0 ? w.dmListEmptyFriends : dm.dmPickFriend}</Text> : <Box flexDirection="column" gap={theme.rowGap}>{rowsView}</Box>}
      </Box>
    )
  }

  // ---- 一個私訊對話 ----
  const row = view.dms.find(item => item.code === view.threadCode)
  const dm = DM_STRINGS[lang]
  const name = row?.peerName ?? ''
  const messages = view.dmMessages[view.threadCode] ?? []
  const stalled = view.stalledCodes.includes(view.threadCode)
  return (
    <Box flexDirection="column" gap={1}>
      {title}
      {preview('dm')}
      <Box key="chat-dm-head" flexDirection="row" gap={1} alignItems="center">
        <Button key="chat-dm-back" label={w.dmBack} onPress={() => actions.setMode('dm-list')} />
        <Text bold wrap="truncate-end">{dmWith(name, lang)}</Text>
        {row && <Button key="chat-dm-mute" label={row.muted ? dm.dmUnmuteButton : dm.dmMuteButton} onPress={() => actions.toggleMute(row.code, !row.muted)} />}
        {row && <Button key="chat-dm-block" label={dm.dmBlockButton} onPress={() => actions.dmBlock(row.peerId)} />}
      </Box>
      {notice}
      {clock}
      {stalled && (
        <Box key="chat-dm-stalled" flexDirection="row" gap={1}>
          <Text color={c.warn} wrap="wrap">{w.dmStalled}</Text>
          <Button key="chat-dm-reset" label={w.dmReset} onPress={() => actions.resetDm(view.threadCode)} />
        </Box>
      )}
      {row?.muted ? <Text key="chat-dm-muted" dimColor wrap="wrap">{dm.dmMutedLine}</Text> : list(messages, dmEmptyConv(name, lang))}
      {row?.muted ? null : composer(text => actions.sendDm(view.threadCode, text))}
    </Box>
  )
}

