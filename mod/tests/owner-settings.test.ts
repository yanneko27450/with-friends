import { expect, test } from 'claude-code/testing'
import {
  GROUP_NAME_MAX,
  OWNER_CAP_MAX,
  OWNER_CAP_MIN,
  OWNER_STRINGS,
  WHO_CAN_INVITE,
  normalizeView,
  ownerSettingsRows,
  ownerStrings,
  pendingRows,
} from '../hooks/owner-settings'
import { AVATAR_EMOJI } from '../hooks/avatar'
import { cellWidth } from '../hooks/changelog'
import type { Lang } from '../hooks/taxonomy'

const LANGS: Lang[] = ['en', 'zh-TW']
const ZW = String.fromCharCode(0x200b)

const O1_EN = 'New members can join only after you approve them.'
const O1_ZH = '新成員要經過你同意才能加入。'
const O4_EN = 'Check that this number matches the one on their screen. Approve only if it does.'
const O4_ZH = '請核對對方畫面上的數字，一樣才按「同意」。'

const OWNER_VIEW = {
  isOwner: true,
  groupName: '週末讀書會',
  groupAvatar: 'cat',
  whoCanInvite: 'members',
  needsApproval: true,
  maxMembers: 4,
  memberCount: 3,
  pending: [{ requestId: 'req_1', name: '小明', pairingCode: '4839' }],
}

test('常數：人數上限範圍 2 到 5、群組名上限 30、邀請設定兩種', () => {
  expect(OWNER_CAP_MIN).toBe(2)
  expect(OWNER_CAP_MAX).toBe(5)
  expect(GROUP_NAME_MAX).toBe(30)
  expect(WHO_CAN_INVITE).toEqual(['owner', 'members'])
})

test('normalizeView 對 null、數字、字串、陣列都回全預設、不丟例外', () => {
  const d = { isOwner: false, groupName: '', groupAvatar: '', whoCanInvite: 'owner', needsApproval: false, maxMembers: 5, memberCount: 0, pending: [] }
  expect(normalizeView(null)).toEqual(d)
  expect(normalizeView(undefined)).toEqual(d)
  expect(normalizeView(42)).toEqual(d)
  expect(normalizeView('view')).toEqual(d)
  expect(normalizeView([1, 2, 3])).toEqual(d)
  expect(normalizeView(true)).toEqual(d)
})

test('normalizeView 的 isOwner 只有嚴格 true 才算數，字串 true 不算', () => {
  expect(normalizeView({ isOwner: true }).isOwner).toBe(true)
  expect(normalizeView({ isOwner: 'true' }).isOwner).toBe(false)
  expect(normalizeView({ isOwner: 1 }).isOwner).toBe(false)
  expect(normalizeView({}).isOwner).toBe(false)
})

test('normalizeView 的 needsApproval 只有嚴格 true 才算數', () => {
  expect(normalizeView({ needsApproval: true }).needsApproval).toBe(true)
  expect(normalizeView({ needsApproval: 'true' }).needsApproval).toBe(false)
  expect(normalizeView({ needsApproval: 1 }).needsApproval).toBe(false)
})

test('normalizeView 的 groupName：非字串回空、會清看不見的字、最多 30 字', () => {
  expect(normalizeView({ groupName: 123 }).groupName).toBe('')
  expect(normalizeView({ groupName: null }).groupName).toBe('')
  expect(normalizeView({ groupName: '  我的群組  ' }).groupName).toBe('我的群組')
  expect(normalizeView({ groupName: '甲' + ZW + '乙' }).groupName).toBe('甲乙')
  expect(normalizeView({ groupName: '長'.repeat(40) }).groupName).toHaveLength(30)
})

test('normalizeView 的 groupAvatar：合法頭像才收', () => {
  expect(normalizeView({ groupAvatar: 'fox' }).groupAvatar).toBe('fox')
  expect(normalizeView({ groupAvatar: 'dragon' }).groupAvatar).toBe('')
  expect(normalizeView({ groupAvatar: 7 }).groupAvatar).toBe('')
})

test('normalizeView 的 whoCanInvite：不合法回最保守的 owner', () => {
  expect(normalizeView({ whoCanInvite: 'members' }).whoCanInvite).toBe('members')
  expect(normalizeView({ whoCanInvite: 'owner' }).whoCanInvite).toBe('owner')
  expect(normalizeView({ whoCanInvite: 'admins' }).whoCanInvite).toBe('owner')
  expect(normalizeView({ whoCanInvite: null }).whoCanInvite).toBe('owner')
})

