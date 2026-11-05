import type { Lang } from './taxonomy'
export type { Lang }

/** 聊天訊息「畫面用」的樣子。text 在到這裡之前，已經由聊天用戶端（CHAT-3）驗證簽章、解密、清掉控制字元與方向字元；
 * 畫面層的程式把它當「已經乾淨的純文字」，不要自己再做任何安全清理。 */
export type ChatViewMessage = Readonly<{
  /** 訊息代號，22 個字元的 base64url（同一則訊息不會有兩個代號） */
  id: string
  /** 寄件人在群組裡的代號（畫面不顯示，只用來分組） */
  senderId: string
  /** 寄件人的顯示名字，已清理，最多 20 個字（code point） */
  senderName: string
  /** 是不是這台電腦的使用者自己寄的 */
  isMe: boolean
  /** 寄件人那邊的時間（epoch 毫秒） */
  sentAt: number
  /** 這台電腦收下這則訊息的時間（epoch 毫秒，用本機的鐘） */
  receivedAt: number
  /** 內文，純文字，UTF-8 最多 2000 位元組，可能含空白、換行 */
  text: string
}>

/** 一則訊息內文的位元組上限（跟加密信封核心的 MAX_CHAT_PLAINTEXT_BYTES 同一個數字） */
export const CHAT_MAX_TEXT_BYTES = 2000
