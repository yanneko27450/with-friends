import { expect, test } from 'claude-code/testing'
import { cellWidth } from '../hooks/changelog'
import {
  NOTICE_DEFAULTS,
  NOTICE_INITIAL,
  NOTICE_STRINGS,
  nextNotice,
  noticeStrings,
  noticeText,
} from '../hooks/friend-online-notice'
import type { Notice, NoticeConfig, NoticeState } from '../hooks/friend-online-notice'
import type { Lang } from '../hooks/taxonomy'

const LANGS: Lang[] = ['en', 'zh-TW']
const ON: NoticeConfig = NOTICE_DEFAULTS
const OFF: NoticeConfig = { isEnabled: false, perFriendCooldownMs: 600_000, minGapMs: 30_000 }
const asState = (v: unknown): NoticeState => v as NoticeState
const asNotice = (v: unknown): Notice => v as Notice

const E = (id: string, presence: string, extra?: Record<string, unknown>): Record<string, unknown> => ({
  id,
  name: id,
  presence,
  isMe: false,
  isDemo: false,
  ...(extra ?? {}),
})

test('NOTICE_INITIAL 與 NOTICE_DEFAULTS 定版且凍結', async () => {
  expect(NOTICE_INITIAL.online).toEqual({})
  expect(NOTICE_INITIAL.lastNoticeAt).toEqual({})
  expect(NOTICE_INITIAL.lastAnyAt).toBe(0)
  expect(NOTICE_INITIAL.isPrimed).toBe(false)
  expect(Object.isFrozen(NOTICE_INITIAL)).toBe(true)
  expect(Object.isFrozen(NOTICE_INITIAL.online)).toBe(true)
  expect(Object.isFrozen(NOTICE_INITIAL.lastNoticeAt)).toBe(true)
  expect(NOTICE_DEFAULTS.isEnabled).toBe(true)
  expect(NOTICE_DEFAULTS.perFriendCooldownMs).toBe(600_000)
  expect(NOTICE_DEFAULTS.minGapMs).toBe(30_000)
  expect(Object.isFrozen(NOTICE_DEFAULTS)).toBe(true)
})

test('規格範例：第一份只記錄、第二份 Amy 上線提醒、冷卻中不提醒、冷卻過後再提醒', async () => {
  const r1 = nextNotice(NOTICE_INITIAL, [E('Amy', 'offline'), E('Ben', 'working')], 1_000_000, ON)
  expect(r1.notice).toBe(null)
  expect(r1.state.isPrimed).toBe(true)
  expect(r1.state.online).toEqual({ Amy: false, Ben: true })
  const r2 = nextNotice(r1.state, [E('Amy', 'working'), E('Ben', 'working')], 1_100_000, ON)
  expect(r2.notice).toEqual({ names: ['Amy'], total: 1 })
  expect(r2.state.lastNoticeAt.Amy).toBe(1_100_000)
  expect(r2.state.lastAnyAt).toBe(1_100_000)
  const r3 = nextNotice(r2.state, [E('Amy', 'offline'), E('Ben', 'working')], 1_200_000, ON)
  expect(r3.notice).toBe(null)
  const r4 = nextNotice(r3.state, [E('Amy', 'working'), E('Ben', 'working')], 1_400_000, ON)
  expect(r4.notice).toBe(null)
  const r5 = nextNotice(r4.state, [E('Amy', 'offline'), E('Ben', 'working')], 1_500_000, ON)
  expect(r5.notice).toBe(null)
  const r6 = nextNotice(r5.state, [E('Amy', 'working'), E('Ben', 'working')], 1_800_000, ON)
  expect(r6.notice).toEqual({ names: ['Amy'], total: 1 })
  expect(r6.state.lastNoticeAt.Amy).toBe(1_800_000)
})

test('第一份名單就算全員在線也不提醒（啟動時不狂跳）', async () => {
  const r = nextNotice(NOTICE_INITIAL, [E('Amy', 'working'), E('Ben', 'idle'), E('Cy', 'working')], 5_000, ON)
  expect(r.notice).toBe(null)
  expect(r.state.online).toEqual({ Amy: true, Ben: true, Cy: true })
})