test('normalizeView 的 maxMembers：1 和 6 都不接受，只有 2 到 5 的整數才收', () => {
  expect(normalizeView({ maxMembers: 1 }).maxMembers).toBe(OWNER_CAP_MAX)
  expect(normalizeView({ maxMembers: 6 }).maxMembers).toBe(OWNER_CAP_MAX)
  expect(normalizeView({ maxMembers: 2 }).maxMembers).toBe(2)
  expect(normalizeView({ maxMembers: 5 }).maxMembers).toBe(5)
  expect(normalizeView({ maxMembers: 3.5 }).maxMembers).toBe(OWNER_CAP_MAX)
  expect(normalizeView({ maxMembers: NaN }).maxMembers).toBe(OWNER_CAP_MAX)
  expect(normalizeView({ maxMembers: '5' }).maxMembers).toBe(OWNER_CAP_MAX)
  expect(normalizeView({ maxMembers: Infinity }).maxMembers).toBe(OWNER_CAP_MAX)
})

test('normalizeView 的 memberCount：整數 0 到 1000 才收', () => {
  expect(normalizeView({ memberCount: 7 }).memberCount).toBe(7)
  expect(normalizeView({ memberCount: 0 }).memberCount).toBe(0)
  expect(normalizeView({ memberCount: -1 }).memberCount).toBe(0)
  expect(normalizeView({ memberCount: 1001 }).memberCount).toBe(0)
  expect(normalizeView({ memberCount: 2.5 }).memberCount).toBe(0)
  expect(normalizeView({ memberCount: '3' }).memberCount).toBe(0)
})

test('normalizeView 的 pending：不是陣列回空陣列', () => {
  expect(normalizeView({ pending: 'x' }).pending).toEqual([])
  expect(normalizeView({ pending: null }).pending).toEqual([])
  expect(normalizeView({}).pending).toEqual([])
})

test('normalizeView 的 pending：壞 requestId、壞配對數字、清完變空的名字整筆丟掉', () => {
  const v = normalizeView({
    pending: [
      { requestId: 'bad id!', name: '甲', pairingCode: '1234' },
      { requestId: 'ok_1', name: '甲', pairingCode: '12ab' },
      { requestId: 'ok_2', name: ZW + ZW, pairingCode: '1234' },
      { requestId: 'ok_3', name: '丙', pairingCode: '1234567890123' },
      'not-an-object',
      { requestId: 'good-1', name: '丁', pairingCode: '9876' },
    ],
  })
  expect(v.pending).toEqual([{ requestId: 'good-1', name: '丁', pairingCode: '9876' }])
})

test('normalizeView 的 pending：名字裡的零寬字被清掉', () => {
  const v = normalizeView({ pending: [{ requestId: 'r1', name: '小' + ZW + '明', pairingCode: '1111' }] })
  expect(v.pending).toHaveLength(1)
  expect(v.pending[0]?.name).toBe('小明')
})

test('normalizeView 的 pending：超過 10 筆只取前 10 筆', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ requestId: 'r' + i, name: '成員' + i, pairingCode: '1000' }))
  expect(normalizeView({ pending: many }).pending).toHaveLength(10)
})

test('ownerSettingsRows：群主八列、固定順序、全部可操作', () => {
  const rows = ownerSettingsRows(OWNER_VIEW, 'zh-TW')
  expect(rows.map((r) => r.id)).toEqual(['name', 'avatar', 'who-invites', 'approval', 'max-members', 'rotate-invite', 'revoke-invites', 'transfer'])
  expect(rows.every((r) => r.isEnabled)).toBe(true)
  expect(rows.map((r) => r.control)).toEqual(['text', 'choice', 'choice', 'toggle', 'number', 'action', 'action', 'action'])
})

test('ownerSettingsRows：成員只有前五列、全部不可操作', () => {
  const rows = ownerSettingsRows({ ...OWNER_VIEW, isOwner: false }, 'en')
  expect(rows.map((r) => r.id)).toEqual(['name', 'avatar', 'who-invites', 'approval', 'max-members'])
  expect(rows.every((r) => !r.isEnabled)).toBe(true)
})

