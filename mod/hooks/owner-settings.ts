import { cleanName } from './text'
import { isAvatar } from './taxonomy'
import type { Avatar, Lang } from './taxonomy'
import { AVATAR_EMOJI } from './avatar'

export const WHO_CAN_INVITE = ['owner', 'members'] as const
export type WhoCanInvite = (typeof WHO_CAN_INVITE)[number]
/** 可設定的人數上限範圍；面板上限以規劃部補充定的 5 為準 */
export const OWNER_CAP_MIN = 2
export const OWNER_CAP_MAX = 5
/** 群組名稱最多 30 個字（code point） */
export const GROUP_NAME_MAX = 30

export type OwnerSettingsView = Readonly<{
  isOwner: boolean
  groupName: string
  groupAvatar: Avatar | ''
  whoCanInvite: WhoCanInvite
  needsApproval: boolean
  maxMembers: number
  /** 成員數（含自己）；只用來顯示 */
  memberCount: number
  /** 等待同意的人 */
  pending: readonly Readonly<{ requestId: string; name: string; pairingCode: string }>[]
}>

const REQUEST_ID_RE = new RegExp('^[A-Za-z0-9_-]{1,64}$')
const PAIRING_CODE_RE = new RegExp('^[0-9]{1,12}$')
const PENDING_MAX = 10
const NAME_MAX = 20
const MEMBER_COUNT_MAX = 1000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function field(raw: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined
}

const DEFAULT_VIEW: OwnerSettingsView = {
  isOwner: false,
  groupName: '',
  groupAvatar: '',
  whoCanInvite: 'owner',
  needsApproval: false,
  maxMembers: OWNER_CAP_MAX,
  memberCount: 0,
  pending: [],
}

function cleanPending(raw: unknown): OwnerSettingsView['pending'] {
  if (!Array.isArray(raw)) return []
  const out: { requestId: string; name: string; pairingCode: string }[] = []
  for (const entry of raw) {
    if (out.length >= PENDING_MAX) break
    if (!isRecord(entry)) continue
    const requestId = field(entry, 'requestId')
    if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) continue
    const name = cleanName(field(entry, 'name'), NAME_MAX)
    if (name === '') continue
    const pairingCode = field(entry, 'pairingCode')
    if (typeof pairingCode !== 'string' || !PAIRING_CODE_RE.test(pairingCode)) continue
    out.push({ requestId, name, pairingCode })
  }
  return out
}

export function normalizeView(raw: unknown): OwnerSettingsView {
  try {
    if (!isRecord(raw)) return DEFAULT_VIEW
    const groupNameRaw = field(raw, 'groupName')
    const groupAvatarRaw = field(raw, 'groupAvatar')
    const whoRaw = field(raw, 'whoCanInvite')
    const maxRaw = field(raw, 'maxMembers')
    const countRaw = field(raw, 'memberCount')
    return {
      isOwner: field(raw, 'isOwner') === true,
      groupName: typeof groupNameRaw === 'string' ? cleanName(groupNameRaw, GROUP_NAME_MAX) : '',
      groupAvatar: isAvatar(groupAvatarRaw) ? groupAvatarRaw : '',
      whoCanInvite: whoRaw === 'members' ? 'members' : 'owner',
      needsApproval: field(raw, 'needsApproval') === true,
      maxMembers:
        typeof maxRaw === 'number' && Number.isInteger(maxRaw) && maxRaw >= OWNER_CAP_MIN && maxRaw <= OWNER_CAP_MAX
          ? maxRaw
          : OWNER_CAP_MAX,
      memberCount:
        typeof countRaw === 'number' && Number.isInteger(countRaw) && countRaw >= 0 && countRaw <= MEMBER_COUNT_MAX
          ? countRaw
          : 0,
      pending: cleanPending(field(raw, 'pending')),
    }
  } catch {
    return DEFAULT_VIEW
  }
}

export type SettingRowId = 'name' | 'avatar' | 'who-invites' | 'approval' | 'max-members' | 'rotate-invite' | 'revoke-invites' | 'transfer'
export type SettingRow = Readonly<{
  id: SettingRowId
  label: string
  value: string
  control: 'text' | 'choice' | 'toggle' | 'number' | 'action'
  /** 只有群主才 true */
  isEnabled: boolean
}>

const ROW_ORDER: readonly SettingRowId[] = ['name', 'avatar', 'who-invites', 'approval', 'max-members', 'rotate-invite', 'revoke-invites', 'transfer']
const MEMBER_ROW_COUNT = 5
const LABEL_MAX_CELLS = 18
const VALUE_MAX_CELLS = 24

const ROW_CONTROLS: Readonly<Record<SettingRowId, SettingRow['control']>> = {
  name: 'text',
  avatar: 'choice',
  'who-invites': 'choice',
  approval: 'toggle',
  'max-members': 'number',
  'rotate-invite': 'action',
  'revoke-invites': 'action',
  transfer: 'action',
}