test('上次沒看過的新成員一出現不提醒；先離線被記錄後再上線才提醒', async () => {
  const r1 = nextNotice(NOTICE_INITIAL, [E('Amy', 'offline')], 1_000, ON)
  const r2 = nextNotice(r1.state, [E('Amy', 'offline'), E('New', 'working')], 2_000, ON)
  expect(r2.notice).toBe(null)
  expect(r2.state.online.New).toBe(true)
  const r3 = nextNotice(r2.state, [E('Amy', 'offline'), E('New', 'offline')], 3_000, ON)
  expect(r3.notice).toBe(null)
  const r4 = nextNotice(r3.state, [E('Amy', 'offline'), E('New', 'working')], 4_000, ON)
  expect(r4.notice).toEqual({ names: ['New'], total: 1 })
})

test('自己與示範機器人完全忽略：不提醒、不進 state.online', async () => {
  const r1 = nextNotice(
    NOTICE_INITIAL,
    [E('Me', 'offline', { isMe: true }), E('Bot', 'offline', { isDemo: true }), E('Amy', 'offline')],
    1_000,
    ON,
  )
  expect(r1.state.online).toEqual({ Amy: false })
  const r2 = nextNotice(
    r1.state,
    [E('Me', 'working', { isMe: true }), E('Bot', 'working', { isDemo: true }), E('Amy', 'offline')],
    2_000,
    ON,
  )
  expect(r2.notice).toBe(null)
  expect(r2.state.online).toEqual({ Amy: false })
})

test('一次多人上線只跳一則：名字照名單順序、最多 3 個、第 4 個起只算進 total', async () => {
  const ids = ['Amy', 'Ben', 'Cy', 'Dan', 'Eli']
  const r1 = nextNotice(NOTICE_INITIAL, ids.map((id) => E(id, 'offline')), 1_000, ON)
  const r2 = nextNotice(r1.state, ids.map((id) => E(id, 'working')), 2_000, ON)
  expect(r2.notice).toEqual({ names: ['Amy', 'Ben', 'Cy'], total: 5 })
  for (const id of ids) expect(r2.state.lastNoticeAt[id]).toBe(2_000)
  expect(r2.state.lastAnyAt).toBe(2_000)
})

test('冷卻邊界：差 599,999 毫秒不提醒、剛好 600,000 毫秒提醒', async () => {
  const r1 = nextNotice(NOTICE_INITIAL, [E('Amy', 'offline')], 0, ON)
  const r2 = nextNotice(r1.state, [E('Amy', 'working')], 100_000, ON)
  expect(r2.notice).toEqual({ names: ['Amy'], total: 1 })
  const r3 = nextNotice(r2.state, [E('Amy', 'offline')], 200_000, ON)
  const r4 = nextNotice(r3.state, [E('Amy', 'working')], 699_999, ON)
  expect(r4.notice).toBe(null)
  const r5 = nextNotice(r4.state, [E('Amy', 'offline')], 699_999, ON)
  const r6 = nextNotice(r5.state, [E('Amy', 'working')], 700_000, ON)
  expect(r6.notice).toEqual({ names: ['Amy'], total: 1 })
})

test('最小間隔邊界：差 29,999 毫秒整則不提醒、剛好 30,000 毫秒提醒，且被擋下的人不算被提醒過', async () => {
  const base = [E('Amy', 'offline'), E('Ben', 'offline')]
  const r1 = nextNotice(NOTICE_INITIAL, base, 0, ON)
  const r2 = nextNotice(r1.state, [E('Amy', 'working'), E('Ben', 'offline')], 100_000, ON)
  expect(r2.notice).toEqual({ names: ['Amy'], total: 1 })
  const r3 = nextNotice(r2.state, [E('Amy', 'working'), E('Ben', 'working')], 129_999, ON)
  expect(r3.notice).toBe(null)
  expect(r3.state.lastNoticeAt.Ben).toBe(undefined)
  expect(r3.state.lastAnyAt).toBe(100_000)
  const r4 = nextNotice(r3.state, [E('Amy', 'working'), E('Ben', 'offline')], 130_000, ON)
  const r5 = nextNotice(r4.state, [E('Amy', 'working'), E('Ben', 'working')], 130_000, ON)
  expect(r5.notice).toEqual({ names: ['Ben'], total: 1 })
})

