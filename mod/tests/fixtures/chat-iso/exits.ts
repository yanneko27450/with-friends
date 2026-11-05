// mod/tests/fixtures/chat-iso/exits.ts
// CHAT4-ISO：外掛能把資料送出去的「出口」總表。只放資料，沒有 import，Node（.node.test.mjs）和外掛引擎測試都能載入。
//
// 規則：引擎的每一個 op／事件，都必須在這裡歸到恰好一類。新增的 op 沒歸類 → 測試紅（chat-iso.test.ts 的「每個出口都有歸類」）。
// 聊天文字（對方的話、寄件人名字、我自己打的字）只允許出現在 'render' 類裡「聊天分頁自己的那棵畫面樹」。

/** 出口的種類，對應 ROUTE 要求證明的六處，再加上引擎還有的幾條路 */
export type Channel =
  | 'session' // 會進到模型的對話脈絡（含提示輸入框、子代理、工具呼叫、技能）
  | 'model-call' // 外掛自己叫模型（classify／complete／fork）：文字會送去模型、花使用者額度
  | 'command-output' // 指令的回傳文字（會進對話）、指令說明
  | 'toast' // 提示、通知、狀態列
  | 'clipboard' // 複製到剪貼簿
  | 'store' // 寫進 $.store、狀態、設定、環境變數、檔案
  | 'log' // 日誌、遙測、console
  | 'status-payload' // 送出本機的內容：中繼請求、子行程、MCP
  | 'pane-meta' // 面板標題等外框（會出現在視窗標題、側邊欄）
  | 'render' // 畫面樹（唯一允許出現聊天文字的地方，且只限聊天分頁）

/**
 * 出口的規則。預設參數和回應都掃：外掛當 hook 回答引擎事件時，它的回傳值也會離開外掛（進模型、進畫面）。
 * externalResult：這個 op 的回應是外面給的（中繼回應、子行程輸出、模型答案、使用者答案），不是外掛產生的，不掃回應。
 * resultOnly：引擎自己帶進來的事件（classic.*）：參數是引擎給的不掃，外掛回答的內容才掃。
 */
export type ExitRule = Readonly<{ channel: Channel; note: string; externalResult?: boolean; resultOnly?: boolean }>

/** 外掛主動呼叫、會把東西送到外面的 op。聊天文字一律不准出現在這些的任何參數裡（render 類例外，見檔頭） */
export const EXIT_OPS: Readonly<Record<string, ExitRule>> = {
  // 進模型對話脈絡
  'session.send': { channel: 'session', note: '對另一個對話送訊息' },
  'session.append': { channel: 'session', note: '在對話裡加一則訊息' },
  'session.attach': { channel: 'session', note: '附加內容到對話' },
  'session.receive': { channel: 'session', note: '收一則進對話的訊息' },
  'session.compact': { channel: 'session', note: '壓縮對話時帶的指示' },
  'prompt.fill': { channel: 'session', note: '填提示輸入框' },
  'prompt.edit': { channel: 'session', note: '改提示輸入框' },
  'prompt.compose': { channel: 'session', note: '組合提示' },
  'prompt.context': { channel: 'session', note: '提示的附加脈絡' },
  'prompt.section': { channel: 'session', note: '提示的區段' },
  'prompt.mention': { channel: 'session', note: '提示的提及' },
  'prompt.attachment': { channel: 'session', note: '提示的附件' },
  'prompt.suggest': { channel: 'session', note: '提示建議' },
  'prompt.autocomplete': { channel: 'session', note: '提示自動完成' },
  'prompt.submit': { channel: 'session', note: '送出提示' },
  'agent.spawn': { channel: 'session', note: '開子代理，提示就是模型輸入' },
  'agent.offer': { channel: 'session', note: '提供子代理' },
  'agent.register': { channel: 'session', note: '註冊子代理（說明會進模型）' },
  'skill.prompt': { channel: 'session', note: '技能提示' },
  'attribution.text': { channel: 'session', note: 'commit／PR 署名文字' },
  'tool.register': { channel: 'session', note: '註冊工具（說明與回傳都進模型）' },
  'tool.call': { channel: 'session', note: '外掛自己叫工具；AskUserQuestion 的題目和答案都在對話記錄裡', externalResult: true },
  'tool.check': { channel: 'session', note: '工具檢查' },
  'tool.describe': { channel: 'session', note: '工具說明' },
  'audio.speak': { channel: 'session', note: '念出文字（不是模型，但離開畫面；歸最嚴的一類）' },
  'audio.play': { channel: 'session', note: '播放聲音' },
  // 外掛自己叫模型
  'model.classify': { channel: 'model-call', note: '拿文字去分類，文字送到模型', externalResult: true },
  'model.complete': { channel: 'model-call', note: '拿文字去補全', externalResult: true },
  'model.fork': { channel: 'model-call', note: '分岔出模型對話', externalResult: true },
  // 指令輸出
  'command.register': { channel: 'command-output', note: '指令名稱、說明、參數提示' },
  'command.run': { channel: 'command-output', note: '指令回傳的 text（會進對話）' },
  'command.describe': { channel: 'command-output', note: '指令說明' },
  'config.describe': { channel: 'command-output', note: '設定說明' },
  // 提示、通知
  'ui.toast': { channel: 'toast', note: '一閃而過的提示' },
  'ui.notify': { channel: 'toast', note: '桌面通知' },
  'ui.notice': { channel: 'toast', note: '貼在工具列上的註記（進對話記錄）' },
  'ui.status': { channel: 'toast', note: '狀態列文字' },
  'ui.message': { channel: 'toast', note: '在對話裡畫一則訊息' },
  // 剪貼簿
  'ui.copy': { channel: 'clipboard', note: '0.6.0 不做「複製訊息」；要做另開例外並寫進設計短文' },
  // 寫入保存
  'store.set': { channel: 'store', note: '$.store：同一人所有對話共用、寫進磁碟' },
  'store.delete': { channel: 'store', note: '刪除（鍵名也不准是聊天文字）' },
  'state.set': { channel: 'store', note: '狀態（atom 的底層寫入由 update 走這裡，見設計短文 §3）' },
  'config.set': { channel: 'store', note: '設定' },
  'env.set': { channel: 'store', note: '環境變數' },
  'fs.write': { channel: 'store', note: '寫檔' },
  // 日誌
  'ui.log': { channel: 'log', note: '日誌（除錯日誌也記）' },
  'ui.fault': { channel: 'log', note: '畫面出錯的原因' },
  'telemetry.log': { channel: 'log', note: '遙測' },
  'telemetry.mark': { channel: 'log', note: '遙測標記' },
  // 送出本機
  'http.fetch': { channel: 'status-payload', note: '網址、標頭、本文：中繼請求就是 status payload', externalResult: true },
  'process.run': { channel: 'status-payload', note: '子行程參數、環境、標準輸入', externalResult: true },
  'process.spawn': { channel: 'status-payload', note: '子行程參數、環境、標準輸入', externalResult: true },
  'mcp.call': { channel: 'status-payload', note: '呼叫 MCP 伺服器', externalResult: true },
  'mcp.connect': { channel: 'status-payload', note: '連 MCP 伺服器', externalResult: true },
  // 檔案系統的「讀」：路徑本身就能外送（Windows 的 \\主機\共用\<文字> 會觸發網路請求），所以參數要掃
  'fs.read': { channel: 'status-payload', note: '路徑可以是網路位置', externalResult: true },
  'fs.exists': { channel: 'status-payload', note: '路徑可以是網路位置', externalResult: true },
  'fs.list': { channel: 'status-payload', note: '路徑可以是網路位置', externalResult: true },
  'fs.stat': { channel: 'status-payload', note: '路徑可以是網路位置', externalResult: true },
  'fs.ancestors': { channel: 'status-payload', note: '路徑可以是網路位置', externalResult: true },
  // 面板外框
  'ui.open': { channel: 'pane-meta', note: '面板 id、標題、props' },
  'ui.close': { channel: 'pane-meta', note: '關面板' },
  'ui.invalidate': { channel: 'pane-meta', note: '要求重畫（不帶內容；有帶就是違規）' },
  // 畫面
  'ui.render': { channel: 'render', note: '畫面樹；只有聊天分頁自己的樹可以含聊天文字' },
  'ui.blit': { channel: 'render', note: '圖片格子；聊天分頁不用' },
}

