// 版本紀錄（ui-28）：pane 上「版本紀錄」按鈕跳出的小框框內容。寫死在外掛裡，中英各一份，跟著介面語言換；
// 不從網路或中繼抓任何文字。給一般使用者看，不放卡號、不用技術名詞。每一版 3～5 條，新的版本放前面。
// 只顯示版本號小於等於自己版本的條目（register.tsx 的 changelogView）。
import type { Lang } from './taxonomy'

export type ChangelogEntry = {
  version: string
  /** 這一版的日期（YYYY-MM-DD，中英都用這個格式）。0.5.0 先填寫作日，實際部署日在發版那步改成真的 */
  date: string
  /** true＝這一條講的是「這個版本以前」（0.4.0 以前沒有可靠的紀錄，只寫大方向） */
  isUpTo?: boolean
  items: Record<Lang, readonly string[]>
}

export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    version: '0.5.6',
    date: '2026-10-30',
    items: {
      'zh-TW': [
        '只有群主能移除朋友，移除前先確認，舊邀請碼也加不回來。',
        '你能改顯示給朋友看的名字，朋友面板稍後就會顯示新名字。',
        '朋友很少時，面板會多一個「機器人（示範）」假好友，先預覽畫面。',
        '邀請未裝的朋友時，貼給他的文字不帶邀請碼；裝好後再另給。',
      ],
      en: [
        'Only the group owner can remove a friend, and only after confirming; the old invite code stops working.',
        'You can change the name friends see for you; their panels show the new name a little later.',
        'When you have very few friends, the panel shows a fake friend labelled Robot (demo) as a preview.',
        'Invite text for friends who have not installed it yet no longer includes the code; send it later.',
      ],
    },
  },
  {
    version: '0.5.4',
    date: '2026-10-23', // 先填寫作日，實際部署日在發版那步改成真的（CHANGELOG.md 那段的日期要一起改）
    items: {
      'zh-TW': [
        '中繼回應現在會驗證真偽；自架中繼升級後要用金鑰代號和公鑰重新釘選。',
        '中繼回來的好友資料缺少自己或格式不對時，不會採用。',
        '版本紀錄更容易前後切換，矮的終端機也會正確顯示收起幾位好友。',
        '公開中繼接近 1,000 個活躍 membership 時會停止新建和加入；原有群組照常使用，也可改用自架中繼。',
      ],
      en: [
        'Relay replies are now verified; after upgrading a self-hosted relay, pin it again with its key ID and public key.',
        'Friend data missing your own entry or having the wrong shape is ignored.',
        'What\'s new is easier to move through, and short terminals now count hidden friends correctly.',
        'Near 1,000 active memberships, the public relay stops new creates and joins; existing groups keep working, or you can self-host.',
      ],
    },
  },
  {
    version: '0.5.2',
    date: '2026-10-20', // 先填寫作日，實際部署日在發版那步改成真的（CHANGELOG.md 那段的日期要一起改）
    items: {
      'zh-TW': [
        '版本紀錄一次看一個版本，框頂可以挑要看哪一版（手機用「較舊／較新」按鈕）。',
        '已經在群組裡時，要先離開才能建立或加入另一個群組，舊群組不會留下你的名字。',
        '只連 https:// 的中繼，你的群組金鑰不會在網路上明碼傳。',
        '在一個對話離開、換群組或換邀請碼，其他對話 10 秒內就會跟上。',
      ],
      en: [
        'What\'s new shows one version at a time; pick one at the top (on a phone: Older and Newer).',
        'Leave your group before creating or joining another, so your name isn\'t left behind.',
        'Only https:// relays are used, so your group key never crosses the internet unencrypted.',
        'Leaving, switching groups or a new invite in one conversation reaches your others within about 10 seconds.',
      ],
    },
  },
  {
    version: '0.5.0',
    date: '2026-10-17',
    items: {
      'zh-TW': [
        '可以選頭像（共 16 款），好友會看到你的頭像。',
        '版本太舊時會提醒你更新；暫時還沒有新版可更新時，會告訴你新版快來了。',
        '群組只有你一個人時，會教你怎麼邀請朋友；暫停分享時，會教你怎麼恢復。',
        '手機和終端機可以打 /friends status，用一行字看有幾位好友在線、大家在忙什麼，不會列出名字。',
        '新增「版本紀錄」按鈕，就是你現在看的這個。',
      ],
      en: [
        'You can pick an avatar (16 to choose from); your friends see it.',
        'If your version is too old you get a reminder to update, or a note that a new version is coming soon.',
        'When you are the only one in your group, the pane shows how to invite a friend; when sharing is paused, how to resume.',
        'On a phone or in a terminal, type /friends status for a one-line summary of who is online and what they are doing, without names.',
        'New "What\'s new" button: this list.',
      ],
    },
  },
  {
    version: '0.4.0',
    date: '2026-10-12', // 0.4.0 的部署日
    isUpTo: true,
    items: {
      'zh-TW': ['好友列表、建立／加入群組、自動更新等基本功能。'],
      en: ['The basics: the friends list, creating and joining a group, automatic updates.'],
    },
  },
]