test('時鐘倒退：nowMs 比上次提醒小，冷卻與間隔都視為已過、仍可提醒', async () => {
  const r1 = nextNotice(NOTICE_INITIAL, [E('Amy', 'offline')], 900_000, ON)
  const r2 = nextNotice(r1.state, [E('Amy', 'working')], 1_000_000, ON)
  expect(r2.notice).toEqual({ names: ['Amy'], total: 1 })
  const r3 = nextNotice(r2.state, [E('Amy', 'offline')], 1_100_000, ON)
  const r4 = nextNotice(r3.state, [E('Amy', 'working')], 500_000, ON)
  expect(r4.notice).toEqual({ names: ['Amy'], total: 1 })
})

test('關掉時不提醒但照常更新 online，重新打開不補跳；lastNoticeAt 與 lastAnyAt 不變', async () => {
  const r1 = nextNotice(NOTICE_INITIAL, [E('Amy', 'offline')], 1_000, OFF)
  expect(r1.state.isPrimed).toBe(true)
  expect(r1.notice).toBe(null)
  const r2 = nextNotice(r1.state, [E('Amy', 'working')], 2_000, OFF)
  expect(r2.notice).toBe(null)
  expect(r2.state.online.Amy).toBe(true)
  expect(r2.state.lastNoticeAt).toEqual({})
  expect(r2.state.lastAnyAt).toBe(0)
  const r3 = nextNotice(r2.state, [E('Amy', 'working')], 3_000, ON)
  expect(r3.notice).toBe(null)
})

test('isEnabled 不是嚴格 true 就當關掉', async () => {
  const weird = { isEnabled: 1, perFriendCooldownMs: 600_000, minGapMs: 30_000 } as unknown as NoticeConfig
  const r1 = nextNotice(NOTICE_INITIAL, [E('Amy', 'offline')], 1_000, ON)
  const r2 = nextNotice(r1.state, [E('Amy', 'working')], 2_000, weird)
  expect(r2.notice).toBe(null)
  expect(r2.state.online.Amy).toBe(true)
})

test('修剪：不在名單裡的 id 被丟、超過 24 小時的紀錄被丟、剛好 24 小時保留、在未來的被丟', async () => {
  const r1 = nextNotice(NOTICE_INITIAL, [E('Amy', 'offline'), E('Ben', 'offline')], 0, ON)
  const r2 = nextNotice(r1.state, [E('Amy', 'working'), E('Ben', 'offline')], 1_000_000, ON)
  expect(r2.state.lastNoticeAt.Amy).toBe(1_000_000)
  const gone = nextNotice(r2.state, [E('Ben', 'offline')], 1_100_000, ON)
  expect(gone.state.lastNoticeAt.Amy).toBe(undefined)
  const exact = nextNotice(r2.state, [E('Amy', 'offline'), E('Ben', 'offline')], 1_000_000 + 86_400_000, ON)
  expect(exact.state.lastNoticeAt.Amy).toBe(1_000_000)
  const over = nextNotice(r2.state, [E('Amy', 'offline'), E('Ben', 'offline')], 1_000_000 + 86_400_001, ON)
  expect(over.state.lastNoticeAt.Amy).toBe(undefined)
  const future = nextNotice(r2.state, [E('Amy', 'offline'), E('Ben', 'offline')], 999_999, ON)
  expect(future.state.lastNoticeAt.Amy).toBe(undefined)
})

test('離開名單的人從 online 被丟掉', async () => {
  const r1 = nextNotice(NOTICE_INITIAL, [E('Amy', 'working'), E('Ben', 'working')], 1_000, ON)
  const r2 = nextNotice(r1.state, [E('Amy', 'working')], 2_000, ON)
  expect(r2.state.online).toEqual({ Amy: true })
})

test('roster 不是陣列或 nowMs 不是有限數字：回同一個 state、notice 為 null', async () => {
  const prev = nextNotice(NOTICE_INITIAL, [E('Amy', 'offline')], 1_000, ON).state
  for (const bad of [null, undefined, 'Amy', 5, {}, Number.NaN] as unknown[]) {
    const r = nextNotice(prev, bad, 2_000, ON)
    expect(r.state).toBe(prev)
    expect(r.notice).toBe(null)
  }
  for (const badTime of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const r = nextNotice(prev, [E('Amy', 'working')], badTime, ON)
    expect(r.state).toBe(prev)
    expect(r.notice).toBe(null)
  }
})

