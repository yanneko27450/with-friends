// 中繼網址與成員資料的純函式（原本在 register.tsx；CHAT-4W 起聊天接線模組 chat-register.tsx 也要用，hook 模組之間不互相 import，所以搬到這裡，
// register.tsx 把同樣的名字原樣再匯出，既有的測試與呼叫不用改）。沒有 $、沒有保存。
import type { Membership } from '../types'

/** 官方中繼（ui-18 D：原本是本機開發用的 127.0.0.1:8789，新使用者直接 create 會失敗） */
export const DEFAULT_RELAY = 'https://friends-status-relay.friends-status-relay.workers.dev'

// 中繼產生的 id、金鑰、邀請碼都是 base64url 加「.」（relay/core.mjs token／newInvite）
const TOKEN_RE = /^[\w.-]{1,200}$/
export const isToken = (v: unknown): v is string => typeof v === 'string' && TOKEN_RE.test(v)

/**
 * L-18：store 裡的成員資料只在「少了就完全不能用」的四個欄位都對時才算在群組裡（中繼網址、群組代號、成員代號、金鑰）。
 * 壞掉的（例如 {}、字串、少了金鑰）當成沒加入：不然 create／join 會被 sec-14 擋住、心跳一直失敗，只能 leave --force 救。
 * 其他欄位缺了就補預設值。這純屬防禦：0.3.3 起每一版存的都是同樣八個欄位、代碼都是中繼發的 base64url（L-18 審查查過全部歷史），
 * 但萬一有少欄位的資料，也不能把它當成沒加入（那樣會讓人不知不覺被登出、名字留在中繼上）
 */
export function membershipOf(v: unknown): Membership | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  if (typeof o.relay !== 'string' || !o.relay || !isToken(o.groupId) || !isToken(o.memberId) || !isToken(o.memberKey)) return undefined
  return {
    relay: o.relay, groupId: o.groupId, memberId: o.memberId, memberKey: o.memberKey,
    invite: typeof o.invite === 'string' ? o.invite : '',
    inviteGeneration: typeof o.inviteGeneration === 'number' && Number.isSafeInteger(o.inviteGeneration) && o.inviteGeneration >= 0 ? o.inviteGeneration : 0,
    groupName: typeof o.groupName === 'string' ? o.groupName : '',
    isOwner: o.isOwner === true,
    name: typeof o.name === 'string' ? o.name : '',
  }
}

/** 中繼網址只留「協定＋主機＋埠」；舊版存下的網址有路徑、帳密之類就回 null（sec-6a） */
export function relayOrigin(relay: string): string | null {
  const m = /^(https?:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?)(?:\/|$)/.exec(relay)
  return m ? m[1]! : null
}

/** 主機名：用點分開的每一段 1～63 個英數字或「-」，不以「-」開頭結尾；不收空的段（a..b、結尾的點） */
const isHostname = (h: string) => h.length <= 253 && h.split('.').every(l => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l))

/**
 * sec-15：只跟 https 中繼說話；http 只放行本機（localhost、127.0.0.1，開發測試用）。
 * http 會讓成員金鑰（每個請求的 authorization）在網路上明碼跑。http 的主機名照 relayOrigin 的規則（不收 IPv6、帳密），
 * 所以 [::1] 也不放行（以前 parseInvite／relayOrigin 就不收 IPv6，不為了這張放寬）
 */
export function isSecureRelay(relay: string): boolean {
  // sec-16（sec-15 審查建議 2）：https 也要驗主機格式。以前 https 只看開頭，帶帳密（https://user:pw@x）、
  // 空的或 - 開頭的標籤、超過 65535 的埠也會被拿去 fetch
  const origin = relayOrigin(relay)
  const m = origin ? /^(https?):\/\/([^:/]+)(?::(\d+))?$/.exec(origin) : null
  if (!m || !isHostname(m[2]!)) return false
  if (m[3] !== undefined && (Number(m[3]) < 1 || Number(m[3]) > 65535)) return false
  if (m[1] === 'https') return true
  const host = m[2]!.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1'
}
