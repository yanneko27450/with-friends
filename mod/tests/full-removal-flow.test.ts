import { expect, test } from 'claude-code/testing'
import { runRemoval } from '../hooks/full-removal-flow'
import type { LeaveOutcome, RemovalDeps } from '../hooks/full-removal-flow'
import { removalStrings, REMOVAL_COMMANDS } from '../hooks/full-removal'
import type { Lang } from '../hooks/taxonomy'

type Fake = {
  leave?: unknown[], clear?: unknown, run?: unknown, confirm?: unknown
  choose?: unknown[], warning?: unknown, progressThrow?: boolean
}

function makeDeps(f: Fake) {
  const calls: string[] = []
  const questions: string[] = []
  const chooseSeen: string[][] = []
  let li = 0
  let ci = 0
  const pick = (seq: unknown[] | undefined, i: number, dflt: unknown): unknown => (seq !== undefined && i < seq.length ? seq[i] : dflt)
  const deps: RemovalDeps = {
    leaveWarning: (f.warning === undefined ? 'WARN' : f.warning) as string,
    confirm: async (q: string) => {
      questions.push(q)
      if (f.confirm === 'throw') throw new Error('x')
      return (f.confirm === undefined ? true : f.confirm) as boolean
    },
    choose: async (_q: string, options: readonly string[]) => {
      chooseSeen.push([...options])
      const v = pick(f.choose, ci++, -1)
      if (v === 'throw') throw new Error('x')
      return v as number
    },
    progress: () => { if (f.progressThrow === true) throw new Error('x') },
    actions: {
      leaveGroup: async (isForce: boolean) => {
        calls.push(isForce ? 'leave:true' : 'leave:false')
        const v = pick(f.leave, li++, 'left')
        if (v === 'throw') throw new Error('x')
        return v as LeaveOutcome
      },
      clearLocalData: async () => {
        calls.push('clear')
        if (f.clear === 'throw') throw new Error('x')
        return (f.clear === undefined ? true : f.clear) as boolean
      },
      runCommand: async (id: 'uninstall-plugin' | 'remove-marketplace') => {
        calls.push('run:' + id)
        if (f.run === 'throw') throw new Error('x')
        return (f.run === undefined ? true : f.run) as boolean
      },
    },
  }
  return { deps, calls, questions, chooseSeen }
}
const acts = (calls: string[]): string[] => calls.filter((c) => c.startsWith('leave') || c === 'clear' || c.startsWith('run:'))
const zh = removalStrings('zh-TW')
const en = removalStrings('en')
const U = REMOVAL_COMMANDS['uninstall-plugin']
const M = REMOVAL_COMMANDS['remove-marketplace']

