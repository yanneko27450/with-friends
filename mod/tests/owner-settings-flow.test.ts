import { expect, test } from 'claude-code/testing'
import { FLOW_STRINGS, confirmQuestion, failureText, flowStrings, runOwnerAction } from '../hooks/owner-settings-flow'
import type { OwnerActionRequest, OwnerActionResult, OwnerFlowDeps } from '../hooks/owner-settings-flow'
import { cellWidth } from '../hooks/changelog'
import type { Lang } from '../hooks/taxonomy'

const LANGS: Lang[] = ['en', 'zh-TW']
const ZW = String.fromCharCode(0x200b)

const ALL_TYPES: OwnerActionRequest['type'][] = [
  'rename',
  'set-avatar',
  'set-who-invites',
  'set-approval',
  'set-max-members',
  'approve',
  'reject',
  'rotate-invite',
  'revoke-invites',
  'transfer-owner',
]

const VALID_REQ: Record<OwnerActionRequest['type'], OwnerActionRequest> = {
  rename: { type: 'rename', name: '新群組名' },
  'set-avatar': { type: 'set-avatar', avatar: 'fox' },
  'set-who-invites': { type: 'set-who-invites', value: 'members' },
  'set-approval': { type: 'set-approval', value: true },
  'set-max-members': { type: 'set-max-members', value: 3 },
  approve: { type: 'approve', requestId: 'req_1' },
  reject: { type: 'reject', requestId: 'req_1' },
  'rotate-invite': { type: 'rotate-invite' },
  'revoke-invites': { type: 'revoke-invites' },
  'transfer-owner': { type: 'transfer-owner', memberId: 'member_2' },
}

function fakeDeps(result: unknown, confirmResult: boolean = true) {
  const calls = { confirm: 0, run: 0, questions: [] as string[], lastReq: null as unknown }
  const deps: OwnerFlowDeps = {
    actions: {
      run: async (req: OwnerActionRequest) => {
        calls.run++
        calls.lastReq = req
        return result as OwnerActionResult
      },
    },
    confirm: async (q: string) => {
      calls.confirm++
      calls.questions.push(q)
      return confirmResult
    },
  }
  return { deps, calls }
}

test('confirmQuestion：四種要確認的回固定問句（O2、O3 逐字）', () => {
  expect(confirmQuestion('transfer-owner', 'en')).toBe('Hand this group over to the member you picked? You will become a regular member.')
  expect(confirmQuestion('transfer-owner', 'zh-TW')).toBe('要把群組轉讓給你選的那位成員嗎？轉讓之後你就是一般成員。')
  expect(confirmQuestion('revoke-invites', 'en')).toBe('Stop all current invites? People who have not joined yet will need a new one.')
  expect(confirmQuestion('revoke-invites', 'zh-TW')).toBe('要停用目前所有的邀請嗎？還沒加入的人需要新的邀請。')
  expect(confirmQuestion('rotate-invite', 'en')).toBe('Get a new invite code? The old one will stop working.')
  expect(confirmQuestion('rotate-invite', 'zh-TW')).toBe('要換一個新的邀請碼嗎？舊的邀請碼就不能用了。')
  expect(confirmQuestion('reject', 'en')).toBe('Decline this request?')
  expect(confirmQuestion('reject', 'zh-TW')).toBe('要拒絕這個加入要求嗎？')
})

test('confirmQuestion：其餘六種回 null（approve 不用再確認）', () => {
  for (const t of ['rename', 'set-avatar', 'set-who-invites', 'set-approval', 'set-max-members', 'approve'] as const) {
    expect(confirmQuestion(t, 'en')).toBe(null)
    expect(confirmQuestion(t, 'zh-TW')).toBe(null)
  }
})

test('confirmQuestion：問句不含任何人的名字、90 格內', () => {
  for (const lang of LANGS) {
    for (const t of ALL_TYPES) {
      const q = confirmQuestion(t, lang)
      if (q === null) continue
      expect(q).not.toContain('Alice')
      expect(q).not.toContain('小明')
      expect(cellWidth(q)).toBeLessThanOrEqual(90)
    }
  }
})

test('failureText：五種原因各一句固定句（逐字）', () => {
  expect(failureText('not-owner', 'en')).toBe('Only the group owner can do that.')
  expect(failureText('not-owner', 'zh-TW')).toBe('只有群主可以這樣做。')
  expect(failureText('stale', 'en')).toBe('This changed in another place. Please look again.')
  expect(failureText('stale', 'zh-TW')).toBe('這裡剛剛在別處改過了，請重新看一次。')
  expect(failureText('limit', 'en')).toBe('That is over the allowed limit.')
  expect(failureText('limit', 'zh-TW')).toBe('超過可以設定的範圍了。')
  expect(failureText('invalid', 'en')).toBe('That value is not allowed.')
  expect(failureText('invalid', 'zh-TW')).toBe('這個值不能用。')
  expect(failureText('unreachable', 'en')).toBe('Could not reach the server. Nothing was changed.')
  expect(failureText('unreachable', 'zh-TW')).toBe('連不上伺服器，沒有改到任何東西。')
  for (const lang of LANGS) {
    for (const r of ['not-owner', 'stale', 'limit', 'invalid', 'unreachable'] as const) {
      expect(cellWidth(failureText(r, lang))).toBeLessThanOrEqual(70)
    }
  }
})

