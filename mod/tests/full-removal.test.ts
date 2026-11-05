import { expect, test } from 'claude-code/testing'
import { cellWidth } from '../hooks/changelog'
import { commandsText, planRemoval, removalStrings, REMOVAL_COMMANDS, REMOVAL_STRINGS } from '../hooks/full-removal'
import type { RemovalStepId } from '../hooks/full-removal'
import type { Lang } from '../hooks/taxonomy'

const LANGS: Lang[] = ['en', 'zh-TW']
const STEP_IDS: RemovalStepId[] = ['leave-group', 'clear-local', 'uninstall-plugin', 'remove-marketplace']
const R1_EN = 'Remove Friends with Claude completely? This leaves your group, clears what this plugin saved on this computer, then removes the plugin.'
const R1_ZH = '要完整移除 Friends with Claude 嗎？會先離開群組、清掉這個外掛存在這台電腦上的資料，再移除外掛。'
const R1B_EN = 'Remove Friends with Claude completely? This clears what this plugin saved on this computer, then removes the plugin.'
const R1B_ZH = '要完整移除 Friends with Claude 嗎？會清掉這個外掛存在這台電腦上的資料，再移除外掛。'
const R3_EN = 'The server could not be reached, so you were removed from this computer only. Your name stays on the server.'
const R3_ZH = '連不上伺服器，所以只從這台電腦移除。你的名字還留在伺服器上。'
const R4_EN = 'Run these commands to finish removing it:'
const R4_ZH = '請再跑下面的指令，完成移除：'

test('planRemoval 四種組合', () => {
  expect(planRemoval(true, true)).toEqual([
    { id: 'leave-group', mode: 'auto' }, { id: 'clear-local', mode: 'auto' },
    { id: 'uninstall-plugin', mode: 'auto' }, { id: 'remove-marketplace', mode: 'auto' },
  ])
  expect(planRemoval(true, false)).toEqual([
    { id: 'leave-group', mode: 'auto' }, { id: 'clear-local', mode: 'auto' },
    { id: 'uninstall-plugin', mode: 'manual' }, { id: 'remove-marketplace', mode: 'manual' },
  ])
  expect(planRemoval(false, true)).toEqual([
    { id: 'clear-local', mode: 'auto' }, { id: 'uninstall-plugin', mode: 'auto' }, { id: 'remove-marketplace', mode: 'auto' },
  ])
  expect(planRemoval(false, false)).toEqual([
    { id: 'clear-local', mode: 'auto' }, { id: 'uninstall-plugin', mode: 'manual' }, { id: 'remove-marketplace', mode: 'manual' },
  ])
})

test('planRemoval 只認嚴格 true，回傳已凍結', () => {
  expect(planRemoval(1, 'yes')).toEqual(planRemoval(false, false))
  expect(planRemoval('true', null)).toEqual(planRemoval(false, false))
  expect(planRemoval(undefined, undefined)).toEqual(planRemoval(false, false))
  const plan = planRemoval(true, true)
  expect(Object.isFrozen(plan)).toBe(true)
  expect(Object.isFrozen(plan[0])).toBe(true)
})

test('REMOVAL_COMMANDS 兩條逐字', () => {
  expect(REMOVAL_COMMANDS['uninstall-plugin']).toBe('claude plugin uninstall with-friends@with-friends')
  expect(REMOVAL_COMMANDS['remove-marketplace']).toBe('claude plugin marketplace remove with-friends')
  expect(Object.keys(REMOVAL_COMMANDS)).toHaveLength(2)
})

test('固定句 R1、R1b、R3、R4 中英逐字', () => {
  const en = removalStrings('en')
  const zh = removalStrings('zh-TW')
  expect(en.askInGroup).toBe(R1_EN)
  expect(zh.askInGroup).toBe(R1_ZH)
  expect(en.askNotInGroup).toBe(R1B_EN)
  expect(zh.askNotInGroup).toBe(R1B_ZH)
  expect(en.localOnlyLine).toBe(R3_EN)
  expect(zh.localOnlyLine).toBe(R3_ZH)
  expect(en.manualIntro).toBe(R4_EN)
  expect(zh.manualIntro).toBe(R4_ZH)
})

