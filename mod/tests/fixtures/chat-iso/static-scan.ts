// mod/tests/fixtures/chat-iso/static-scan.ts
// CHAT4-ISO：靜態檢查。處理聊天文字的原始檔，不准出現任何出口呼叫。
// 動態掃描（world.ts）只看得到測試走到的路徑；這一層看原始碼，補上「某條路徑測試沒走到」的洞。
// 兩者互補，不互相取代。沒有 import、只用可擦除的 TS 語法，Node（.node.test.mjs）直接載入。
//
// 三種檔案：
//   'pure'：純函式模組（chat-list.ts、chat-input.ts 這類）。不准碰引擎：不准 import 'claude-code'、不准有 $。
//   'pane'：聊天分頁的畫面檔（CHAT-4 寫）。可以 import atom／read，可以 $.ui.resolve 取元件、read($, atom) 讀記憶體；
//           其餘出口一律不准，也不准寫 atom（update）。本地 import 只准純函式檔（由呼叫端比對清單）。
//   'wiring'：CHAT-4W 的接線檔（chat-register.tsx）。外掛只准有一個 hooks 模組、$ 又不能傳出去，所以所有碰 $ 的聊天程式都得在這一個檔案裡。
//           它能用的出口全部列在 WIRING_ALLOWED（逐條比對）：唯一的 on(...) 是聊天分頁的 ui.render、唯一的 toast 是固定句子 newMessageNotice、
//           $.store 只寫保管庫與租約、$.ui.ask 只問 DM_STRINGS 的固定句子；其餘照 SINKS 全擋。
//   'client'：最先碰到明文的收件／送出模組（CHAT3-CLIENT）。要輪詢中繼（$.http.fetch）、寫聊天 atom（update）、
//           用 $.store.get/set 存「不是文字」的防重播紀錄——只放行這三樣；其餘 NETWORK／PERSIST 子規則照擋
//           （裸 fetch、WebSocket、$.store.delete、$.fs.write、$.state.set、$.env.set、$.config.set…）。
//           client 也跑 $ 別名追蹤（$ 只准出現在 $.http.fetch、$.store.get/set、read($,、update($,、參數宣告）。
//           store 裡有沒有文字由動態掃描管。
// 三種檔都不准登記 hook：on( 一律禁（換行、'*'、變數事件名都算），on 當值傳遞／取別名也禁。
// 呼叫鏈跨行（$.ui⏎.toast）會先接成一條邏輯行再比對，行號記第一行。
//
// 已知限度：這是文字比對，不是型別分析。會先把 ?. 和 ['x'] 換成 .x、拿掉註解（有字串／樣板字面值的處理），
// 但刻意混淆（動態組字串當屬性名、透過別的檔案的 helper 轉手）擋不住——所以 pane／client 檔的本地 import 要受限，$ 不准出現別名。

export type SourceKind = 'pure' | 'pane' | 'client' | 'wiring'

export type Finding = Readonly<{ rule: string; line: number; text: string }>

type Rule = Readonly<{ id: string; re: RegExp; why: string }>

const NETWORK: Rule = { id: 'network', re: /\.\s*http\s*\.\s*fetch\b|(^|[^.\w$])fetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\b|\bEventSource\b|\bnew\s+Image\b|\.\s*src\s*=/g, why: '網路送出' }
const PERSIST: Rule = { id: 'persist', re: /\.\s*(store|state|config|env|fs)\s*\.\s*(set|delete|write)\b/g, why: '寫入保存' }
// client 檔只多放行 $.http.fetch 與 $.store.get/set：其餘 NETWORK／PERSIST 子規則照擋（裸 fetch、WebSocket、$.store.delete、$.fs.write、$.state.set、$.env.set、$.config.set…）
const CLIENT_NETWORK: Rule = { ...NETWORK, re: /(^|[^.\w$])fetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\b|\bEventSource\b|\bnew\s+Image\b|\.\s*src\s*=/g }
const CLIENT_PERSIST: Rule = { ...PERSIST, re: /\.\s*store\s*\.\s*(delete|write)\b|\.\s*(state|config|env|fs)\s*\.\s*(set|delete|write)\b/g }