test('FLOW_STRINGS：cancelled 與 yes、no 逐字，完成句 70 格內', () => {
  expect(flowStrings('en').cancelled).toBe('Nothing was changed.')
  expect(flowStrings('zh-TW').cancelled).toBe('沒有改任何東西。')
  expect(flowStrings('en').yes).toBe('Yes')
  expect(flowStrings('en').no).toBe('No')
  expect(flowStrings('zh-TW').yes).toBe('確定')
  expect(flowStrings('zh-TW').no).toBe('取消')
  expect(flowStrings('en').done.rename).toBe('Group name updated.')
  expect(flowStrings('zh-TW').done.rename).toBe('群組名稱已更新。')
  expect(flowStrings('en').done['transfer-owner']).toBe('The group was handed over.')
  expect(flowStrings('zh-TW').done['transfer-owner']).toBe('群組已轉讓。')
  expect(FLOW_STRINGS['zh-TW']).toBe(flowStrings('zh-TW'))
  for (const lang of LANGS) {
    for (const t of ALL_TYPES) {
      expect(cellWidth(flowStrings(lang).done[t])).toBeLessThanOrEqual(70)
    }
  }
})

test('runOwnerAction：不用確認的動作直接呼叫處理函式一次、成功回完成句並要重整', async () => {
  const { deps, calls } = fakeDeps({ ok: true })
  const out = await runOwnerAction(deps, VALID_REQ.rename, 'zh-TW')
  expect(calls.confirm).toBe(0)
  expect(calls.run).toBe(1)
  expect(calls.lastReq).toEqual({ type: 'rename', name: '新群組名' })
  expect(out.message).toBe('群組名稱已更新。')
  expect(out.shouldRefresh).toBe(true)
})

test('runOwnerAction：十種動作成功時各回自己的完成句、處理函式只呼叫一次', async () => {
  for (const lang of LANGS) {
    for (const t of ALL_TYPES) {
      const { deps, calls } = fakeDeps({ ok: true })
      const out = await runOwnerAction(deps, VALID_REQ[t], lang)
      expect(out.message).toBe(flowStrings(lang).done[t])
      expect(out.shouldRefresh).toBe(true)
      expect(calls.run).toBe(1)
    }
  }
})

test('runOwnerAction：轉讓按取消就不呼叫處理函式、回 cancelled', async () => {
  const { deps, calls } = fakeDeps({ ok: true }, false)
  const out = await runOwnerAction(deps, VALID_REQ['transfer-owner'], 'en')
  expect(calls.confirm).toBe(1)
  expect(calls.run).toBe(0)
  expect(out.message).toBe('Nothing was changed.')
  expect(out.shouldRefresh).toBe(false)
})

test('runOwnerAction：確認框收到的是固定問句與 yes、no', async () => {
  const { deps, calls } = fakeDeps({ ok: true })
  await runOwnerAction(deps, VALID_REQ['revoke-invites'], 'zh-TW')
  expect(calls.questions).toEqual(['要停用目前所有的邀請嗎？還沒加入的人需要新的邀請。'])
})

test('runOwnerAction：確認框丟例外或回非 true 都算取消', async () => {
  const throwing: OwnerFlowDeps = {
    actions: { run: async () => ({ ok: true }) },
    confirm: async () => {
      throw new Error('boom')
    },
  }
  const out1 = await runOwnerAction(throwing, VALID_REQ['rotate-invite'], 'en')
  expect(out1.message).toBe('Nothing was changed.')
  expect(out1.shouldRefresh).toBe(false)
  const truthy = fakeDeps({ ok: true })
  truthy.deps.confirm = async () => 'yes' as unknown as boolean
  const out2 = await runOwnerAction(truthy.deps, VALID_REQ['rotate-invite'], 'en')
  expect(out2.message).toBe('Nothing was changed.')
  expect(truthy.calls.run).toBe(0)
})

test('runOwnerAction：不合法的 req 不確認、不呼叫處理函式、回 invalid', async () => {
  const bads: unknown[] = [
    null,
    undefined,
    'rename',
    [1, 2],
    {},
    { type: 'nope' },
    { type: 'rename' },
    { type: 'rename', name: '' },
    { type: 'rename', name: '含' + ZW + '字' },
    { type: 'rename', name: '長'.repeat(31) },
    { type: 'set-avatar', avatar: 'dragon' },
    { type: 'set-who-invites', value: 'admins' },
    { type: 'set-approval', value: 'yes' },
    { type: 'set-max-members', value: '5' },
    { type: 'set-max-members', value: 3.5 },
    { type: 'approve', requestId: 'bad id!' },
    { type: 'reject', requestId: '' },
    { type: 'transfer-owner', memberId: 'has space' },
  ]
  for (const bad of bads) {
    const { deps, calls } = fakeDeps({ ok: true })
    const out = await runOwnerAction(deps, bad, 'en')
    expect(calls.confirm).toBe(0)
    expect(calls.run).toBe(0)
    expect(out.message).toBe('That value is not allowed.')
    expect(out.shouldRefresh).toBe(false)
  }
})

