// 送去分類前，在本機把敏感字串換成泛稱。
// 分類結果只會是清單內代碼（見 taxonomy.ts），這一層只是讓送進分類模型的內容再少一點。

const HEX = '[0-9a-f]{1,4}'
const V4 = '\\d{1,3}(?:\\.\\d{1,3}){3}'
const V6 = `(?:::(?:ffff(?::0{1,4})?:)?${V4}|${HEX}(?::${HEX}){7}|(?=[0-9a-f:]*\\d)(?=[0-9a-f:]*[0-9a-f]{2})(?:${HEX}(?::${HEX}){0,6})?::(?:${HEX}(?::${HEX}){0,6})?)(?:%\\w+)?`
const IPV6 = new RegExp(`(?<!\\w)\\[${V6}\\](?::\\d{1,5})?|(?<![\\w:])(?<!\\w\\[)${V6}(?![\\w:]|\\.\\d)`, 'gi')

// 密碼關鍵字（sec-6a）：英文的可以在變數名裡、開頭要在字的邊界；中文的前面接什麼都算（Wi-Fi密碼：…）
const SECRET_KW = '(?:(?<![\\w-])[\\w-]{0,64}?(?:password|passwd|pwd|_pass|secret|token|api[_ -]?key|(?:private|access|auth|signing|client|master|encryption|session)[_-]?key)[\\w-]{0,64}|密碼|金鑰)'

// 匯出給效能測試逐條量（perf-1）；外掛本身只用 redact()
export const RULES: [RegExp, string][] = [
  [/```[\s\S]*?```/g, '[code]'],
  [/`[^`\n]{1,200}`/g, '[code]'],
  // 密碼句型（sec-6a）：關鍵字可以在變數名裡（DB_PASS、SECRET_KEY、x-api-key）、前後可夾引號；
  // 值是引號包起來的整段，或接在 是/為/:/= 後面的一個字；只隔空白或 is 時，值要有字母也有數字、6 字以上才算（「password reset」「the secret is out」不遮）
  // 量詞有上限、英文開頭要在字的邊界（不然長英數字串每個位置都往後掃，又變平方時間）
  [new RegExp(SECRET_KW + `["']?\\s*(?:是|為|[:=：])\\s*(?:"[^"\\n]{0,200}"|'[^'\\n]{0,200}'|\\S+)`, 'gi'), '[secret]'],
  [new RegExp(SECRET_KW + '(?:\\s+is)?\\s+(?=\\S*\\d)(?=\\S*[A-Za-z])\\S{6,}', 'gi'), '[secret]'],
  [/\bBearer\s+[\w.~+/=-]{8,}/gi, '[secret]'],
  [/\b(?:https?|ftp|file):\/\/\S+/gi, '[url]'],
  [/\bwww\.\S+/gi, '[url]'],
  // 量詞有上限、開頭要在字的邊界（fix-1）：沒有 @ 的長英數字串原本是平方時間
  [/(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g, '[email]'],
  // 開頭用 (?<![\w-]) 不用 \b：- 不算字，\b 會讓「eyJ-eyJ-…」每一段都當起點、各掃到底，變平方時間（perf-1）
  [/(?<![\w-])eyJ[\w-]{10,}\.[\w-]+\.[\w-]+/g, '[secret]'],
  // 純邀請碼（群組代碼 12 字．亂數 22 字，L-5／fix-4）：兩段都短於 32 字，下面那條長字串規則抓不到。連結形式的整串會被網址規則遮掉。
  // 要排在 sk-／pk-／rk- 前面：群組代碼剛好 sk- 開頭時，那條會先吃掉前 12 字，後面 22 字亂數就原文送出。
  // 兩段都是 base64url（core.mjs 的 token()：字母、數字、-、_）；亂數段要至少混兩種（大寫、小寫、數字），
  // 全小寫加底線的識別字（user_service.authentication_handler）不遮。真的邀請碼落在單一種的機率約 2e-8
  [/(?<![\w-])[\w-]{12}\.(?=[\w-]{22}(?![\w-]))(?:(?=[\w-]{0,21}[A-Z])(?=[\w-]{0,21}[a-z\d])|(?=[\w-]{0,21}[a-z])(?=[\w-]{0,21}\d))[\w-]{22}/g, '[secret]'],
  [/\b(?:sk|pk|rk)-[\w-]{8,}/g, '[secret]'],
  [/\b(?:ghp_|gho_|ghs_|github_pat_|glpat-|xox[abp]-|AKIA|AIza)[\w-]{8,}/g, '[secret]'],
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '[secret]'],
  [/[A-Za-z]:[\\/][^\s"'<>|，。、）)]*/g, '[path]'],
  [/\\\\[\w.-]+\\[^\s，。]*/g, '[path]'],
  [/(?:~|\.{1,2})?\/(?:[\w.-]+\/)+[\w.-]*/g, '[path]'],
  [/(?<![\w-])[\w-]{1,100}\.(?:docx?|xlsx?|pptx?|pdf|txt|md|py|js|mjs|ts|tsx|jsx|json|csv|html?|css|png|jpe?g|gif|mp4|mov|zip|sql|db|env|ya?ml|toml|ini|log)\b/gi, '[file]'],
  // IPv6（fix-1 重寫）：完整 8 組、含 :: 的縮寫（要有數字、且有一組 2 位以上，才不會把 C++ 的 a::b 當成位址；全字母的 dead::beef、本機 ::1 因此不遮）、
  // 夾 IPv4 的 ::ffff:1.2.3.4；可帶 %網卡。前面是「名字[」的是 Python 切片 x[10::2]，不算；[ ] 包起來的才吃 ]:port
  [IPV6, '[ip]'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, '[ip]'],
  [/\d[\d -]{4,}\d/g, '[number]'],
]

export const MAX_REDACTED = 1500
/** 先截這麼長再遮（fix-1）：最後只留 1500 字，貼一大段 base64／log 也不會卡住那一輪 */
export const MAX_INPUT = 4000

export function redact(text: string): string {
  // 截斷處可能切在一個金鑰中間（剩半截就認不出來）：最後 200 字內有空白就退到那裡；
  // 沒有（例如不加空白的中文長文）就硬切，只丟掉結尾那段像金鑰的半截英數字
  let out = text
  if (out.length > MAX_INPUT) {
    out = out.slice(0, MAX_INPUT)
    const cut = out.search(/\s\S*$/)
    out = cut >= MAX_INPUT - 200 ? out.slice(0, cut) : out.replace(/(?<![\w.+/=-])[\w.+/=-]+$/, '')
  }
  for (const [re, label] of RULES) out = out.replace(re, label)
  return out.slice(0, MAX_REDACTED)
}
