// mod/hooks/chat-view.ts
// CHAT-4W：聊天分頁「畫面用」的狀態（記憶體 atom with-friends/chat 的內容）。純函式，沒有 $、沒有保存。
// 這裡出現的文字（訊息、對方的名字）都已經由聊天用戶端驗證、解密、清理過；畫面層把它當純文字畫，絕不往別處送。
import { CHAT_STATE_KINDS } from './chat-states.ts'
import type { ChatStateKind } from './chat-states.ts'
import type { ChatViewMessage } from './chat-types.ts'
import { countUnread, nextReadUpTo } from './chat-unread.ts'

/**
 * 聊天現在能不能用、不能用的話是哪一種。除了 ready，每一種畫面上都是固定文字（不帶中繼或對方的任何字）：
 * checking＝還在問中繼、not-in-group＝沒加入群組、relay-unsupported＝中繼沒有聊天（舊版或關著）、relay-bad＝中繼的回應有問題（簽章或內容不對）、
 * peers-old＝群組裡其他人都還沒有聊天（外掛太舊）、setup-needed＝這台電腦的聊天金鑰還沒準備好、other-session＝另一個對話正在負責聊天
 */
export const CHAT_AVAILABILITIES = ['checking', 'not-in-group', 'relay-unsupported', 'relay-bad', 'peers-old', 'setup-needed', 'other-session', 'ready'] as const
export type ChatAvailability = (typeof CHAT_AVAILABILITIES)[number]

/** 畫面上方那一行狀況：chat-states 的固定代碼，加上『這句看起來像密碼或金鑰，要再按一次才送』 */
export type ChatNotice = ChatStateKind | 'secretHint'
/** 聊天分頁的 requestId／pane id：跟朋友列表（'friends'）分開，兩棵畫面樹互不相干 */
export const CHAT_PANE_ID = 'friends-chat'

export type ChatMode = 'group' | 'dm-list' | 'dm-thread'
/** none＝群組裡的朋友，還沒有任何私訊連結（畫面給『傳訊息』鈕） */
export type DmLinkState = 'active' | 'requested' | 'incoming' | 'blocked' | 'none'

/** 私訊清單的一列。peerName 是群組成員名單上的名字（對方控制的字串，已清理），只畫在聊天分頁。code 只有 active 才有 */
export type DmRow = Readonly<{ peerId: string; peerName: string; state: DmLinkState; code: string; unread: number; muted: boolean }>

export type ChatViewState = Readonly<{
  availability: ChatAvailability
  mode: ChatMode
  /** mode 是 dm-thread 時選到的私訊信箱代碼；其餘為 '' */
  threadCode: string
  /** 群組聊天訊息，由舊到新（畫面再排序） */
  messages: readonly ChatViewMessage[]
  /** 私訊訊息，key 是信箱代碼 */
  dmMessages: Readonly<Record<string, readonly ChatViewMessage[]>>
  dms: readonly DmRow[]
  /** 只有這個數字可以被聊天分頁以外的畫面讀到（朋友列表的按鈕） */
  unread: number
  /** 畫面上方的一行狀況（unreachable、sendFailed、tooLong…）；固定句子，沒有中繼原文 */
  state: ChatNotice | null
  /** state 是 tooLong 時超出的位元組數 */
  over: number
  /** 每次送出成功就加一：輸入框的 key 跟著換，才會換成一個空的 */
  inputGen: number
  /** 已讀標記：'group' 或信箱代碼 → 已讀到的 receivedAt */
  readUpTo: Readonly<Record<string, number>>
  /** 終端機：預覽說明的第二句（換鑰限制）展開了嗎 */
  previewMore: boolean
  /** 成員代號 → 顯示名字（隨成員名單更新；畫面以這裡為準，訊息裡的 senderName 只是收到當時的快照） */
  names: Readonly<Record<string, string>>
  /** 兩台裝置的時鐘差太多（中繼的時間和本機差超過 10 分鐘） */
  clockWarning: boolean
  /** 這個私訊的會話卡住了（要重置） */
  stalledCodes: readonly string[]
}>

