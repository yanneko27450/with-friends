import type { Lang } from './taxonomy'
import { planRemoval, removalStrings, REMOVAL_COMMANDS } from './full-removal'
import type { RemovalStrings } from './full-removal'

export type LeaveOutcome = 'left' | 'localOnly' | 'keptOther' | 'localOnlyKeptOther' | 'failed'

/** 真正的實作由 Claude 做。本卡只定介面；測試用假的 */
export interface RemovalActions {
  /** isForce＝true：中繼連不上也要從這台電腦移除（等同 /friends leave --force） */
  leaveGroup(isForce: boolean): Promise<LeaveOutcome>
  /** 只清這個外掛自己存的東西；成功 true */
  clearLocalData(): Promise<boolean>
  /** 只能是兩條固定指令之一（用 REMOVAL_COMMANDS 的鍵）；成功 true */
  runCommand(id: 'uninstall-plugin' | 'remove-marketplace'): Promise<boolean>
}

export interface RemovalDeps {
  actions: RemovalActions
  /** 是/否確認框；按「確定」回 true，取消或關掉回 false */
  confirm(question: string, yes: string, no: string): Promise<boolean>
  /** 多選一；回選項的索引（0 起），關掉回 -1 */
  choose(question: string, options: readonly string[]): Promise<number>
  /** 現有的離開警告句，已經是固定句，原樣顯示，這裡不改寫 */
  leaveWarning: string
  /** 每一步開始時給一行進度；可以不給 */
  progress?: (line: string) => void
}

export type RemovalResult = Readonly<{
  status: 'completed' | 'cancelled' | 'stopped'
  /** 結果句（固定句），照順序 */
  lines: readonly string[]
  /** 使用者還需要自己跑的指令（照順序；沒有就是空陣列） */
  commands: readonly string[]
}>

async function tryLeave(deps: RemovalDeps, isForce: boolean): Promise<LeaveOutcome> {
  try {
    const r = await deps.actions.leaveGroup(isForce)
    if (r === 'left' || r === 'localOnly' || r === 'keptOther' || r === 'localOnlyKeptOther') return r
    return 'failed'
  } catch {
    return 'failed'
  }
}

async function tryChoose(deps: RemovalDeps, s: RemovalStrings, withRetry: boolean): Promise<number> {
  const options = withRetry ? [s.optRetry, s.optLocalOnly, s.optStop] : [s.optLocalOnly, s.optStop]
  try {
    return await deps.choose(s.leaveFailedQuestion, options)
  } catch {
    return -1
  }
}

async function tryBool(fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await fn()) === true
  } catch {
    return false
  }
}

/** 離開這一步的完整處理；回 null 表示停下來，後面的步驟都不做 */
async function leaveStep(deps: RemovalDeps, s: RemovalStrings): Promise<LeaveOutcome | null> {
  let outcome = await tryLeave(deps, false)
  let attempts = 1
  while (outcome === 'failed') {
    const last = attempts >= 3
    const idx = await tryChoose(deps, s, !last)
    if (idx === (last ? 0 : 1)) {
      const forced = await tryLeave(deps, true)
      return forced === 'failed' ? null : forced
    }
    if (!last && idx === 0) {
      outcome = await tryLeave(deps, false)
      attempts += 1
    } else {
      return null
    }
  }
  return outcome
}

function leaveLines(outcome: LeaveOutcome, s: RemovalStrings): string[] {
  if (outcome === 'left') return [s.leftLine]
  if (outcome === 'localOnly') return [s.localOnlyLine]
  if (outcome === 'keptOther') return [s.leftLine, s.keptOtherLine]
  return [s.localOnlyLine, s.keptOtherLine]
}

export async function runRemoval(deps: RemovalDeps, isInGroup: unknown, canRunCommands: unknown, lang: Lang): Promise<RemovalResult> {
  const s = removalStrings(lang)
  const plan = planRemoval(isInGroup, canRunCommands)
  const warning = typeof deps.leaveWarning === 'string' ? deps.leaveWarning : ''
  const question = isInGroup === true ? (warning === '' ? s.askInGroup : warning + ' ' + s.askInGroup) : s.askNotInGroup
  const ok = await tryBool(() => deps.confirm(question, s.yes, s.no))
  if (!ok) return { status: 'cancelled', lines: [s.cancelled], commands: [] }
  const lines: string[] = []
  const commands: string[] = []
  for (const planned of plan) {
    try { deps.progress?.(s.steps[planned.id]) } catch { /* 進度顯示出錯不影響流程 */ }
    if (planned.id === 'leave-group') {
      const outcome = await leaveStep(deps, s)
      if (outcome === null) return { status: 'stopped', lines: [s.stoppedInGroup], commands: [] }
      lines.push(...leaveLines(outcome, s))
    } else if (planned.id === 'clear-local') {
      const cleared = await tryBool(() => deps.actions.clearLocalData())
      if (!cleared) return { status: 'stopped', lines: [...lines, s.clearFailed], commands: [] }
      lines.push(s.clearedLine)
    } else {
      const cmdId = planned.id
      const done = planned.mode === 'auto' ? await tryBool(() => deps.actions.runCommand(cmdId)) : false
      if (!done) commands.push(REMOVAL_COMMANDS[cmdId])
    }
  }
  lines.push(commands.length > 0 ? s.manualIntro : s.restart)
  return { status: 'completed', lines, commands }
}