test('壞名單筆數：缺欄位、presence 大小寫不對、id 是 __proto__ 都被跳過且不污染物件', async () => {
  const r1 = nextNotice(NOTICE_INITIAL, [E('Amy', 'offline')], 1_000, ON)
  const messy: unknown[] = [
    null,
    'x',
    7,
    [],
    {},
    { name: 'NoId', presence: 'working', isMe: false, isDemo: false },
    { id: 'NoPresence', name: 'NP', isMe: false, isDemo: false },
    { id: 'CaseId', name: 'Case', presence: 'Working', isMe: false, isDemo: false },
    { id: '__proto__', name: 'Proto', presence: 'working', isMe: false, isDemo: false },
    { id: 'bad id!', name: 'Bad', presence: 'working', isMe: false, isDemo: false },
    E('Amy', 'working'),
  ]
  const r2 = nextNotice(r1.state, messy, 2_000, ON)
  expect(r2.notice).toEqual({ names: ['Amy'], total: 1 })
  expect(Object.keys(r2.state.online)).toEqual(['Amy'])
  expect(Object.getPrototypeOf(r2.state.online)).toBe(Object.prototype)
  const probe: Record<string, unknown> = {}
  expect(probe.polluted).toBe(undefined)
})

test('同一個 id 出現多次只算第一次', async () => {
  const r1 = nextNotice(NOTICE_INITIAL, [E('Amy', 'offline')], 1_000, ON)
  const r2 = nextNotice(r1.state, [E('Amy', 'working', { name: 'First' }), E('Amy', 'offline', { name: 'Second' })], 2_000, ON)
  expect(r2.state.online.Amy).toBe(true)
  expect(r2.notice).toEqual({ names: ['First'], total: 1 })
})

test('名字清完是空字串用問號；名字含換行與零寬字由 cleanName 處理', async () => {
  const zw = String.fromCharCode(0x200b, 0x200c, 0xfeff)
  const r1 = nextNotice(NOTICE_INITIAL, [E('Amy', 'offline')], 1_000, ON)
  const r2 = nextNotice(r1.state, [E('Amy', 'working', { name: zw })], 2_000, ON)
  expect(r2.notice).toEqual({ names: ['?'], total: 1 })
  const r3 = nextNotice(r1.state, [E('Amy', 'working', { name: 'A\nmy' })], 2_000, ON)
  expect(r3.notice?.names[0]).not.toContain('\n')
})

test('名單只看前 200 筆，online 最多 200 筆', async () => {
  const big: Record<string, unknown>[] = []
  for (let i = 0; i < 250; i++) big.push(E('u' + i, 'working'))
  const r = nextNotice(NOTICE_INITIAL, big, 1_000, ON)
  expect(Object.keys(r.state.online)).toHaveLength(200)
  expect(r.state.online.u199).toBe(true)
  expect(r.state.online.u200).toBe(undefined)
})

test('設定值壞掉時用預設：perFriendCooldownMs 是 NaN 用 600,000、minGapMs 是負數用 30,000', async () => {
  const badCfg = { isEnabled: true, perFriendCooldownMs: Number.NaN, minGapMs: -5 } as unknown as NoticeConfig
  const r1 = nextNotice(NOTICE_INITIAL, [E('Amy', 'offline'), E('Ben', 'offline')], 0, ON)
  const r2 = nextNotice(r1.state, [E('Amy', 'working'), E('Ben', 'offline')], 100_000, badCfg)
  expect(r2.notice).toEqual({ names: ['Amy'], total: 1 })
  const r3 = nextNotice(r2.state, [E('Amy', 'offline'), E('Ben', 'working')], 120_000, badCfg)
  expect(r3.notice).toBe(null)
  const r4 = nextNotice(r3.state, [E('Amy', 'working'), E('Ben', 'offline')], 400_000, badCfg)
  expect(r4.notice).toBe(null)
})