/** 任何檔案都不准有的出口。re 都是全域旗標，掃描時逐行重設 */
const SINKS: readonly Rule[] = [
  { id: 'ui-toast', re: /\.\s*ui\s*\.\s*(toast|notify|notice|status|message)\b/g, why: '提示、通知、狀態列' },
  { id: 'ui-log', re: /\.\s*ui\s*\.\s*log\b|\btelemetry\s*\.\s*(log|mark)\b/g, why: '日誌、遙測' },
  { id: 'console', re: /\bconsole\s*\.\s*\w+/g, why: 'console 會進除錯日誌' },
  { id: 'ui-copy', re: /\.\s*ui\s*\.\s*copy\b/g, why: '剪貼簿' },
  { id: 'ui-pane-meta', re: /\.\s*ui\s*\.\s*(open|close|invalidate|blit|ask)\b/g, why: '面板標題、重畫、提問（題目進對話記錄）' },
  PERSIST,
  { id: 'session', re: /\.\s*(session|prompt|agent|skill|attribution|turn|tool)\s*\.\s*(send|append|attach|receive|compact|fill|edit|compose|context|section|mention|attachment|suggest|autocomplete|submit|spawn|offer|register|call|check|describe)\b/g, why: '進模型對話脈絡' },
  // 聊天模組（pure／pane／client）一律不准登記 hook：on( 後面不管接什麼（換行、'*'、變數事件名）都禁；on 當值傳遞／取別名（= on、傳參數）也禁
  { id: 'hook-answer', re: /(^|[^\w$])on\s*\(|=\s*on\s*([;,)}\]]|$)|[(,]\s*on\s*[,)]|\{[^}]*\bon\b[^}]*\}\s*=/g, why: '用 hook 回答引擎事件：回傳值會進模型或指令輸出（聊天模組不准有 on）' },
  { id: 'model', re: /\.\s*model\s*\.\s*(classify|complete|fork)\b/g, why: '把文字送去模型' },
  NETWORK,
  { id: 'process', re: /\.\s*process\s*\.\s*(run|spawn)\b|\bchild_process\b|\bexecSync\s*\(|\bspawnSync\s*\(/g, why: '子行程' },
  { id: 'mcp', re: /\.\s*mcp\s*\.\s*(call|connect)\b/g, why: 'MCP' },
  { id: 'command-out', re: /\.\s*command\s*\.\s*(register|run|describe)\b/g, why: '指令輸出與說明' },
  { id: 'fs-path', re: /\.\s*fs\s*\.\s*(read|exists|list|stat|ancestors)\b/g, why: '檔案路徑可以是網路位置（UNC）' },
  { id: 'dynamic-code', re: /\beval\s*\(|\bnew\s+Function\b|(^|[^.\w$])import\s*\(/g, why: '動態執行／動態載入' },
  { id: 'global-object', re: /\bglobalThis\b|\bwindow\s*\.|\bself\s*\.\s*(fetch|postMessage)\b/g, why: '用全域物件繞過其他規則' },
  { id: 'browser-storage', re: /\b(localStorage|sessionStorage|indexedDB)\b|document\s*\.\s*cookie/g, why: '瀏覽器儲存' },
  { id: 'audio', re: /\.\s*audio\s*\.\s*(speak|play)\b/g, why: '念出文字' },
]

/** 純函式檔另外禁止的：碰引擎 */
const PURE_ONLY: readonly Rule[] = [
  { id: 'engine-import', re: /from\s+['"]claude-code(\/[\w-]+)?['"]|require\s*\(\s*['"]claude-code/g, why: '純函式模組不准 import 引擎' },
  // $ 的用法：取屬性（$.x、$[x]）、當參數宣告或傳遞（($: T)、f($)、f(a, $)）、指派／解構（= $）、箭頭函式（$ =>）。
  // 不用「出現 $ 就算」：正規式的行尾錨點（…{1,100}$/）會誤報；真的 $ 沒有 import 引擎型別也過不了 tsc
  { id: 'dollar', re: /(^|[^\w$])\$\s*[.[]|[(,]\s*\$\s*[:,)]|=\s*\$\s*(;|$)|(^|[^\w$])\$\s*=>/g, why: '純函式模組不准有 $（傳遞、解構、別名都不行）' },
]

/**
 * 接線檔 chat-register.tsx 逐條放行的出口（其餘照 SINKS 全擋）。每一條都是『這個檔案確實需要、而且參數不是聊天文字』的理由：
 * on：只有聊天分頁的畫面一個；toast：只有固定句子；store.set／delete：只有保管庫與租約兩個鍵（值是金鑰與密文快照，不是文字）；
 * ask：題目一律是參數 question，呼叫端另有一條檢查它們都來自 DM_STRINGS。
 */
export const WIRING_ALLOWED: readonly RegExp[] = [
  /(^|[^\w$])on\(\s*'ui\.render'\s*,\s*\{\s*component:\s*'Pane'\s*,\s*requestId:\s*'friends-chat'\s*\}/g,
  /\.\s*ui\s*\.\s*toast\(\s*wireText\(\s*'newMessageNotice'\s*,/g,
  /\.\s*ui\s*\.\s*ask\(\s*question\s*,/g,
  /\.\s*http\s*\.\s*fetch\b/g,
  /\.\s*store\s*\.\s*get\b/g,
  /\.\s*store\s*\.\s*set\(\s*(VAULT_KEY|LEASE_KEY)\s*,/g,
  /\.\s*store\s*\.\s*delete\(\s*(VAULT_KEY|LEASE_KEY)\s*\)/g, // CHAT-6：離開群組時一起刪聊天金鑰
]

/** 聊天分頁檔：寫 atom 的呼叫（只有 CHAT3-CLIENT 的模組能寫） */
const PANE_NO_WRITE: Rule = { id: 'pane-writes-atom', re: /(^|[^\w$.])update\s*\(/g, why: '聊天分頁只讀 atom；寫入是用戶端模組的事' }

// ---------------------------------------------------------------- 前處理

/**
 * 拿掉註解（保留換行，行號不變）。逐字掃描，字串、樣板字面值裡的 // 和 /* 不算註解
 * （舊版用正規式，字串裡的「/*」會吞掉後面的程式碼）。正規式字面值不處理（少見）。
 */
export function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]!
    const d = src[i + 1]
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++
        else if (c !== '`' && src[j] === '\n') break
        j++
      }
      out += src.slice(i, Math.min(j + 1, n))
      i = j + 1
    } else if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? n : end + 2
      out += src.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else {
      out += c
      i++
    }
  }
  return out
}

/** ?. 換成 .、['x'] 換成 .x，讓 $?.ui?.toast 和 $['ui']['toast'] 跟 $.ui.toast 一樣被規則看到 */
function normalize(code: string): string {
  return code
    .replace(/\?\./g, '.')
    .replace(/\[\s*(['"`])(\w+)\1\s*\]/g, '.$2')
}

export type ImportInfo = Readonly<{ from: string; isType: boolean; names: readonly string[]; line: number }>

/** 找出所有 import（含多行、含 import type、含單純 side-effect import） */
export function importsOf(source: string): ImportInfo[] {
  const code = stripComments(source)
  const out: ImportInfo[] = []
  const re = /\bimport\s+(type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}\s*)?(?:\*\s*as\s+([\w$]+)\s*)?(?:from\s*)?(['"])([^'"]+)\5/g
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const names = [m[2], ...(m[3] ?? '').split(',').map(x => x.trim().split(/\s+as\s+/)[0]), m[4]].filter((x): x is string => !!x)
    out.push({ from: m[6]!, isType: !!m[1], names, line: code.slice(0, m.index).split('\n').length })
  }
  return out
}

/**
 * $ 的出現：只准 $.ui.resolve、read($, …)，和「函式的參數宣告」（參數列後面接 => 或 {）。
 * 其他（傳給別的函式、解構、別名）一律算轉手：轉手之後這裡就看不到它接下來做什麼了。
 */
function dollarFindings(clean: string, kind: 'pane' | 'client'): Finding[] {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ')
  // pane：$.ui.resolve、read($,；client：$.http.fetch、$.store.get/set、read($,、update($,（\s 會跨行，所以 $\n.store\n.get 也算）
  const allowed = kind === 'pane'
    ? /\$\s*\.\s*ui\s*\.\s*resolve\b/g
    : /\$\s*\.\s*http\s*\.\s*fetch\b|\$\s*\.\s*store\s*\.\s*(get|set)\b|\bupdate\s*\(\s*\$\s*,/g
  const code = clean
    .replace(allowed, blank)
    .replace(/\bread\s*\(\s*\$\s*,/g, blank)
    .replace(/\(\s*\$[^()]*\)\s*(?::\s*[^={;]+)?\s*(?==>|\{)/g, blank)
    .replace(/(^|[\s,(])\$\s*(?::\s*[^,)=]+)?\s*(?==>)/g, blank)
  const out: Finding[] = []
  const original = clean.split('\n')
  code.split('\n').forEach((text, i) => {
    if (/(^|[^\w$])\$(?![\w${])/.test(text)) out.push({ rule: 'pane-dollar', line: i + 1, text: (original[i] ?? '').trim().slice(0, 140) })
  })
  return out
}

/** 呼叫鏈跨行時接成一條邏輯行：下一行以 . 開頭、或這一行以 . 結尾，就併進去。行號記第一行（報告的行號對得上原始檔） */
function logicalLines(clean: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = []
  let joinNext = false
  clean.split('\n').forEach((raw, i) => {
    const t = raw.trim()
    const prev = out[out.length - 1]
    if (prev && (joinNext || /^\.(?!\.)/.test(t)) && t !== '') prev.text += t
    else out.push({ text: raw, line: i + 1 })
    if (t !== '') joinNext = /[^.]\.$/.test(t)
  })
  return out
}

export function scanSource(source: string, kind: SourceKind): Finding[] {
  const clean = normalize(stripComments(source))
  const lines = logicalLines(clean)
  const out: Finding[] = []
  let rules: readonly Rule[]
  if (kind === 'pure') rules = [...SINKS, ...PURE_ONLY]
  else if (kind === 'pane') rules = [...SINKS, PANE_NO_WRITE]
  else if (kind === 'client') rules = SINKS.map(r => (r === NETWORK ? CLIENT_NETWORK : r === PERSIST ? CLIENT_PERSIST : r))
  else rules = SINKS
  for (const { text: original, line } of lines) {
    // 接線檔：先把逐條放行的結構換成空白，剩下的才套規則
    const text = kind === 'wiring' ? WIRING_ALLOWED.reduce((acc, re) => { re.lastIndex = 0; return acc.replace(re, m => m.replace(/[^\n]/g, ' ')) }, original) : original
    for (const r of rules) {
      r.re.lastIndex = 0
      if (r.re.test(text)) out.push({ rule: r.id, line, text: text.trim().slice(0, 140) })
    }
  }
  if (kind === 'pane' || kind === 'client') {
    const allowedNames = kind === 'pane' ? ['atom', 'read'] : ['atom', 'read', 'update']
    for (const imp of importsOf(source)) {
      if (!/^claude-code(\/[\w-]+)?$/.test(imp.from)) continue
      if (imp.isType) continue
      if (imp.from !== 'claude-code' || imp.names.length === 0 || !imp.names.every(x => allowedNames.includes(x))) {
        out.push({ rule: 'pane-import', line: imp.line, text: `import ${imp.names.join(',')} from '${imp.from}'` })
      }
    }
  }
  if (kind === 'pane' || kind === 'client') out.push(...dollarFindings(clean, kind))
  return out.sort((a, b) => a.line - b.line)
}

/** pane／client 檔的本地 import（相對路徑、非型別）：呼叫端要確認它們都在純函式清單裡，否則等於把 $ 或明文交給沒檢查過的檔案 */
export function localValueImports(source: string): string[] {
  return importsOf(source).filter(i => i.from.startsWith('.') && !i.isType).map(i => i.from)
}

export const STATIC_RULE_IDS: readonly string[] = [...SINKS, ...PURE_ONLY, PANE_NO_WRITE].map(r => r.id).concat(['pane-import', 'pane-dollar'])
