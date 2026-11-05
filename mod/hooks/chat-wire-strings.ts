// mod/hooks/chat-wire-strings.ts
// CHAT-4W 接線時多出來的固定句子（聊天分頁的狀況、私訊請求、新訊息提醒）。純函式，沒有 $。
// 全部是固定文字：不帶中繼、對方或訊息的任何字（新訊息提醒也不帶人名，INT060d 決定 1）。
// ⚠ TEMP_KEYS 裡的是暫定字串：Muse 還沒交（「對方外掛太舊」「中繼回應有問題」兩句，11-05 請主人轉提示詞），
//   其餘是接線臨時需要、Muse 的卡裡沒有的句子。換字串只改這個檔，不動程式；CHAT-4W 報告列出待換清單。
import type { Lang } from './chat-types'

export const WIRE_KEYS = [
  'relayBad', 'peersOld', 'setupNeeded', 'otherSession',
  'mobileInputHint', 'newMessageNotice', 'clockWarning',
  'dmStalled', 'dmReset', 'dmStart', 'dmRequested', 'dmIncoming', 'dmAccept', 'dmDecline', 'dmBack', 'dmOpen', 'dmListEmptyFriends',
  'groupTab', 'dmTab', 'dmThreadNoMessages',
] as const
export type WireKey = (typeof WIRE_KEYS)[number]

/** 暫定字串：整段都是接線時的臨時用字，等 Muse 交稿後換掉 */
export const TEMP_KEYS: readonly WireKey[] = WIRE_KEYS

export const WIRE_STRINGS: Record<Lang, Record<WireKey, string>> = {
  en: {
    relayBad: 'The relay\'s chat reply does not look right, so chat stays off for now. Everything else works as usual.',
    peersOld: 'No one else in this group can chat yet. They may need to update the plugin first.',
    setupNeeded: 'Chat is not set up on this computer yet.',
    otherSession: 'Chat is running in another Claude conversation. Use that one, or close it to chat here.',
    mobileInputHint: 'To write a message, use Claude on your computer.',
    newMessageNotice: 'New chat message',
    clockWarning: 'This computer\'s clock and the relay\'s differ by more than 10 minutes. Fix the clock so chat keys can renew.',
    dmStalled: 'Chat with this friend is stuck and needs a reset.',
    dmReset: 'Reset',
    dmStart: 'Message',
    dmRequested: 'Request sent',
    dmIncoming: 'Wants to chat',
    dmAccept: 'Accept',
    dmDecline: 'Decline',
    dmBack: 'Back',
    dmOpen: 'Open',
    dmListEmptyFriends: 'No friends to message yet.',
    groupTab: 'Group',
    dmTab: 'Direct',
    dmThreadNoMessages: 'No messages yet.',
  },
  'zh-TW': {
    relayBad: '中繼的聊天回應看起來不對，聊天先關著，其他功能不受影響',
    peersOld: '群組裡的其他人還不能聊天，他們可能要先更新外掛',
    setupNeeded: '這台電腦的聊天還沒設定好',
    otherSession: '聊天正在另一個 Claude 對話裡運作，請到那邊聊，或把那邊關掉再來',
    mobileInputHint: '要寫訊息，請用電腦上的 Claude',
    newMessageNotice: '有新的聊天訊息',
    clockWarning: '這台電腦的時間和中繼差超過 10 分鐘，請校正時間，聊天金鑰才能更新',
    dmStalled: '和這位朋友的聊天卡住了，需要重置',
    dmReset: '重置',
    dmStart: '傳訊息',
    dmRequested: '已送出請求',
    dmIncoming: '想和你聊天',
    dmAccept: '接受',
    dmDecline: '拒絕',
    dmBack: '返回',
    dmOpen: '打開',
    dmListEmptyFriends: '還沒有可以傳訊息的朋友',
    groupTab: '群組',
    dmTab: '私訊',
    dmThreadNoMessages: '還沒有訊息',
  },
}

export function wireText(key: WireKey, lang: Lang): string {
  if (!WIRE_KEYS.includes(key)) return ''
  return (lang === 'zh-TW' ? WIRE_STRINGS['zh-TW'] : WIRE_STRINGS.en)[key]
}

/** 所有通知類出口（toast）可以出現的句子，I8 逐字比對用；每種語言一份 */
export function noticeSentences(): readonly string[] {
  return Object.freeze([WIRE_STRINGS.en.newMessageNotice, WIRE_STRINGS['zh-TW'].newMessageNotice])
}