test('runOwnerAction：人數上限 1 和 6 回 limit、不呼叫處理函式；2 和 5 可以', async () => {
  for (const n of [1, 6, 0, 100]) {
    const { deps, calls } = fakeDeps({ ok: true })
    const out = await runOwnerAction(deps, { type: 'set-max-members', value: n }, 'zh-TW')
    expect(out.message).toBe('超過可以設定的範圍了。')
    expect(calls.run).toBe(0)
  }
  for (const n of [2, 5]) {
    const { deps, calls } = fakeDeps({ ok: true })
    const out = await runOwnerAction(deps, { type: 'set-max-members', value: n }, 'zh-TW')
    expect(out.message).toBe('人數上限已更新。')
    expect(calls.run).toBe(1)
  }
})

test('runOwnerAction：處理函式丟例外當成 unreachable、不會跟著丟', async () => {
  const deps: OwnerFlowDeps = {
    actions: {
      run: async () => {
        throw new Error('boom')
      },
    },
    confirm: async () => true,
  }
  const out = await runOwnerAction(deps, VALID_REQ.rename, 'zh-TW')
  expect(out.message).toBe('連不上伺服器，沒有改到任何東西。')
  expect(out.shouldRefresh).toBe(false)
})

test('runOwnerAction：處理函式回亂七八糟的東西當成 invalid', async () => {
  for (const junk of [null, 'ok', 42, { ok: 'yes' }, { ok: false }, { ok: false, reason: 'weird' }, { reason: 'stale' }]) {
    const { deps } = fakeDeps(junk)
    const out = await runOwnerAction(deps, VALID_REQ.rename, 'en')
    expect(out.message).toBe('That value is not allowed.')
    expect(out.shouldRefresh).toBe(false)
  }
})

test('runOwnerAction：五種失敗原因回各自固定句，stale 才要重整', async () => {
  const reasons = ['not-owner', 'stale', 'limit', 'invalid', 'unreachable'] as const
  for (const lang of LANGS) {
    for (const reason of reasons) {
      const { deps, calls } = fakeDeps({ ok: false, reason })
      const out = await runOwnerAction(deps, VALID_REQ.rename, lang)
      expect(out.message).toBe(failureText(reason, lang))
      expect(out.shouldRefresh).toBe(reason === 'stale')
      expect(calls.run).toBe(1)
    }
  }
})

test('runOwnerAction：失敗提示句不含處理函式多回的任何文字', async () => {
  const { deps } = fakeDeps({ ok: false, reason: 'invalid', message: 'HOSTILE' })
  const out = await runOwnerAction(deps, VALID_REQ.rename, 'en')
  expect(out.message).toBe('That value is not allowed.')
  expect(out.message).not.toContain('HOSTILE')
})

test('runOwnerAction：reject 要先確認、approve 不用確認', async () => {
  const a = fakeDeps({ ok: true })
  await runOwnerAction(a.deps, VALID_REQ.approve, 'en')
  expect(a.calls.confirm).toBe(0)
  expect(a.calls.run).toBe(1)
  const b = fakeDeps({ ok: true })
  await runOwnerAction(b.deps, VALID_REQ.reject, 'en')
  expect(b.calls.confirm).toBe(1)
  expect(b.calls.questions).toEqual(['Decline this request?'])
  expect(b.calls.run).toBe(1)
})

test('所有流程字串不含禁字（中英都掃）', () => {
  const banned = ['手機', '傳檔案', '傳圖片', '表情回應', '提及', '已讀', '正在輸入', '搜尋訊息', '推播', '語音', '摘要', 'Claude', '保證', '絕對', '永遠', '私密', '保密', '刪除', 'encrypt', 'e2e', 'secure', 'private', 'safe', 'never', 'always', 'delete']
  const all: string[] = []
  for (const lang of LANGS) {
    const s = flowStrings(lang)
    all.push(s.cancelled, s.yes, s.no, ...Object.values(s.done))
    for (const t of ALL_TYPES) {
      const q = confirmQuestion(t, lang)
      if (q !== null) all.push(q)
    }
    for (const r of ['not-owner', 'stale', 'limit', 'invalid', 'unreachable'] as const) all.push(failureText(r, lang))
  }
  for (const text of all) {
    for (const b of banned) {
      expect(text.toLowerCase()).not.toContain(b)
    }
  }
})