test('ownerSettingsRows：isOwner 是字串 true 時也只給成員的五列唯讀', () => {
  const rows = ownerSettingsRows({ ...OWNER_VIEW, isOwner: 'true' }, 'en')
  expect(rows).toHaveLength(5)
  expect(rows.every((r) => !r.isEnabled)).toBe(true)
})

test('ownerSettingsRows：各列的值照目前設定顯示', () => {
  const rows = ownerSettingsRows(OWNER_VIEW, 'zh-TW')
  const byId = (id: string) => rows.find((r) => r.id === id)?.value
  expect(byId('name')).toBe('週末讀書會')
  expect(byId('avatar')).toBe(AVATAR_EMOJI.cat)
  expect(byId('who-invites')).toBe('所有成員')
  expect(byId('approval')).toBe('開')
  expect(byId('max-members')).toBe('4')
  expect(byId('rotate-invite')).toBe('')
  expect(byId('revoke-invites')).toBe('')
  expect(byId('transfer')).toBe('')
})

test('ownerSettingsRows：空群組名用 noName、沒頭像用 none、邀請與同意的關值', () => {
  const rows = ownerSettingsRows({ isOwner: true, groupName: '', groupAvatar: '', whoCanInvite: 'owner', needsApproval: false, maxMembers: 5, memberCount: 1, pending: [] }, 'en')
  const byId = (id: string) => rows.find((r) => r.id === id)?.value
  expect(byId('name')).toBe('(no name)')
  expect(byId('avatar')).toBe('(none)')
  expect(byId('who-invites')).toBe('Only the group owner')
  expect(byId('approval')).toBe('Off')
})

test('ownerSettingsRows：每一列 label 18 格內、value 24 格內（中英都算）', () => {
  for (const lang of LANGS) {
    const rows = ownerSettingsRows({ ...OWNER_VIEW, groupName: '長'.repeat(30) }, lang)
    for (const r of rows) {
      expect(cellWidth(r.label)).toBeLessThanOrEqual(18)
      expect(cellWidth(r.value)).toBeLessThanOrEqual(24)
    }
  }
})

test('ownerSettingsRows：超長的值會用 … 截斷', () => {
  const rows = ownerSettingsRows({ ...OWNER_VIEW, groupName: '長'.repeat(30) }, 'zh-TW')
  const name = rows.find((r) => r.id === 'name')
  expect(name?.value.endsWith('…')).toBe(true)
})

test('ownerSettingsRows 對 null、數字、字串不丟例外、回成員五列', () => {
  expect(ownerSettingsRows(null, 'en')).toHaveLength(5)
  expect(ownerSettingsRows(9, 'zh-TW')).toHaveLength(5)
  expect(ownerSettingsRows('x', 'en')).toHaveLength(5)
})

test('pendingRows：成員回空陣列', () => {
  expect(pendingRows({ ...OWNER_VIEW, isOwner: false }, 'en')).toEqual([])
  expect(pendingRows(null, 'zh-TW')).toEqual([])
})

test('pendingRows：群主看到名字、配對數字原樣、提醒句是 O4 逐字', () => {
  const en = pendingRows(OWNER_VIEW, 'en')
  expect(en).toHaveLength(1)
  expect(en[0]?.requestId).toBe('req_1')
  expect(en[0]?.title).toBe('小明')
  expect(en[0]?.code).toBe('4839')
  expect(en[0]?.hint).toBe(O4_EN)
  const zh = pendingRows(OWNER_VIEW, 'zh-TW')
  expect(zh[0]?.hint).toBe(O4_ZH)
})

test('pendingRows：名字裡的零寬字與換行被清掉、標題 24 格內', () => {
  const v = {
    ...OWNER_VIEW,
    pending: [
      { requestId: 'r1', name: '小' + ZW + '明', pairingCode: '2222' },
      { requestId: 'r2', name: '長'.repeat(20), pairingCode: '3333' },
    ],
  }
  const rows = pendingRows(v, 'zh-TW')
  expect(rows[0]?.title).toBe('小明')
  expect(rows[0]?.title).not.toContain(ZW)
  expect(cellWidth(rows[1]?.title ?? '')).toBeLessThanOrEqual(24)
})