export const INITIAL_CHAT_VIEW: ChatViewState = Object.freeze({
  availability: 'checking',
  mode: 'group',
  threadCode: '',
  messages: Object.freeze([]),
  dmMessages: Object.freeze({}),
  dms: Object.freeze([]),
  unread: 0,
  state: null,
  over: 0,
  inputGen: 0,
  readUpTo: Object.freeze({}),
  previewMore: false,
  names: Object.freeze({}),
  clockWarning: false,
  stalledCodes: Object.freeze([]),
})

/** 每個對話最多留在記憶體裡幾則（舊的丟掉；中繼本來就只留 1 小時） */
export const KEEP_MESSAGES = 200

export const GROUP_KEY = 'group'

const isKind = (value: unknown): value is ChatNotice => value === 'secretHint' || (typeof value === 'string' && (CHAT_STATE_KINDS as readonly string[]).includes(value))

/** 把新訊息併進舊的（同一個 id 不會有兩則），只留最近 KEEP_MESSAGES 則 */
export function mergeMessages(old: readonly ChatViewMessage[], incoming: readonly ChatViewMessage[]): readonly ChatViewMessage[] {
  if (incoming.length === 0) return old
  const seen = new Set(old.map(message => message.id))
  const added: ChatViewMessage[] = []
  for (const message of incoming) {
    if (seen.has(message.id)) continue
    seen.add(message.id)
    added.push(message)
  }
  if (added.length === 0) return old
  const all = [...old, ...added].sort((a, b) => (Number.isFinite(a.sentAt) && Number.isFinite(b.sentAt) ? a.sentAt - b.sentAt : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return Object.freeze(all.length > KEEP_MESSAGES ? all.slice(all.length - KEEP_MESSAGES) : all)
}

/** 目前打開的那個對話的 key：群組聊天是 'group'，私訊是信箱代碼，其他是 ''（沒有打開的對話） */
export function openKey(view: ChatViewState): string {
  if (view.mode === 'group') return GROUP_KEY
  if (view.mode === 'dm-thread') return view.threadCode
  return ''
}

/** 重算未讀：靜音的私訊不算；正在看的對話（isOpen 且是它）把已讀標記推到最新 */
export function recount(view: ChatViewState, isTabOpen: boolean): ChatViewState {
  // Map：信箱代碼是中繼給的，連「__proto__」這種字也只是普通的鍵
  const marks = new Map<string, number>(Object.entries(view.readUpTo))
  const opened = isTabOpen ? openKey(view) : ''
  const mark = (key: string, messages: readonly ChatViewMessage[]) => {
    if (key === opened) marks.set(key, nextReadUpTo(messages, marks.get(key) ?? 0))
  }
  mark(GROUP_KEY, view.messages)
  for (const [code, messages] of Object.entries(view.dmMessages)) mark(code, messages)
  const groupUnread = countUnread(view.messages, marks.get(GROUP_KEY) ?? 0)
  const dms = view.dms.map(row => {
    const messages = row.code ? view.dmMessages[row.code] ?? [] : []
    const unread = row.muted || !row.code ? 0 : countUnread(messages, marks.get(row.code) ?? 0)
    return unread === row.unread ? row : Object.freeze({ ...row, unread })
  })
  const unread = groupUnread + dms.reduce((sum, row) => sum + row.unread, 0)
  return Object.freeze({ ...view, readUpTo: Object.freeze(Object.fromEntries(marks)), dms: Object.freeze(dms), unread })
}

/** 離開群組、被踢、對話結束：清回初始值（availability 由呼叫端指定） */
export function cleared(availability: ChatAvailability): ChatViewState {
  return Object.freeze({ ...INITIAL_CHAT_VIEW, availability })
}

/** 防呆：state 欄位只能是固定的狀況代碼 */
export function withState(view: ChatViewState, state: ChatNotice | null, over = 0): ChatViewState {
  return Object.freeze({ ...view, state: state === null || isKind(state) ? state : null, over: state === 'tooLong' ? Math.max(1, Math.floor(over)) : 0 })
}