test('沒加入群組：不呼叫 leaveGroup，完成且最後是 restart', async () => {
  const { deps, calls } = makeDeps({})
  const r = await runRemoval(deps, false, true, 'zh-TW')
  expect(r.status).toBe('completed')
  expect(acts(calls)).toEqual(['clear', 'run:uninstall-plugin', 'run:remove-marketplace'])
  expect(r.lines).toEqual([zh.clearedLine, zh.restart])
  expect(r.commands).toEqual([])
})
test('加入後正常：呼叫順序固定、問句是警告句加 R1、英文結果句', async () => {
  const { deps, calls, questions } = makeDeps({})
  const r = await runRemoval(deps, true, true, 'zh-TW')
  expect(acts(calls)).toEqual(['leave:false', 'clear', 'run:uninstall-plugin', 'run:remove-marketplace'])
  expect(r.lines).toEqual([zh.leftLine, zh.clearedLine, zh.restart])
  expect(questions[0]).toBe('WARN ' + zh.askInGroup)
  const b = makeDeps({})
  const rb = await runRemoval(b.deps, true, true, 'en')
  expect(rb.lines).toEqual([en.leftLine, en.clearedLine, en.restart])
  const c = makeDeps({})
  expect((await runRemoval(c.deps, false, true, 'fr' as Lang)).status).toBe('completed')
})
test('取消或 confirm 丟例外：處理函式 0 次', async () => {
  for (const f of [{ confirm: false }, { confirm: 'throw' }]) {
    const { deps, calls } = makeDeps(f)
    const r = await runRemoval(deps, true, true, 'zh-TW')
    expect(r.status).toBe('cancelled')
    expect(r.lines).toEqual([zh.cancelled])
    expect(acts(calls)).toEqual([])
  }
})
test('離開失敗選再試後成功；選只從這台移除給 R3', async () => {
  const a = makeDeps({ leave: ['failed', 'left'], choose: [0] })
  const ra = await runRemoval(a.deps, true, true, 'zh-TW')
  expect(ra.status).toBe('completed')
  expect(acts(a.calls).filter((c) => c === 'leave:false')).toHaveLength(2)
  const b = makeDeps({ leave: ['failed', 'localOnly'], choose: [1] })
  const rb = await runRemoval(b.deps, true, true, 'zh-TW')
  expect(acts(b.calls)).toEqual(['leave:false', 'leave:true', 'clear', 'run:uninstall-plugin', 'run:remove-marketplace'])
  expect(rb.lines[0]).toBe(zh.localOnlyLine)
})
test('離開結果 keptOther 與 localOnlyKeptOther 的結果句組合', async () => {
  const a = makeDeps({ leave: ['keptOther'] })
  expect((await runRemoval(a.deps, true, true, 'zh-TW')).lines.slice(0, 2)).toEqual([zh.leftLine, zh.keptOtherLine])
  const b = makeDeps({ leave: ['localOnlyKeptOther'] })
  expect((await runRemoval(b.deps, true, true, 'zh-TW')).lines.slice(0, 2)).toEqual([zh.localOnlyLine, zh.keptOtherLine])
})
test('離開失敗選停止或不合法索引：之後處理函式 0 次', async () => {
  for (const idx of [2, -1, 9]) {
    const { deps, calls } = makeDeps({ leave: ['failed'], choose: [idx] })
    const r = await runRemoval(deps, true, true, 'zh-TW')
    expect(r.status).toBe('stopped')
    expect(r.lines).toEqual([zh.stoppedInGroup])
    expect(acts(calls)).toEqual(['leave:false'])
  }
})
test('連續失敗 3 次後選單只剩兩項，leaveGroup(false) 共 3 次、(true) 共 1 次', async () => {
  const { deps, calls, chooseSeen } = makeDeps({ leave: ['failed', 'failed', 'failed', 'failed'], choose: [0, 0, 0] })
  const r = await runRemoval(deps, true, true, 'zh-TW')
  expect(r.status).toBe('stopped')
  expect(chooseSeen[0]).toHaveLength(3)
  expect(chooseSeen[2]).toHaveLength(2)
  expect(acts(calls)).toEqual(['leave:false', 'leave:false', 'leave:false', 'leave:true'])
})
test('只從這台移除也失敗就停止；choose 丟例外視同關掉', async () => {
  const a = makeDeps({ leave: ['failed', 'failed'], choose: [1] })
  expect((await runRemoval(a.deps, true, true, 'zh-TW')).status).toBe('stopped')
  expect(acts(a.calls)).toEqual(['leave:false', 'leave:true'])
  const b = makeDeps({ leave: ['failed'], choose: ['throw'] })
  expect((await runRemoval(b.deps, true, true, 'zh-TW')).status).toBe('stopped')
  expect(acts(b.calls)).toEqual(['leave:false'])
})
test('不能跑指令或 runCommand 失敗：指令進 commands、最後是 R4', async () => {
  const a = makeDeps({})
  const ra = await runRemoval(a.deps, true, false, 'zh-TW')
  expect(ra.commands).toEqual([U, M])
  expect(ra.lines[ra.lines.length - 1]).toBe(zh.manualIntro)
  expect(acts(a.calls).filter((c) => c.startsWith('run:'))).toEqual([])
  for (const f of [{ run: false }, { run: 'throw' }]) {
    const { deps } = makeDeps(f)
    const r = await runRemoval(deps, false, true, 'zh-TW')
    expect(r.status).toBe('completed')
    expect(r.commands).toEqual([U, M])
    expect(r.lines[r.lines.length - 1]).toBe(zh.manualIntro)
  }
})
test('clearLocalData 回 false 或丟例外：停止且不跑指令', async () => {
  for (const f of [{ clear: false }, { clear: 'throw' }]) {
    const { deps, calls } = makeDeps(f)
    const r = await runRemoval(deps, true, true, 'zh-TW')
    expect(r.status).toBe('stopped')
    expect(r.lines).toEqual([zh.leftLine, zh.clearFailed])
    expect(acts(calls).filter((c) => c.startsWith('run:'))).toEqual([])
  }
})
test('progress 丟例外、leaveWarning 空字串或非字串都不影響流程', async () => {
  const a = makeDeps({ progressThrow: true, warning: '' })
  expect((await runRemoval(a.deps, true, true, 'zh-TW')).status).toBe('completed')
  expect(a.questions[0]).toBe(zh.askInGroup)
  const b = makeDeps({ warning: 42 })
  expect((await runRemoval(b.deps, true, true, 'zh-TW')).status).toBe('completed')
  expect(b.questions[0]).toBe(zh.askInGroup)
  const c = makeDeps({ warning: '' })
  await runRemoval(c.deps, false, true, 'zh-TW')
  expect(c.questions[0]).toBe(zh.askNotInGroup)
})
test('處理函式回的文字不進結果句；怪的 leaveGroup 回傳視同 failed', async () => {
  const a = makeDeps({ leave: ['SECRET-TEXT'], choose: [2] })
  const ra = await runRemoval(a.deps, true, true, 'zh-TW')
  expect(ra.status).toBe('stopped')
  expect(ra.lines.join('\n')).not.toContain('SECRET-TEXT')
  const b = makeDeps({ clear: 'SECRET-TEXT' })
  const rb = await runRemoval(b.deps, false, true, 'en')
  expect(rb.status).toBe('stopped')
  expect(rb.lines.join('\n')).not.toContain('SECRET-TEXT')
})

test('leaveGroup 丟例外視同失敗：問使用者、不跟著丟；選停止後之後的處理函式 0 次（實作部補）', async () => {
  const { deps, calls, chooseSeen } = makeDeps({ leave: ['throw'], choose: [2] })
  const r = await runRemoval(deps, true, true, 'en')
  expect(r.status).toBe('stopped')
  expect(r.lines).toEqual([en.stoppedInGroup])
  expect(acts(calls)).toEqual(['leave:false'])
  expect(chooseSeen).toHaveLength(1)
})

