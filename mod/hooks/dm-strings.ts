import type { Lang } from './chat-types'
import { truncateToCells } from './chat-list'

export const DM_KEYS = [
  'dmListTitle', 'dmListEmpty', 'dmPickFriend',
  'dmMutedTag', 'dmBlockedTag',
  'dmMuteButton', 'dmUnmuteButton', 'dmBlockButton', 'dmUnblockButton',
  'dmMuteConfirm', 'dmBlockConfirm',
  'dmMuted', 'dmUnmuted', 'dmBlocked', 'dmUnblocked',
  'dmMutedLine', 'dmBlockedLine', 'dmConfirmYes', 'dmConfirmNo',
] as const
export type DmKey = (typeof DM_KEYS)[number]

export const DM_STRINGS: Record<Lang, Record<DmKey, string>> = {
  en: {
    dmListTitle: 'Direct messages',
    dmListEmpty: 'No direct messages yet. Start one from a friend.',
    dmPickFriend: 'Pick a friend to start a one-on-one chat.',
    dmMutedTag: 'Muted',
    dmBlockedTag: 'Blocked',
    dmMuteButton: 'Mute',
    dmUnmuteButton: 'Unmute',
    dmBlockButton: 'Block',
    dmUnblockButton: 'Unblock',
    dmMuteConfirm: 'Mute this person? Muting hides this person\'s messages on your computer only. They are not told.',
    dmBlockConfirm: 'Block this person? After you block someone, you will not receive their direct messages.',
    dmMuted: 'Muted this person.',
    dmUnmuted: 'Unmuted this person.',
    dmBlocked: 'Blocked this person.',
    dmUnblocked: 'Unblocked this person.',
    dmMutedLine: 'This conversation is muted. Use Unmute above to undo it.',
    dmBlockedLine: 'This conversation is blocked. Use Unblock above to undo it.',
    dmConfirmYes: 'Confirm',
    dmConfirmNo: 'Cancel',
  },
  'zh-TW': {
    dmListTitle: '私訊',
    dmListEmpty: '還沒有私訊，從朋友那邊開始一個吧。',
    dmPickFriend: '選一位朋友，開始一對一聊天。',
    dmMutedTag: '已靜音',
    dmBlockedTag: '已封鎖',
    dmMuteButton: '靜音',
    dmUnmuteButton: '解除靜音',
    dmBlockButton: '封鎖',
    dmUnblockButton: '解除封鎖',
    dmMuteConfirm: '要靜音這個人嗎？靜音只在你的電腦上藏起這個人的訊息，不會通知對方。',
    dmBlockConfirm: '要封鎖這個人嗎？封鎖之後，你不會再收到這個人的私訊。',
    dmMuted: '已靜音這個人。',
    dmUnmuted: '已解除靜音這個人。',
    dmBlocked: '已封鎖這個人。',
    dmUnblocked: '已解除封鎖這個人。',
    dmMutedLine: '這段對話已靜音；要解除，按上面的「解除靜音」。',
    dmBlockedLine: '這段對話已封鎖；要解除，按上面的「解除封鎖」。',
    dmConfirmYes: '確定',
    dmConfirmNo: '取消',
  },
}

export function dmText(key: DmKey, lang: Lang): string {
  return DM_STRINGS[lang][key]
}

export function dmUnread(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  const v = Math.floor(n)
  if (v <= 0) return ''
  if (v >= 100) return '99+'
  return String(v)
}

function shortName(name: string): string {
  const t = truncateToCells(name, 12)
  return t === '' ? '?' : t
}

export function dmWith(name: string, lang: Lang): string {
  const n = shortName(name)
  return lang === 'zh-TW' ? `和 ${n} 的對話` : `Chat with ${n}`
}

export function dmEmptyConv(name: string, lang: Lang): string {
  const n = shortName(name)
  return lang === 'zh-TW' ? `和 ${n} 還沒有訊息，寫第一句吧。` : `Nothing here yet. Start the conversation with ${n}.`
}
