export type Presence = 'working' | 'idle' | 'offline'

/** CHAT-4W：聊天分頁的記憶體 atom（with-friends/chat）。這裡是型別，hooks/chat-view.ts 有同形狀的 ChatViewState（tsc 會檢查兩邊互相可指派）；聊天文字只存在這個 atom 裡 */
export type ChatMessageView = Readonly<{ id: string; senderId: string; senderName: string; isMe: boolean; sentAt: number; receivedAt: number; text: string }>
export type ChatDmRowView = Readonly<{ peerId: string; peerName: string; state: 'active' | 'requested' | 'incoming' | 'blocked' | 'none'; code: string; unread: number; muted: boolean }>
export type ChatView = Readonly<{
  availability: 'checking' | 'not-in-group' | 'relay-unsupported' | 'relay-bad' | 'peers-old' | 'setup-needed' | 'other-session' | 'ready'
  mode: 'group' | 'dm-list' | 'dm-thread'
  threadCode: string
  messages: readonly ChatMessageView[]
  dmMessages: Readonly<Record<string, readonly ChatMessageView[]>>
  dms: readonly ChatDmRowView[]
  unread: number
  state: 'loading' | 'empty' | 'aloneInGroup' | 'unavailable' | 'unreachable' | 'sendFailed' | 'tooLong' | 'notInGroup' | 'secretHint' | null
  over: number
  inputGen: number
  readUpTo: Readonly<Record<string, number>>
  previewMore: boolean
  /** 成員代號 → 顯示名字（隨名單更新；訊息裡的 senderName 是收到當時的快照，畫面以這裡為準） */
  names: Readonly<Record<string, string>>
  clockWarning: boolean
  stalledCodes: readonly string[]
}>

/** 中繼回的好友。action／subject 是代碼（可能是比我新的版本的代碼），顯示時用 activityText 翻。 */
export type Friend = {
  id: string
  name: string
  isMe: boolean
  isOwner: boolean
  presence: Presence
  action: string
  subject: string
  activityAgoSec: number | null
  seenAgoSec: number
  /** 對方外掛的版本（ui-19f ②）；舊版外掛、網頁成員沒有 */
  version?: string
}

export type Membership = {
  relay: string
  groupId: string
  groupName: string
  memberId: string
  memberKey: string
  invite: string
  /** 中繼核發邀請碼的單調世代；舊 store 沒有時視為 0 */
  inviteGeneration: number
  isOwner: boolean
  name: string
}

export type Me = {
  state: 'working' | 'idle'
  /** 上次分類出的代碼；'' ＝還沒有 */
  action: string
  subject: string
  /** 等著被分類的指令（已在本機遮過） */
  pending: string
  isPaused: boolean
  isHidden: boolean
}

/** 送給中繼的一筆狀態。conn＝這個對話的隨機 id（同一人可能同時開好幾個對話） */
export type StatusBody = {
  state: 'working' | 'idle' | 'offline'
  conn: string
  action?: string
  subject?: string
  paused?: boolean
  /** 0.5.8：最近一次按暫停／繼續的序號（單調遞增）；paused 請求才帶，中繼只認比已存更大的 */
  pauseSeq?: number
  version?: string
}

export type Net ={ isOk: boolean; error: string; at: number; code: number | null }

export type GroupView = { name: string; invite: string; isOwner: boolean; relay: string }

/** 外掛更新（ui-19）：latest＝中繼上比自己新的版本（沒有＝''）；state＝這個對話裡更新跑到哪 */
export type UpdateView = { latest: string; state: 'idle' | 'running' | 'done' | 'failed' | 'busy' }

/** 版本紀錄小框框（ui-28）：開著嗎（約 10 秒後自動收起，每個對話各自的）；version＝使用者挑的版本（ui-29），沒挑就是自己目前的版本 */
export type WhatsNewView = { isOpen: boolean; version?: string }

declare module 'claude-code' {
  interface PluginState {
    'with-friends': {
      friends: Friend[]
      me: Me
      net: Net
      group: GroupView | null
      lang: 'en' | 'zh-TW'
      update: UpdateView
      whatsNew: WhatsNewView
      removed: boolean
      demoHidden: boolean
      chat: ChatView
    }
  }
}