test('其餘指定字串中英逐字', () => {
  const en = removalStrings('en')
  const zh = removalStrings('zh-TW')
  const flat: [string, string, string][] = [
    ['askHeader', 'Remove plugin', '完整移除'],
    ['yes', 'Remove everything', '全部移除'],
    ['no', 'Cancel', '取消'],
    ['leaveFailedQuestion', 'Could not leave the group. What do you want to do?', '沒有離開成功。你想怎麼做？'],
    ['optRetry', 'Try again', '再試一次'],
    ['optLocalOnly', 'Remove from this computer only', '只從這台電腦移除'],
    ['optStop', 'Stop', '先停止'],
    ['leftLine', 'You left the group.', '已離開群組。'],
    ['keptOtherLine', 'Another group was already saved on this computer, so that one was kept.', '這台電腦已經換成別的群組，所以保留了那一個。'],
    ['clearedLine', 'Saved data on this computer was cleared.', '這台電腦上存的資料已清掉。'],
    ['cancelled', 'Nothing was removed.', '什麼都沒移除。'],
    ['stoppedInGroup', 'Stopped. You are still in the group, and nothing on this computer was changed.', '已停止。你還在群組裡，這台電腦上的東西沒有動。'],
    ['clearFailed', 'Could not clear the saved data, so the removal stopped here.', '資料沒清成功，所以移除停在這裡。'],
    ['restart', 'Restart Claude Code to finish.', '請重新開啟 Claude Code 完成移除。'],
    ['copyButton', 'Copy commands', '複製指令'],
    ['copyButtonName', 'Copy the two removal commands', '複製這兩條移除指令'],
    ['copied', 'Copied.', '已複製。'],
    ['copyFailed', 'Could not copy. Try again.', '沒複製成功，再按一次。'],
  ]
  const enRec = en as unknown as Record<string, string>
  const zhRec = zh as unknown as Record<string, string>
  for (const [key, enText, zhText] of flat) {
    expect(enRec[key]).toBe(enText)
    expect(zhRec[key]).toBe(zhText)
  }
  const stepPairs: [RemovalStepId, string, string][] = [
    ['leave-group', 'Leaving the group…', '正在離開群組…'],
    ['clear-local', 'Clearing saved data on this computer…', '正在清掉這台電腦上存的資料…'],
    ['uninstall-plugin', 'Removing the plugin…', '正在移除外掛…'],
    ['remove-marketplace', 'Removing the install source…', '正在移除安裝來源…'],
  ]
  for (const [id, enText, zhText] of stepPairs) {
    expect(en.steps[id]).toBe(enText)
    expect(zh.steps[id]).toBe(zhText)
  }
})

test('兩種語言的鍵集合相同，steps 四步齊全', () => {
  for (const lang of LANGS) {
    expect(Object.keys(REMOVAL_STRINGS[lang]).sort()).toEqual(Object.keys(REMOVAL_STRINGS.en).sort())
    expect(Object.keys(REMOVAL_STRINGS[lang].steps).sort()).toEqual([...STEP_IDS].sort())
  }
  expect(removalStrings('en')).toBe(REMOVAL_STRINGS.en)
  expect(removalStrings('zh-TW')).toBe(REMOVAL_STRINGS['zh-TW'])
})

test('字串格數在上限內', () => {
  for (const lang of LANGS) {
    const s = removalStrings(lang)
    expect(cellWidth(s.leaveFailedQuestion)).toBeLessThanOrEqual(120)
    expect(cellWidth(s.askNotInGroup)).toBeLessThanOrEqual(120)
    expect(cellWidth(s.optRetry)).toBeLessThanOrEqual(18)
    expect(cellWidth(s.optStop)).toBeLessThanOrEqual(18)
    expect(cellWidth(s.yes)).toBeLessThanOrEqual(18)
    for (const id of STEP_IDS) expect(cellWidth(s.steps[id])).toBeLessThanOrEqual(70)
    for (const line of [s.leftLine, s.clearedLine, s.cancelled, s.clearFailed, s.manualIntro, s.restart]) {
      expect(cellWidth(line)).toBeLessThanOrEqual(70)
    }
  }
  const zh = removalStrings('zh-TW')
  expect(cellWidth(zh.askInGroup)).toBeLessThanOrEqual(120)
  expect(cellWidth(zh.optLocalOnly)).toBeLessThanOrEqual(18)
  expect(cellWidth(zh.askHeader)).toBeLessThanOrEqual(12)
  for (const line of [zh.localOnlyLine, zh.keptOtherLine, zh.stoppedInGroup]) {
    expect(cellWidth(line)).toBeLessThanOrEqual(70)
  }
})

test('禁字掃描：所有使用者字串中英全掃', () => {
  const banned = ['encrypt', 'e2e', 'end-to-end', 'secure', 'private', 'safe', 'never', 'always', 'delete', '刪除', '保證', '絕對', '永遠', '私密', '保密', '加密', '已讀', '推播', '語音', '表情回應']
  for (const lang of LANGS) {
    const s = removalStrings(lang)
    const all = [...Object.values(s).filter((v) => typeof v === 'string'), ...STEP_IDS.map((id) => s.steps[id])]
    const blob = all.join('\n').toLowerCase()
    for (const word of banned) expect(blob).not.toContain(word)
  }
})

test('commandsText 只留兩條固定指令、用換行接、結尾不加換行', () => {
  const u = REMOVAL_COMMANDS['uninstall-plugin']
  const m = REMOVAL_COMMANDS['remove-marketplace']
  expect(commandsText([u, m])).toBe(u + '\n' + m)
  expect(commandsText([m])).toBe(m)
  expect(commandsText([])).toBe('')
  expect(commandsText(['claude plugin uninstall other', u, 'rm -rf /'])).toBe(u)
  const frozen = Object.freeze([u, 'nope', m])
  expect(commandsText(frozen)).toBe(u + '\n' + m)
  expect(frozen).toEqual([u, 'nope', m])
})