/** 一個字在 pane 裡佔幾格：中日韓全形字 2 格，其他 1 格 */
export const cellWidth = (text: string): number => [...text].reduce((w, c) => w + ((c.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1), 0)

/** 框框要畫的一段：標題＋幾條 */
export type ChangelogSection = { heading: string; items: readonly string[] }

/**
 * 一段文字在 width 格寬的地方佔幾行：全形字 2 格；要折行的多留 1 行餘裕（英文是整個字折行，比逐字估的多一行左右），
 * 寧可多留也不要把好友擠出畫面
 */
const wrapRows = (cells: number, width: number): number => Math.max(1, Math.ceil(cells / width)) + (cells > width ? 1 : 0)

/**
 * 框框佔幾行：上下框線 2＋（挑版本那一列折行後的行數）＋每段（標題折行後的行數＋每條折行後的行數）。bodyColumns＝pane 的寬度；
 * 框線＋左右留白占 4 格，條目前面的「· 」占 2 格。標題帶日期變長了（ui-28b），窄的 pane 會折成兩行以上。
 * pickerCells：框頂挑版本那一列（◀ 標題 ▶，ui-29j）的寬度（格數；可以挑的版本有兩個以上才有，沒有就 0）。有這一列時標題在它中間，不另外佔行；照寬度算折行
 */
/**
 * ui-29j：「◀ 標題 ▶」那一列裡，兩顆按鈕和間隔佔的格數（終端機的按鈕畫成「[ ◀ ]」5 格 ×2＋兩個間隔）。
 * 按鈕寬度固定，只有中間的標題會在剩下的寬度裡折行
 */
export const PICKER_CHROME = 2 * (1 + 4) + 2
export function changelogRows(sections: readonly ChangelogSection[], bodyColumns: number, pickerCells = 0): number {
  const inner = Math.max(8, bodyColumns - 4 - 2)
  const headingWidth = Math.max(8, bodyColumns - 4)
  // 挑版本那一列：按鈕固定寬，標題在剩下的寬度裡折（審查：當成一整串字折會在窄 pane 少算）
  let rows = 2 + (pickerCells > 0 ? wrapRows(Math.max(1, pickerCells - PICKER_CHROME), Math.max(1, headingWidth - PICKER_CHROME)) : 0)
  for (const sec of sections) {
    // ui-29j：有挑版本那一列時，標題就在那一列中間（◀ 標題 ▶），不另外佔行
    if (pickerCells === 0) rows += wrapRows(cellWidth(sec.heading), headingWidth)
    for (const item of sec.items) rows += wrapRows(cellWidth(item), inner)
  }
  return rows
}
