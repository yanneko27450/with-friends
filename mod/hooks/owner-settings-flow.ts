import { isAvatar } from './taxonomy'
import type { Avatar, Lang } from './taxonomy'
import { isValidNameInput } from './text'
import { GROUP_NAME_MAX, OWNER_CAP_MAX, OWNER_CAP_MIN, WHO_CAN_INVITE } from './owner-settings'
import type { WhoCanInvite } from './owner-settings'

export type OwnerActionRequest =
  | Readonly<{ type: 'rename'; name: string }>
  | Readonly<{ type: 'set-avatar'; avatar: Avatar }>
  | Readonly<{ type: 'set-who-invites'; value: WhoCanInvite }>
  | Readonly<{ type: 'set-approval'; value: boolean }>
  | Readonly<{ type: 'set-max-members'; value: number }>
  | Readonly<{ type: 'approve'; requestId: string }>
  | Readonly<{ type: 'reject'; requestId: string }>
  | Readonly<{ type: 'rotate-invite' }>
  | Readonly<{ type: 'revoke-invites' }>
  | Readonly<{ type: 'transfer-owner'; memberId: string }>
export type OwnerActionFailure = 'not-owner' | 'stale' | 'limit' | 'invalid' | 'unreachable'
export type OwnerActionResult = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: OwnerActionFailure }>
/** 真正的實作由 Claude 做（權限判斷、同意、轉讓、邀請碼失效都在中繼端強制）。本卡只定介面；測試用假的 */
export interface OwnerActions {
  run(req: OwnerActionRequest): Promise<OwnerActionResult>
}
export interface OwnerFlowDeps {
  actions: OwnerActions
  /** 跳出確認框；使用者按「確定」回 true，按「取消」或把框關掉回 false */
  confirm(question: string, yes: string, no: string): Promise<boolean>
}

export type FlowStrings = Readonly<{
  cancelled: string
  yes: string
  no: string
  done: Readonly<Record<OwnerActionRequest['type'], string>>
}>

export const FLOW_STRINGS: Readonly<Record<Lang, FlowStrings>> = {
  en: {
    cancelled: 'Nothing was changed.',
    yes: 'Yes',
    no: 'No',
    done: {
      rename: 'Group name updated.',
      'set-avatar': 'Group picture updated.',
      'set-who-invites': 'Invite setting updated.',
      'set-approval': 'Approval setting updated.',
      'set-max-members': 'Member limit updated.',
      approve: 'Approved. They can join now.',
      reject: 'Request declined.',
      'rotate-invite': 'New invite code is ready.',
      'revoke-invites': 'Old invites stopped.',
      'transfer-owner': 'The group was handed over.',
    },
  },
  'zh-TW': {
    cancelled: '沒有改任何東西。',
    yes: '確定',
    no: '取消',
    done: {
      rename: '群組名稱已更新。',
      'set-avatar': '群組頭像已更新。',
      'set-who-invites': '邀請設定已更新。',
      'set-approval': '同意設定已更新。',
      'set-max-members': '人數上限已更新。',
      approve: '已同意，對方可以加入了。',
      reject: '已拒絕這個要求。',
      'rotate-invite': '新的邀請碼好了。',
      'revoke-invites': '舊邀請已停用。',
      'transfer-owner': '群組已轉讓。',
    },
  },
}

export function flowStrings(lang: Lang): FlowStrings {
  return FLOW_STRINGS[lang]
}

/** 需要先確認的四種，各一句固定問句（不含任何名字）；O2、O3 是固定承諾句，只能照抄 */
const CONFIRM_QUESTIONS: Readonly<Record<Lang, Readonly<Partial<Record<OwnerActionRequest['type'], string>>>>> = {
  en: {
    'transfer-owner': 'Hand this group over to the member you picked? You will become a regular member.',
    'revoke-invites': 'Stop all current invites? People who have not joined yet will need a new one.',
    'rotate-invite': 'Get a new invite code? The old one will stop working.',
    reject: 'Decline this request?',
  },
  'zh-TW': {
    'transfer-owner': '要把群組轉讓給你選的那位成員嗎？轉讓之後你就是一般成員。',
    'revoke-invites': '要停用目前所有的邀請嗎？還沒加入的人需要新的邀請。',
    'rotate-invite': '要換一個新的邀請碼嗎？舊的邀請碼就不能用了。',
    reject: '要拒絕這個加入要求嗎？',
  },
}

export function confirmQuestion(type: OwnerActionRequest['type'], lang: Lang): string | null {
  const q = CONFIRM_QUESTIONS[lang][type]
  return q === undefined ? null : q
}

