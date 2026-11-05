// mod/hooks/chat-preview-strings.ts
// Chat "Preview" badge and the fixed limitation sentences (P1 no forward secrecy, P2 direct-message rekey, P3 group rekey).
// P1-P3 are fixed promise sentences set by the project owner: do not reword, add or drop words.
// Pure functions, no `$`; panel wiring (when to show, where) lives in the chat tab, not here.
import type { Lang } from './chat-types'

export const PREVIEW_KEYS = [
  'previewBadge', 'previewBadgeName', 'previewNoFs', 'previewDmRekey', 'previewGroupRekey', 'previewLearnMore',
] as const
export type PreviewKey = (typeof PREVIEW_KEYS)[number]

/** 每個鍵的用途見 PreviewKey 對照：previewNoFs＝P1、previewDmRekey＝P2（只在私訊）、previewGroupRekey＝P3（只在群組） */
export const PREVIEW_STRINGS: Record<Lang, Record<PreviewKey, string>> = {
  en: {
    previewBadge: 'Preview',
    previewBadgeName: 'Chat preview',
    previewNoFs: 'Chat is a preview and does not have forward secrecy: if someone later gets chat keys from a computer in the chat, they may be able to read earlier messages that the relay, a backup or someone recording the traffic kept. How far back depends on the kind of chat; see below.',
    previewDmRekey: 'Direct-message keys are replaced about every 100 messages or 7 days (later if the other person is offline). A key can be used to send at most 120 messages, or for at most 8 days, in each direction; if the replacement has not finished by then, you cannot send until it has. This is not full per-message key replacement (not a Double Ratchet). Someone who gets the current key of a direct-message conversation can read the messages sent with it, and possibly those sent with the key just before or after it (within an hour); messages from keys replaced more than an hour ago stay unreadable.',
    previewGroupRekey: 'Group chat keys are replaced by the group owner\'s computer when someone joins, leaves or is removed, but not on a schedule.',
    previewLearnMore: 'What does this mean?',
  },
  'zh-TW': {
    previewBadge: '預覽',
    previewBadgeName: '聊天預覽',
    previewNoFs: '聊天還在預覽，沒有前向保密：如果有人日後從聊天裡某台電腦拿到聊天金鑰，他可能讀得到先前被中繼、備份或錄下傳輸的人留存下來的訊息。能讀多久以前的，群組和私訊不一樣，見下面。',
    previewDmRekey: '私訊的金鑰大約每 100 則訊息或 7 天換一次（對方離線時會延後）；同一把金鑰每個方向最多用來送 120 則或 8 天，到了還沒換成，就要等換好才能再送。這不是每一則都換（不是 Double Ratchet）。有人拿到某段私訊目前的金鑰，讀得到用那把金鑰傳的訊息，換鑰前後 1 小時內上一把或下一把的也可能被讀到；已經換掉超過 1 小時的讀不到。',
    previewGroupRekey: '群組聊天的金鑰在有人加入、離開或被移出時，由群主的電腦換新，但不會定期更換。',
    previewLearnMore: '這是什麼意思',
  },
}

/** key 不在 PREVIEW_KEYS 裡 → 回空字串（不丟例外）；lang 只認 'en'／'zh-TW'，其他當 'en' */
export function previewText(key: PreviewKey, lang: Lang): string {
  // 不用 PREVIEW_STRINGS[lang][key] 直接取：'toString'、'__proto__' 這些原型上的名字會被取到
  if (!PREVIEW_KEYS.includes(key)) return ''
  if (lang === 'zh-TW') return PREVIEW_STRINGS['zh-TW'][key]
  return PREVIEW_STRINGS.en[key]
}

export type PreviewKind = 'group' | 'dm'

/** 聊天畫面頂端要顯示的說明行（不含小標籤）。'group' → [previewNoFs, previewGroupRekey]；'dm' → [previewNoFs, previewDmRekey]；kind 不是這兩個值（含 undefined、null、其他字串）→ 回 'group' 那兩行（不確定時選說得少的那個）；lang 只認 'en'／'zh-TW'，其他當 'en'。每次回新陣列，不回共用的物件 */
export function previewLines(kind: PreviewKind, lang: Lang): string[] {
  const strings = lang === 'zh-TW' ? PREVIEW_STRINGS['zh-TW'] : PREVIEW_STRINGS.en
  if (kind === 'dm') return [strings.previewNoFs, strings.previewDmRekey]
  return [strings.previewNoFs, strings.previewGroupRekey]
}
