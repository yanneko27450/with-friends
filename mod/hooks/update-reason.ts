import type { Lang } from './taxonomy'

export const UPDATE_REASONS = [
  // claude 2.1.309 的 failureCode（實作部從執行檔字串整理，非官方文件；清單外的碼一律變 'unknown_code'）
  'not_found', 'not_installed', 'not_installed_at_scope', 'not_configured', 'installed_from_other_marketplace',
  'ambiguous_marketplace', 'install_records_unreadable', 'settings_write_failed', 'plugin_policy_blocked',
  'marketplace_policy_blocked', 'required_by_organization', 'source_missing', 'plugin_folder_held', 'partial_failure',
  'managed_settings_override', 'dependency_resolution_failed', 'dependency_policy_blocked', 'dependency_version_conflict',
  'dependency_disabled', 'plugin_directory_unavailable', 'directory_unavailable', 'invalid_source', 'invalid_plugin_id',
  'npm_marketplace_disabled', 'local_source_no_location',
  // 外掛自己加的四個
  'unknown_code',  // JSON 有 failureCode 但不在上面清單
  'no_code',       // 有 JSON、沒有 failureCode
  'no_json',       // 結束碼不是 0，但 stdout 找不到任何一行 JSON 物件
  'run_error',     // $.process.run 自己丟例外（執行檔起不來、逾時）
] as const
export type UpdateReason = (typeof UPDATE_REASONS)[number]
export type UpdateStep = 'market' | 'plugin'
/** step＝哪一步；exitCode＝指令結束碼（讀不到、或不在 1～255 就 null）；reason＝白名單內的碼，或外掛自己加的四個。
 *  otherCode（規劃部補充）：白名單外的原碼，只在 reason 是 'unknown_code' 且原碼形狀合格（小寫英文字母與底線、2～31 字元）時才有；
 *  面板與診斷顯示 other:原碼，/friends update 回對話的文字一律只寫 unknown_code */
export type UpdateFailure = { step: UpdateStep; exitCode: number | null; reason: UpdateReason; otherCode?: string }
export type InstallScope = 'user' | 'project' | 'local' | 'managed'

/** 白名單（UPDATE_REASONS 前 25 個）以外的原碼要先過的形狀：只限小寫英文字母與底線、長度 2～31 */
const CODE_SHAPE = /^[a-z_]{2,31}$/
/** 外掛自己加的四個名字：外面傳進來同名的字串一律當 unknown_code，不准偽裝 */
const SELF_REASONS: readonly string[] = ['unknown_code', 'no_code', 'no_json', 'run_error']
const KNOWN_SCOPES: readonly string[] = ['user', 'project', 'local', 'managed']

function asRecord(x: unknown): Record<string, unknown> | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null
  return x as Record<string, unknown>
}

/** run＝$.process.run 的結果（未知型別，一律當不可信）。結束碼 0 → null（成功）；其餘回 UpdateFailure，絕不把 stdout／stderr 原文放進去 */
export function failureFromRun(step: UpdateStep, run: unknown): UpdateFailure | null {
  const rec = asRecord(run)
  if (rec === null) return { step, exitCode: null, reason: 'run_error' }
  const rawExit = rec.exitCode
  if (typeof rawExit !== 'number' || !Number.isInteger(rawExit)) return { step, exitCode: null, reason: 'run_error' }
  if (rawExit === 0) return null
  const exitCode = rawExit >= 1 && rawExit <= 255 ? rawExit : null
  const stdout = typeof rec.stdout === 'string' ? rec.stdout : ''
  const lines = stdout.split('\n')
  let found: Record<string, unknown> | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim()
    if (!line.startsWith('{')) continue
    try {
      found = asRecord(JSON.parse(line))
    } catch {
      found = null
    }
    if (found !== null) break
  }
  if (found === null) return { step, exitCode, reason: 'no_json' }
  const code = found.failureCode
  if (typeof code !== 'string') return { step, exitCode, reason: 'no_code' }
  const known = (UPDATE_REASONS as readonly string[]).slice(0, 25)
  if (known.includes(code)) return { step, exitCode, reason: code as UpdateReason }
  if (SELF_REASONS.includes(code)) return { step, exitCode, reason: 'unknown_code' }
  if (CODE_SHAPE.test(code)) return { step, exitCode, reason: 'unknown_code', otherCode: code }
  return { step, exitCode, reason: 'unknown_code' }
}

