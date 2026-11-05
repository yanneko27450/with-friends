// mod/hooks/chat-states.ts
// Chat tab empty-state and error-state copy, plus the tone for each state.
// All copy is fixed text; relay error text is not shown here.
import type { Lang } from './chat-types'

export const CHAT_STATE_KINDS = ['loading', 'empty', 'aloneInGroup', 'unavailable', 'unreachable', 'sendFailed', 'tooLong', 'notInGroup'] as const
export type ChatStateKind = (typeof CHAT_STATE_KINDS)[number]
export type ChatStateTone = 'dim' | 'warning' | 'error'

const overCount = (over: number): number => {
  if (!Number.isFinite(over) || over < 1) return 1
  return Math.floor(over)
}

/** 每種狀況每種語言的文案；tooLong 是函式 (over: number) => string，其餘是 string */
export const CHAT_STATE_TEXT = {
  en: {
    /** 第一次載入訊息中 */
    loading: 'Loading messages',
    /** 群組有其他人，但還沒有任何訊息 */
    empty: 'No messages yet. Say hello to start.',
    /** 群組只有自己一個人 */
    aloneInGroup: 'Only you here so far. Chat gets company when a friend joins the group.',
    /** 這個中繼還不支援聊天 */
    unavailable: 'This relay does not have chat yet. Everything else works as usual.',
    /** 連不上中繼 */
    unreachable: "Can't reach the relay right now. It will retry on its own.",
    /** 送出失敗，草稿還在輸入框 */
    sendFailed: 'Not sent. Your text is still in the box; press Send again.',
    /** 輸入超過長度；over 是超出的位元組數 */
    tooLong: (over: number) => {
      const n = overCount(over)
      return 'Too long: about ' + n + (n === 1 ? ' byte' : ' bytes') + ' over. Shorten it and send again.'
    },
    /** 還沒加入群組 */
    notInGroup: 'Join or create a group first to chat.',
  },
  'zh-TW': {
    /** 第一次載入訊息中 */
    loading: '正在載入訊息',
    /** 群組有其他人，但還沒有任何訊息 */
    empty: '還沒有訊息，跟大家打個招呼吧',
    /** 群組只有自己一個人 */
    aloneInGroup: '群組裡只有你，朋友加入後就有人可以聊天了',
    /** 這個中繼還不支援聊天 */
    unavailable: '這個中繼還沒有聊天功能，其他功能不受影響',
    /** 連不上中繼 */
    unreachable: '目前連不上中繼，會自動重試',
    /** 送出失敗，草稿還在輸入框 */
    sendFailed: '這則沒送出去，你打的字還在輸入框，可以再按一次送出',
    /** 輸入超過長度；over 是超出的位元組數 */
    tooLong: (over: number) => '太長了，超出約 ' + overCount(over) + ' 個位元組，縮短後再送',
    /** 還沒加入群組 */
    notInGroup: '先建立或加入群組才能聊天',
  },
}

const TONES: Record<ChatStateKind, ChatStateTone> = {
  loading: 'dim',
  empty: 'dim',
  aloneInGroup: 'dim',
  unavailable: 'warning',
  unreachable: 'warning',
  sendFailed: 'error',
  tooLong: 'error',
  notInGroup: 'dim',
}

export function chatStateText(kind: ChatStateKind, lang: Lang, over?: number): string {
  const value = CHAT_STATE_TEXT[lang][kind]
  if (typeof value === 'function') return value(over ?? 1)
  return value
}

export function chatStateTone(kind: ChatStateKind): ChatStateTone {
  return TONES[kind]
}