/** 五種原因各一句固定句；不放處理函式回的任何文字 */
const FAILURE_TEXTS: Readonly<Record<Lang, Readonly<Record<OwnerActionFailure, string>>>> = {
  en: {
    'not-owner': 'Only the group owner can do that.',
    stale: 'This changed in another place. Please look again.',
    limit: 'That is over the allowed limit.',
    invalid: 'That value is not allowed.',
    unreachable: 'Could not reach the server. Nothing was changed.',
  },
  'zh-TW': {
    'not-owner': '只有群主可以這樣做。',
    stale: '這裡剛剛在別處改過了，請重新看一次。',
    limit: '超過可以設定的範圍了。',
    invalid: '這個值不能用。',
    unreachable: '連不上伺服器，沒有改到任何東西。',
  },
}

export function failureText(reason: OwnerActionFailure, lang: Lang): string {
  const table = FAILURE_TEXTS[lang]
  return Object.prototype.hasOwnProperty.call(table, reason) ? table[reason] : table.invalid
}

const ID_RE = new RegExp('^[A-Za-z0-9_-]{1,64}$')
const FAILURE_REASONS: readonly string[] = ['not-owner', 'stale', 'limit', 'invalid', 'unreachable']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function field(raw: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined
}

type Checked = Readonly<{ ok: true; req: OwnerActionRequest }> | Readonly<{ ok: false; reason: 'invalid' | 'limit' }>

const INVALID: Checked = { ok: false, reason: 'invalid' }

/** 本機檢查（只是方便，中繼端還會再檢查一次）；不通過就不確認、不呼叫處理函式 */
function checkRequest(req: unknown): Checked {
  if (!isRecord(req)) return INVALID
  const type = field(req, 'type')
  switch (type) {
    case 'rename': {
      const name = field(req, 'name')
      if (!isValidNameInput(name, GROUP_NAME_MAX)) return INVALID
      return { ok: true, req: { type: 'rename', name } }
    }
    case 'set-avatar': {
      const avatar = field(req, 'avatar')
      if (!isAvatar(avatar)) return INVALID
      return { ok: true, req: { type: 'set-avatar', avatar } }
    }
    case 'set-who-invites': {
      const value = field(req, 'value')
      if (typeof value !== 'string' || !(WHO_CAN_INVITE as readonly string[]).includes(value)) return INVALID
      return { ok: true, req: { type: 'set-who-invites', value: value as WhoCanInvite } }
    }
    case 'set-approval': {
      const value = field(req, 'value')
      if (typeof value !== 'boolean') return INVALID
      return { ok: true, req: { type: 'set-approval', value } }
    }
    case 'set-max-members': {
      const value = field(req, 'value')
      if (typeof value !== 'number' || !Number.isInteger(value)) return INVALID
      if (value < OWNER_CAP_MIN || value > OWNER_CAP_MAX) return { ok: false, reason: 'limit' }
      return { ok: true, req: { type: 'set-max-members', value } }
    }
    case 'approve':
    case 'reject': {
      const requestId = field(req, 'requestId')
      if (typeof requestId !== 'string' || !ID_RE.test(requestId)) return INVALID
      return { ok: true, req: { type, requestId } }
    }
    case 'rotate-invite':
      return { ok: true, req: { type: 'rotate-invite' } }
    case 'revoke-invites':
      return { ok: true, req: { type: 'revoke-invites' } }
    case 'transfer-owner': {
      const memberId = field(req, 'memberId')
      if (typeof memberId !== 'string' || !ID_RE.test(memberId)) return INVALID
      return { ok: true, req: { type: 'transfer-owner', memberId } }
    }
    default:
      return INVALID
  }
}

/** 處理函式回的東西不可信：只認 { ok: true } 與 { ok: false, reason 五種之一 }，多餘欄位一律丟掉 */
function normalizeResult(res: unknown): OwnerActionResult {
  if (!isRecord(res)) return { ok: false, reason: 'invalid' }
  if (res.ok === true) return { ok: true }
  if (res.ok === false && typeof res.reason === 'string' && FAILURE_REASONS.includes(res.reason)) {
    return { ok: false, reason: res.reason as OwnerActionFailure }
  }
  return { ok: false, reason: 'invalid' }
}

export async function runOwnerAction(
  deps: OwnerFlowDeps,
  req: unknown,
  lang: Lang,
): Promise<Readonly<{ message: string; shouldRefresh: boolean }>> {
  const s = flowStrings(lang)
  try {
    const checked = checkRequest(req)
    if (!checked.ok) return { message: failureText(checked.reason, lang), shouldRefresh: false }
    const action = checked.req
    const question = confirmQuestion(action.type, lang)
    if (question !== null) {
      let confirmed = false
      try {
        confirmed = (await deps.confirm(question, s.yes, s.no)) === true
      } catch {
        confirmed = false
      }
      if (!confirmed) return { message: s.cancelled, shouldRefresh: false }
    }
    let raw: unknown
    try {
      raw = await deps.actions.run(action)
    } catch {
      raw = { ok: false, reason: 'unreachable' }
    }
    const result = normalizeResult(raw)
    if (result.ok) return { message: s.done[action.type], shouldRefresh: true }
    return { message: failureText(result.reason, lang), shouldRefresh: result.reason === 'stale' }
  } catch {
    return { message: failureText('unreachable', lang), shouldRefresh: false }
  }
}