test('純函式：prev 與 roster 被凍結也不被改、回傳的 state 與子物件都是新物件且凍結', async () => {
  const r1 = nextNotice(NOTICE_INITIAL, [E('Amy', 'offline')], 1_000, ON)
  const prev = r1.state
  const snapshot = JSON.stringify(prev)
  const roster = Object.freeze([Object.freeze(E('Amy', 'working'))])
  const r2 = nextNotice(prev, roster, 2_000, ON)
  expect(JSON.stringify(prev)).toBe(snapshot)
  expect(r2.state).not.toBe(prev)
  expect(r2.state.online).not.toBe(prev.online)
  expect(r2.state.lastNoticeAt).not.toBe(prev.lastNoticeAt)
  expect(Object.isFrozen(r2.state)).toBe(true)
  expect(Object.isFrozen(r2.state.online)).toBe(true)
  expect(Object.isFrozen(r2.state.lastNoticeAt)).toBe(true)
  expect(Object.isFrozen(r2.notice)).toBe(true)
  expect(Object.isFrozen(r2.notice?.names)).toBe(true)
})

test('state 欄位被塞壞值時不丟例外，當成初始狀態附近處理', async () => {
  const stuffed = asState({ online: 'x', lastNoticeAt: 7, lastAnyAt: 'y', isPrimed: 'yes', extra: [1, 2, 3] })
  expect(() => nextNotice(stuffed, [E('Amy', 'working')], 1_000, ON)).not.toThrow()
  const r = nextNotice(stuffed, [E('Amy', 'working')], 1_000, ON)
  expect(r.state.isPrimed).toBe(true)
  expect(r.notice).toBe(null)
  expect(() => nextNotice(asState(null), [E('Amy', 'working')], 1_000, ON)).not.toThrow()
})

test('noticeText：英文 1、2、3、5 人照規格', async () => {
  expect(noticeText({ names: ['Amy'], total: 1 }, 'en')).toBe('Amy is online')
  expect(noticeText({ names: ['Amy', 'Ben'], total: 2 }, 'en')).toBe('Amy and Ben are online')
  expect(noticeText({ names: ['Amy', 'Ben', 'Cy'], total: 3 }, 'en')).toBe('Amy, Ben and Cy are online')
  expect(noticeText({ names: ['Amy', 'Ben', 'Cy'], total: 5 }, 'en')).toBe('Amy, Ben, Cy and 2 more are online')
})

test('noticeText：繁中 1、2、3、5 人照規格', async () => {
  expect(noticeText({ names: ['Amy'], total: 1 }, 'zh-TW')).toBe('Amy 上線了')
  expect(noticeText({ names: ['Amy', 'Ben'], total: 2 }, 'zh-TW')).toBe('Amy、Ben 上線了')
  expect(noticeText({ names: ['Amy', 'Ben', 'Cy'], total: 3 }, 'zh-TW')).toBe('Amy、Ben、Cy 上線了')
  expect(noticeText({ names: ['Amy', 'Ben', 'Cy'], total: 5 }, 'zh-TW')).toBe('Amy、Ben、Cy 和另外 2 位上線了')
})

test('noticeText：空輸入回空字串；total 與 names 不一致以 names 為準', async () => {
  expect(noticeText({ names: [], total: 0 }, 'en')).toBe('')
  expect(noticeText({ names: [], total: 3 }, 'zh-TW')).toBe('')
  expect(noticeText(asNotice(null), 'en')).toBe('')
  expect(noticeText(asNotice({}), 'en')).toBe('')
  expect(noticeText({ names: ['Amy', 'Ben'], total: 1 }, 'en')).toBe('Amy and Ben are online')
  expect(noticeText({ names: ['Amy'], total: 0 }, 'zh-TW')).toBe('Amy 上線了')
})

test('noticeText：名字先截到 10 格（窄字與寬字）', async () => {
  expect(noticeText({ names: ['ABCDEFGHIJK'], total: 1 }, 'en')).toBe('ABCDEFGHI… is online')
  expect(noticeText({ names: ['一二三四五六'], total: 1 }, 'zh-TW')).toBe('一二三四… 上線了')
  expect(noticeText({ names: ['ABCDEFGHIJ'], total: 1 }, 'en')).toBe('ABCDEFGHIJ is online')
})

test('noticeText：整句不超過 60 格（用最長的名字測）', async () => {
  const long = 'ABCDEFGHIJ'
  for (const lang of LANGS) {
    expect(cellWidth(noticeText({ names: [long, long, long], total: 9 }, lang))).toBeLessThanOrEqual(60)
    expect(cellWidth(noticeText({ names: ['Amy'], total: 1 }, lang))).toBeLessThanOrEqual(60)
  }
})

