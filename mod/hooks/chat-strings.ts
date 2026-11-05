// mod/hooks/chat-strings.ts
// Chat tab fixed strings, English and Traditional Chinese.
// Empty-state and error-state copy lives in chat-states.ts, not here.
import type { Lang } from './chat-types'

const whole = (n: number): number => (Number.isFinite(n) ? Math.floor(n) : 0)
const count = (n: number): number => Math.max(0, whole(n))

export const CHAT_STRINGS = {
  en: {
    /** 分頁標籤：聊天 */
    tabChat: 'Chat',
    /** 分頁標籤：好友列表 */
    tabFriends: 'Friends',
    /** 聊天分頁標籤的無障礙名稱，帶未讀數 */
    tabChatName: (unread: number) => {
      const n = count(unread)
      if (n <= 0) return 'Chat'
      return n === 1 ? 'Chat, 1 unread message' : 'Chat, ' + n + ' unread messages'
    },
    /** 好友分頁標籤的無障礙名稱 */
    tabFriendsName: 'Friends list',
    /** 輸入框空著時顯示的提示字 */
    inputPlaceholder: 'Type a message',
    /** 輸入框的無障礙名稱，說明這裡打的是聊天訊息 */
    inputName: 'Message input, for chat text, not a command',
    /** 送出按鈕的字 */
    sendButton: 'Send',
    /** 送出按鈕的無障礙名稱 */
    sendButtonName: 'Send message',
    /** 送出中顯示的短字 */
    sending: 'Sending',
    /** 輸入框旁的剩餘位元組顯示 */
    counterLeft: (remaining: number) => {
      const n = whole(remaining)
      return n >= 0 ? n + ' left' : 'over by ' + -n
    },
    /** 訊息列表區域的無障礙名稱 */
    listName: 'Chat messages',
    /** 自己的訊息在名字處顯示的字 */
    youLabel: 'You',
    /** 一則別人訊息的無障礙名稱，只有寄件人與時間 */
    messageName: (sender: string, time: string) => sender + ', ' + time,
    /** 自己一則訊息的無障礙名稱 */
    ownMessageName: (time: string) => 'Your message, ' + time,
    /** 列表上方：還有幾則較舊的沒顯示 */
    olderHidden: (n: number) => {
      const c = count(n)
      return c === 1 ? '1 older message not shown' : c + ' older messages not shown'
    },
    /** 未讀數字的無障礙名稱 */
    unreadBadgeName: (n: number) => {
      const c = count(n)
      if (c <= 0) return 'No unread messages'
      return c === 1 ? '1 unread message' : c + ' unread messages'
    },
    /** 手機版 /friends 回的一行未讀提示，只有數字能變 */
    mobileUnreadLine: (n: number) => {
      const c = count(n)
      return c === 1
        ? '1 unread chat message. Please check the pane on your computer.'
        : c + ' unread chat messages. Please check the pane on your computer.'
    },
  },
  'zh-TW': {
    /** 分頁標籤：聊天 */
    tabChat: '聊天',
    /** 分頁標籤：好友列表 */
    tabFriends: '好友',
    /** 聊天分頁標籤的無障礙名稱，帶未讀數 */
    tabChatName: (unread: number) => {
      const n = count(unread)
      if (n <= 0) return '聊天'
      return '聊天，' + n + ' 則未讀'
    },
    /** 好友分頁標籤的無障礙名稱 */
    tabFriendsName: '好友列表',
    /** 輸入框空著時顯示的提示字 */
    inputPlaceholder: '輸入訊息',
    /** 輸入框的無障礙名稱，說明這裡打的是聊天訊息 */
    inputName: '聊天訊息輸入框，不是輸入指令的地方',
    /** 送出按鈕的字 */
    sendButton: '送出',
    /** 送出按鈕的無障礙名稱 */
    sendButtonName: '送出訊息',
    /** 送出中顯示的短字 */
    sending: '送出中',
    /** 輸入框旁的剩餘位元組顯示 */
    counterLeft: (remaining: number) => {
      const n = whole(remaining)
      return n >= 0 ? '還剩 ' + n : '超出 ' + -n
    },
    /** 訊息列表區域的無障礙名稱 */
    listName: '聊天訊息列表',
    /** 自己的訊息在名字處顯示的字 */
    youLabel: '你',
    /** 一則別人訊息的無障礙名稱，只有寄件人與時間 */
    messageName: (sender: string, time: string) => sender + '，' + time,
    /** 自己一則訊息的無障礙名稱 */
    ownMessageName: (time: string) => '你的訊息，' + time,
    /** 列表上方：還有幾則較舊的沒顯示 */
    olderHidden: (n: number) => '還有 ' + count(n) + ' 則較舊的沒顯示',
    /** 未讀數字的無障礙名稱 */
    unreadBadgeName: (n: number) => {
      const c = count(n)
      if (c <= 0) return '沒有未讀訊息'
      return c + ' 則未讀訊息'
    },
    /** 手機版 /friends 回的一行未讀提示，只有數字能變 */
    mobileUnreadLine: (n: number) => '聊天有 ' + count(n) + ' 則未讀，請在電腦的面板查看',
  },
}
export type ChatStrings = (typeof CHAT_STRINGS)['en']