/** 純讀取、事件輸入、時間：不是出口。聊天模組可以呼叫，但回傳值不能再被當成出口參數（那由出口掃描抓） */
export const NON_EXIT_OPS: Readonly<Record<string, string>> = {
  'agent.list': '讀', 'clock.after': '計時', 'clock.every': '計時', 'clock.now': '讀', 'clock.sleep': '計時',
  'command.list': '讀', 'config.list': '讀', 'env.get': '讀', 'prompt.read': '讀', 'session.authorize': '讀', 'session.cwd': '讀', 'session.id': '讀',
  'session.messages': '讀（讀對話；聊天文字出現在這裡＝已經外洩，由 session 類出口抓）', 'session.model': '讀',
  'session.repo': '讀', 'session.root': '讀', 'session.surface': '讀', 'session.surfaces': '讀', 'session.turns': '讀',
  'session.usage': '讀', 'session.version': '讀', 'settings.read': '讀', 'state.get': '讀', 'store.get': '讀',
  'store.keys': '讀', 'tool.list': '讀', 'turn.abort': '中止回合', 'ui.panes': '讀', 'ui.selection': '讀',
  'engine.create': '引擎事件', 'plugin.register': '引擎事件', 'session.start': '引擎事件', 'session.end': '引擎事件',
  'session.detach': '引擎事件', 'session.measure': '引擎事件', 'turn.start': '引擎事件', 'turn.complete': '引擎事件',
  'turn.step': '引擎事件', 'ui.focus': '使用者輸入', 'ui.input': '使用者輸入', 'ui.press': '使用者輸入',
  'ui.resolve': '讀（取得元件表）', 'ui.scroll': '使用者輸入', 'ui.select': '使用者輸入',
}

/** 每個 op 的分類結果；不認得的回 undefined（測試用來抓「新增的出口沒歸類」） */
/**
 * classic.*（舊式 hook 事件：UserPromptSubmit、SessionStart、PreToolUse、PostToolUse…）：引擎帶進來的參數不掃，
 * 但外掛回答的內容（additionalContext、initialUserMessage、permissionDecisionReason、updatedToolOutput…）會進模型，所以掃回應。
 */
const CLASSIC_RULE: ExitRule = { channel: 'session', note: '舊式 hook 事件；外掛的回答會進模型', resultOnly: true }

export function ruleOf(op: string): ExitRule | undefined {
  if (Object.hasOwn(EXIT_OPS, op)) return EXIT_OPS[op]
  if (op.startsWith('classic.')) return CLASSIC_RULE
  return undefined
}

export function classifyOp(op: string): 'exit' | 'non-exit' | undefined {
  if (ruleOf(op)) return 'exit'
  if (Object.hasOwn(NON_EXIT_OPS, op)) return 'non-exit'
  return undefined
}

export function channelOf(op: string): Channel | undefined {
  return ruleOf(op)?.channel
}