test('開關文字定版：label、buttonName、hint、on、off 與 N1 逐字相等', async () => {
  const en = noticeStrings('en')
  const zh = noticeStrings('zh-TW')
  expect(en.label).toBe('Tell me when friends come online')
  expect(zh.label).toBe('朋友上線時提醒我')
  expect(en.buttonName).toBe('Turn the friend-online reminder on or off')
  expect(zh.buttonName).toBe('開啟或關閉朋友上線提醒')
  expect(en.hint).toBe('A short line appears here when a friend comes online.')
  expect(zh.hint).toBe('朋友上線時，這裡會跳出一小行提示。')
  expect(en.on).toBe('On')
  expect(en.off).toBe('Off')
  expect(zh.on).toBe('開')
  expect(zh.off).toBe('關')
  expect(en.privacyNote).toBe('This uses the online status you already see. Nothing extra is sent.')
  expect(zh.privacyNote).toBe('這只用你本來就看得到的在線狀態，不會多送任何東西。')
  expect(NOTICE_STRINGS.en).toBe(en)
  expect(NOTICE_STRINGS['zh-TW']).toBe(zh)
})

test('開關文字格數：繁中 label ≤ 24、兩種語言 buttonName ≤ 50、繁中 hint ≤ 50', async () => {
  const en = noticeStrings('en')
  const zh = noticeStrings('zh-TW')
  expect(cellWidth(zh.label)).toBeLessThanOrEqual(24)
  expect(cellWidth(en.buttonName)).toBeLessThanOrEqual(50)
  expect(cellWidth(zh.buttonName)).toBeLessThanOrEqual(50)
  expect(cellWidth(zh.hint)).toBeLessThanOrEqual(50)
})

test('禁字掃描：開關字串與提示句（中英）不含禁字清單的字', async () => {
  const banned = [
    'encrypt',
    'end-to-end',
    'e2e',
    'secure',
    'private',
    'safe',
    'never',
    'always',
    'delete',
    '刪除',
    '保證',
    '絕對',
    '永遠',
    '私密',
    '保密',
    '安全',
    '推播',
    '系統通知',
    '已讀',
    '語音',
    '震動',
    '聲音',
    '通知中心',
    '表情',
  ]
  const strings: string[] = []
  for (const lang of LANGS) {
    const s = noticeStrings(lang)
    strings.push(s.label, s.buttonName, s.hint, s.on, s.off, s.privacyNote)
    strings.push(noticeText({ names: ['Amy', 'Ben', 'Cy'], total: 5 }, lang))
    strings.push(noticeText({ names: ['Amy'], total: 1 }, lang))
  }
  for (const s of strings) {
    const lower = s.toLowerCase()
    for (const w of banned) expect(lower).not.toContain(w.toLowerCase())
  }
  expect(strings.length).toBeGreaterThan(0)
})

test('全部函式對壞輸入不丟例外', async () => {
  const prev = nextNotice(NOTICE_INITIAL, [E('Amy', 'offline')], 1_000, ON).state
  const weird: unknown[] = [null, undefined, 0, 'x', [], {}, Number.NaN, Number.POSITIVE_INFINITY]
  for (const v of weird) {
    expect(() => nextNotice(prev, v, 2_000, ON)).not.toThrow()
    expect(() => nextNotice(prev, [v], 2_000, ON)).not.toThrow()
    expect(() => noticeText(asNotice(v), 'en')).not.toThrow()
  }
  expect(() => nextNotice(prev, [E('Amy', 'working', { name: 'x'.repeat(100000) })], 2_000, ON)).not.toThrow()
})

test('還沒 primed 的 state 即使 online 有紀錄，第一份名單也只記錄不提醒（實作部補）', async () => {
  const prev = asState({ online: { amy: false }, lastNoticeAt: {}, lastAnyAt: 0, isPrimed: false })
  const r = nextNotice(prev, [E('amy', 'working')], 2_000_000, ON)
  expect(r.notice).toBe(null)
  expect(r.state.isPrimed).toBe(true)
  expect(r.state.online).toEqual({ amy: true })
})