test('OWNER_STRINGS：稱呼只用群主與 group owner（規劃部補充）', () => {
  expect(ownerStrings('en').ownerWord).toBe('group owner')
  expect(ownerStrings('zh-TW').ownerWord).toBe('群主')
  expect(ownerStrings('en').whoOwner).toBe('Only the group owner')
  expect(ownerStrings('zh-TW').whoOwner).toBe('只有群主')
  expect(ownerStrings('en').ownersOnly).toBe('Only the group owner can change these.')
  expect(ownerStrings('zh-TW').ownersOnly).toBe('這些只有群主可以改。')
})

test('OWNER_STRINGS：O1 固定承諾句逐字', () => {
  expect(ownerStrings('en').approvalOnNote).toBe(O1_EN)
  expect(ownerStrings('zh-TW').approvalOnNote).toBe(O1_ZH)
})

test('OWNER_STRINGS：面板標題、八個列名、按鈕與狀態句照卡', () => {
  const en = ownerStrings('en')
  expect(en.title).toBe('Group settings')
  expect(en.rows).toEqual({
    name: 'Group name',
    avatar: 'Group picture',
    'who-invites': 'Who can invite',
    approval: 'Approve new members',
    'max-members': 'Member limit',
    'rotate-invite': 'New invite code',
    'revoke-invites': 'Stop old invites',
    transfer: 'Hand over group',
  })
  expect(en.pendingTitle).toBe('Waiting for your OK')
  expect(en.approveButton).toBe('Approve')
  expect(en.rejectButton).toBe('Decline')
  expect(en.noPending).toBe('Nobody is waiting.')
  expect(en.askHeader).toBe('Please confirm')
  expect(en.yes).toBe('Yes')
  expect(en.no).toBe('No')
  const zh = ownerStrings('zh-TW')
  expect(zh.title).toBe('群組設定')
  expect(zh.rows.name).toBe('群組名稱')
  expect(zh.rows.transfer).toBe('轉讓群組')
  expect(zh.askHeader).toBe('請確認')
  expect(zh.yes).toBe('確定')
  expect(zh.no).toBe('取消')
  expect(OWNER_STRINGS.en).toBe(en)
})

test('所有面板字串不含禁字（中英都掃）', () => {
  const banned = ['手機', '傳檔案', '傳圖片', '表情回應', '提及', '已讀', '正在輸入', '搜尋訊息', '推播', '語音', '摘要', 'Claude', '保證', '絕對', '永遠', '私密', '保密', '刪除', 'encrypt', 'e2e', 'secure', 'private', 'safe', 'never', 'always', 'delete']
  const all: string[] = []
  for (const lang of LANGS) {
    const s = ownerStrings(lang)
    all.push(s.ownerWord, s.title, s.noName, s.none, s.whoOwner, s.whoMembers, s.on, s.off, s.approvalOnNote, s.pendingTitle, s.approveButton, s.rejectButton, s.ownersOnly, s.noPending, s.askHeader, s.yes, s.no)
    all.push(...Object.values(s.rows))
    for (const r of ownerSettingsRows(OWNER_VIEW, lang)) all.push(r.label, r.value)
    for (const p of pendingRows(OWNER_VIEW, lang)) all.push(p.title, p.hint)
  }
  for (const text of all) {
    for (const b of banned) {
      expect(text.toLowerCase()).not.toContain(b)
    }
  }
})

test('剛好放得下的值不截：24 格的群組名與 12 個中文字的等待名字原樣顯示，超過一格才加 …（實作部補）', () => {
  const name24 = 'abcdefghijklmnopqrstuvwx'
  const name25 = name24 + 'y'
  const zh12 = '一二三四五六七八九十甲乙'
  const row = (n: string) => ownerSettingsRows({ isOwner: true, groupName: n }, 'en').find((r) => r.id === 'name')
  expect(row(name24)?.value).toBe(name24)
  expect(row(name25)?.value).toBe(name24.slice(0, 23) + '…')
  const pend = (n: string) => pendingRows({ isOwner: true, pending: [{ requestId: 'r1', name: n, pairingCode: '1234' }] }, 'zh-TW')[0]
  expect(pend(zh12)?.title).toBe(zh12)
  expect(pend(zh12 + '丙')?.title).toBe(zh12.slice(0, 11) + '…')
})
