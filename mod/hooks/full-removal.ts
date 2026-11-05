import type { Lang } from './taxonomy'

export type RemovalStepId = 'leave-group' | 'clear-local' | 'uninstall-plugin' | 'remove-marketplace'
export type RemovalStep = Readonly<{ id: RemovalStepId; mode: 'auto' | 'manual' }>

/** 兩條固定指令（照抄；與 /guide 的「完整移除」逐字相同）。不接受任何其他字串 */
export const REMOVAL_COMMANDS: Readonly<Record<'uninstall-plugin' | 'remove-marketplace', string>> = {
  'uninstall-plugin': 'claude plugin uninstall with-friends@with-friends',
  'remove-marketplace': 'claude plugin marketplace remove with-friends',
}

function step(id: RemovalStepId, mode: 'auto' | 'manual'): RemovalStep {
  return Object.freeze({ id, mode })
}

export function planRemoval(isInGroup: unknown, canRunCommands: unknown): readonly RemovalStep[] {
  const cmdMode: 'auto' | 'manual' = canRunCommands === true ? 'auto' : 'manual'
  const steps: RemovalStep[] = []
  if (isInGroup === true) steps.push(step('leave-group', 'auto'))
  steps.push(step('clear-local', 'auto'))
  steps.push(step('uninstall-plugin', cmdMode))
  steps.push(step('remove-marketplace', cmdMode))
  return Object.freeze(steps)
}

export type RemovalStrings = Readonly<{
  askHeader: string
  askInGroup: string
  askNotInGroup: string
  yes: string
  no: string
  leaveFailedQuestion: string
  optRetry: string
  optLocalOnly: string
  optStop: string
  steps: Readonly<Record<RemovalStepId, string>>
  leftLine: string
  localOnlyLine: string
  keptOtherLine: string
  clearedLine: string
  cancelled: string
  stoppedInGroup: string
  clearFailed: string
  manualIntro: string
  restart: string
  copyButton: string
  copyButtonName: string
  copied: string
  copyFailed: string
}>

export const REMOVAL_STRINGS: Readonly<Record<Lang, RemovalStrings>> = {
  en: {
    askHeader: 'Remove plugin',
    askInGroup: 'Remove Friends with Claude completely? This leaves your group, clears what this plugin saved on this computer, then removes the plugin.',
    askNotInGroup: 'Remove Friends with Claude completely? This clears what this plugin saved on this computer, then removes the plugin.',
    yes: 'Remove everything',
    no: 'Cancel',
    leaveFailedQuestion: 'Could not leave the group. What do you want to do?',
    optRetry: 'Try again',
    optLocalOnly: 'Remove from this computer only',
    optStop: 'Stop',
    steps: {
      'leave-group': 'Leaving the group…',
      'clear-local': 'Clearing saved data on this computer…',
      'uninstall-plugin': 'Removing the plugin…',
      'remove-marketplace': 'Removing the install source…',
    },
    leftLine: 'You left the group.',
    localOnlyLine: 'The server could not be reached, so you were removed from this computer only. Your name stays on the server.',
    keptOtherLine: 'Another group was already saved on this computer, so that one was kept.',
    clearedLine: 'Saved data on this computer was cleared.',
    cancelled: 'Nothing was removed.',
    stoppedInGroup: 'Stopped. You are still in the group, and nothing on this computer was changed.',
    clearFailed: 'Could not clear the saved data, so the removal stopped here.',
    manualIntro: 'Run these commands to finish removing it:',
    restart: 'Restart Claude Code to finish.',
    copyButton: 'Copy commands',
    copyButtonName: 'Copy the two removal commands',
    copied: 'Copied.',
    copyFailed: 'Could not copy. Try again.',
  },
  'zh-TW': {
    askHeader: '完整移除',
    askInGroup: '要完整移除 Friends with Claude 嗎？會先離開群組、清掉這個外掛存在這台電腦上的資料，再移除外掛。',
    askNotInGroup: '要完整移除 Friends with Claude 嗎？會清掉這個外掛存在這台電腦上的資料，再移除外掛。',
    yes: '全部移除',
    no: '取消',
    leaveFailedQuestion: '沒有離開成功。你想怎麼做？',
    optRetry: '再試一次',
    optLocalOnly: '只從這台電腦移除',
    optStop: '先停止',
    steps: {
      'leave-group': '正在離開群組…',
      'clear-local': '正在清掉這台電腦上存的資料…',
      'uninstall-plugin': '正在移除外掛…',
      'remove-marketplace': '正在移除安裝來源…',
    },
    leftLine: '已離開群組。',
    localOnlyLine: '連不上伺服器，所以只從這台電腦移除。你的名字還留在伺服器上。',
    keptOtherLine: '這台電腦已經換成別的群組，所以保留了那一個。',
    clearedLine: '這台電腦上存的資料已清掉。',
    cancelled: '什麼都沒移除。',
    stoppedInGroup: '已停止。你還在群組裡，這台電腦上的東西沒有動。',
    clearFailed: '資料沒清成功，所以移除停在這裡。',
    manualIntro: '請再跑下面的指令，完成移除：',
    restart: '請重新開啟 Claude Code 完成移除。',
    copyButton: '複製指令',
    copyButtonName: '複製這兩條移除指令',
    copied: '已複製。',
    copyFailed: '沒複製成功，再按一次。',
  },
}

export function removalStrings(lang: Lang): RemovalStrings {
  return REMOVAL_STRINGS[lang] ?? REMOVAL_STRINGS.en
}

const KNOWN_COMMANDS: readonly string[] = [REMOVAL_COMMANDS['uninstall-plugin'], REMOVAL_COMMANDS['remove-marketplace']]

/** 給「複製」鈕用：把指令用換行接起來，結尾不加換行；空陣列回 '' */
export function commandsText(commands: readonly string[]): string {
  return commands.filter((c) => KNOWN_COMMANDS.includes(c)).join('\n')
}
