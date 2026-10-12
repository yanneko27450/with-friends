export type Presence = 'working' | 'idle' | 'offline'

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
}

export type Membership = {
  relay: string
  groupId: string
  groupName: string
  memberId: string
  memberKey: string
  invite: string
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
  paused?: true
}

export type Net ={ isOk: boolean; error: string; at: number }

export type GroupView = { name: string; invite: string; isOwner: boolean; relay: string }

/** 外掛更新（ui-19）：latest＝中繼上比自己新的版本（沒有＝''）；state＝這個對話裡更新跑到哪 */
export type UpdateView = { latest: string; state: 'idle' | 'running' | 'done' | 'failed' }

declare module 'claude-code' {
  interface PluginState {
    'with-friends': {
      friends: Friend[]
      me: Me
      net: Net
      group: GroupView | null
      lang: 'en' | 'zh-TW'
      update: UpdateView
    }
  }
}