/** 單格寬度規則同 cellWidth：codePoint > 0x2E7F 算 2 格，其他 1 格；剛好放得下就原樣，超過才用 … 截（截法同 friend-preview.ts） */
function truncateToCells(text: string, max: number): string {
  const cells = (ch: string): number => ((ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1)
  let total = 0
  for (const ch of text) total += cells(ch)
  if (total <= max) return text
  let width = 0
  let out = ''
  for (const ch of text) {
    const w = cells(ch)
    if (width + w + 1 > max) break
    width += w
    out += ch
  }
  return out + '…'
}

function rowValue(id: SettingRowId, view: OwnerSettingsView, s: OwnerStrings): string {
  switch (id) {
    case 'name':
      return view.groupName === '' ? s.noName : view.groupName
    case 'avatar': {
      if (view.groupAvatar === '') return s.none
      const emoji = AVATAR_EMOJI[view.groupAvatar]
      return emoji === undefined ? s.none : emoji
    }
    case 'who-invites':
      return view.whoCanInvite === 'members' ? s.whoMembers : s.whoOwner
    case 'approval':
      return view.needsApproval ? s.on : s.off
    case 'max-members':
      return `${view.maxMembers}`
    default:
      return ''
  }
}

export function ownerSettingsRows(view: unknown, lang: Lang): readonly SettingRow[] {
  const v = normalizeView(view)
  const s = ownerStrings(lang)
  const ids = v.isOwner ? ROW_ORDER : ROW_ORDER.slice(0, MEMBER_ROW_COUNT)
  return ids.map((id) => ({
    id,
    label: truncateToCells(s.rows[id], LABEL_MAX_CELLS),
    value: truncateToCells(rowValue(id, v, s), VALUE_MAX_CELLS),
    control: ROW_CONTROLS[id],
    isEnabled: v.isOwner,
  }))
}

export type PendingRow = Readonly<{ requestId: string; title: string; code: string; hint: string }>

/** O4 固定句：只能照抄，不得改寫意思 */
const PENDING_HINT: Readonly<Record<Lang, string>> = {
  en: 'Check that this number matches the one on their screen. Approve only if it does.',
  'zh-TW': '請核對對方畫面上的數字，一樣才按「同意」。',
}

export function pendingRows(view: unknown, lang: Lang): readonly PendingRow[] {
  const v = normalizeView(view)
  if (!v.isOwner) return []
  const hint = PENDING_HINT[lang]
  return v.pending.map((p) => ({
    requestId: p.requestId,
    title: truncateToCells(p.name, VALUE_MAX_CELLS),
    code: p.pairingCode,
    hint,
  }))
}

export type OwnerStrings = Readonly<{
  ownerWord: string
  title: string
  rows: Readonly<Record<SettingRowId, string>>
  noName: string
  none: string
  whoOwner: string
  whoMembers: string
  on: string
  off: string
  approvalOnNote: string
  pendingTitle: string
  approveButton: string
  rejectButton: string
  ownersOnly: string
  noPending: string
  askHeader: string
  yes: string
  no: string
}>

/** 稱呼只寫在這一處（規劃部補充：介面一律用「群主」／group owner），其他句子用模板帶入 */
const OWNER_WORD: Readonly<Record<Lang, string>> = {
  en: 'group owner',
  'zh-TW': '群主',
}

export const OWNER_STRINGS: Readonly<Record<Lang, OwnerStrings>> = {
  en: {
    ownerWord: OWNER_WORD.en,
    title: 'Group settings',
    rows: {
      name: 'Group name',
      avatar: 'Group picture',
      'who-invites': 'Who can invite',
      approval: 'Approve new members',
      'max-members': 'Member limit',
      'rotate-invite': 'New invite code',
      'revoke-invites': 'Stop old invites',
      transfer: 'Hand over group',
    },
    noName: '(no name)',
    none: '(none)',
    whoOwner: 'Only the ' + OWNER_WORD.en,
    whoMembers: 'Any member',
    on: 'On',
    off: 'Off',
    approvalOnNote: 'New members can join only after you approve them.',
    pendingTitle: 'Waiting for your OK',
    approveButton: 'Approve',
    rejectButton: 'Decline',
    ownersOnly: 'Only the ' + OWNER_WORD.en + ' can change these.',
    noPending: 'Nobody is waiting.',
    askHeader: 'Please confirm',
    yes: 'Yes',
    no: 'No',
  },
  'zh-TW': {
    ownerWord: OWNER_WORD['zh-TW'],
    title: '群組設定',
    rows: {
      name: '群組名稱',
      avatar: '群組頭像',
      'who-invites': '誰能邀請',
      approval: '新成員要同意',
      'max-members': '人數上限',
      'rotate-invite': '換邀請碼',
      'revoke-invites': '停用舊邀請',
      transfer: '轉讓群組',
    },
    noName: '（沒有名字）',
    none: '（沒有）',
    whoOwner: '只有' + OWNER_WORD['zh-TW'],
    whoMembers: '所有成員',
    on: '開',
    off: '關',
    approvalOnNote: '新成員要經過你同意才能加入。',
    pendingTitle: '等你同意的人',
    approveButton: '同意',
    rejectButton: '拒絕',
    ownersOnly: '這些只有' + OWNER_WORD['zh-TW'] + '可以改。',
    noPending: '目前沒有人在等。',
    askHeader: '請確認',
    yes: '確定',
    no: '取消',
  },
}

export function ownerStrings(lang: Lang): OwnerStrings {
  return OWNER_STRINGS[lang]
}