/** $.process.run 丟例外：{ step, exitCode: null, reason: 'run_error' } */
export function failureFromError(step: UpdateStep): UpdateFailure {
  return { step, exitCode: null, reason: 'run_error' }
}

/** 從 $.store 讀回來的值還原；形狀或值不對（step／reason 不在清單、exitCode 不是 null 或 1～255 的整數、多出來的欄位）回 null */
export function failureOf(x: unknown): UpdateFailure | null {
  const rec = asRecord(x)
  if (rec === null) return null
  for (const key of Object.keys(rec)) {
    if (key !== 'step' && key !== 'exitCode' && key !== 'reason' && key !== 'otherCode') return null
  }
  const step = rec.step
  if (step !== 'market' && step !== 'plugin') return null
  const reason = rec.reason
  if (typeof reason !== 'string' || !(UPDATE_REASONS as readonly string[]).includes(reason)) return null
  const rawExit = rec.exitCode
  if (rawExit !== null && (typeof rawExit !== 'number' || !Number.isInteger(rawExit) || rawExit < 1 || rawExit > 255)) return null
  const out: UpdateFailure = { step, exitCode: rawExit, reason: reason as UpdateReason }
  if ('otherCode' in rec) {
    const other = rec.otherCode
    if (typeof other !== 'string' || !CODE_SHAPE.test(other)) return null
    if ((UPDATE_REASONS as readonly string[]).includes(other)) return null
    if (reason !== 'unknown_code') return null
    out.otherCode = other
  }
  return out
}

/** 'plugin/not_installed_at_scope/1'；exitCode 為 null 寫 '-'；有 otherCode 時原因段寫 other:原碼 */
export function reasonCode(f: UpdateFailure): string {
  const reason = f.otherCode ? 'other:' + f.otherCode : f.reason
  return f.step + '/' + reason + '/' + (f.exitCode === null ? '-' : String(f.exitCode))
}

/** 讀 installed_plugins.json 的文字（未知型別），找 plugins[key] 裡 scope 屬於四個值的項目：有 'user' 就回 'user'，否則回第一個合法的，沒有或讀不懂回 null。只回列舉值 */
export function installedScope(text: unknown, key: string): InstallScope | null {
  if (typeof text !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const root = asRecord(parsed)
  if (root === null) return null
  const plugins = asRecord(root.plugins)
  if (plugins === null) return null
  const list = plugins[key]
  if (!Array.isArray(list)) return null
  let first: InstallScope | null = null
  for (const item of list) {
    const entry = asRecord(item)
    if (entry === null) continue
    const scope = entry.scope
    if (typeof scope !== 'string' || !KNOWN_SCOPES.includes(scope)) continue
    if (scope === 'user') return 'user'
    if (first === null) first = scope as InstallScope
  }
  return first
}

/** 組 claude 的參數（不含執行檔）：market → ['plugin','marketplace','update','with-friends'] ；plugin → ['plugin','update','with-friends@with-friends']；isJson 為真就在最後加 '--json'；只有 plugin 步驟且 scope 不是 null 才加 '--scope', scope（放在 --json 之後） */
export function updateArgs(step: UpdateStep, scope: InstallScope | null, isJson: boolean): string[] {
  const args = step === 'market'
    ? ['plugin', 'marketplace', 'update', 'with-friends']
    : ['plugin', 'update', 'with-friends@with-friends']
  if (isJson) args.push('--json')
  if (step === 'plugin' && scope !== null) args.push('--scope', scope)
  return args
}

/** 舊版 claude 不認得 --json 時，stderr 會有 "unknown option '--json'"：這個函式回 true（run 未知型別，只看 stderr 字串且只回布林） */
export function isJsonUnsupported(run: unknown): boolean {
  const rec = asRecord(run)
  if (rec === null) return false
  return typeof rec.stderr === 'string' && rec.stderr.includes("unknown option '--json'")
}

const CODE_CHARS = 'abcdefghijklmnopqrstuvwxyz_/0123456789:-'

/** 顯示前再檢查一次：代碼只准 [a-z_/0-9:-]（含 other: 的冒號），不合就用 '?' 取代整段 */
function shownCode(code: string): string {
  if (code === '') return '?'
  for (const ch of code) {
    if (!CODE_CHARS.includes(ch)) return '?'
  }
  return code
}

export const REASON_STRINGS: Record<Lang, { line: (code: string) => string }> = {
  en: { line: (code: string) => 'Reason code: ' + shownCode(code) },
  'zh-TW': { line: (code: string) => '原因代碼：' + shownCode(code) },
}
