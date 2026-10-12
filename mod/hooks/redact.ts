// 送去分類前，在本機把敏感字串換成泛稱。
// 分類結果只會是清單內代碼（見 taxonomy.ts），這一層只是讓送進分類模型的內容再少一點。

const RULES: [RegExp, string][] = [
  [/```[\s\S]*?```/g, '[code]'],
  [/`[^`\n]{1,200}`/g, '[code]'],
  [/(?:password|passwd|pwd|密碼|token|secret|api[_ ]?key|金鑰)\s*(?:是|為|[:=：])\s*\S+/gi, '[secret]'],
  [/\b(?:https?|ftp|file):\/\/\S+/gi, '[url]'],
  [/\bwww\.\S+/gi, '[url]'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]'],
  [/\beyJ[\w-]{10,}\.[\w-]+\.[\w-]+/g, '[secret]'],
  [/\b(?:sk|pk|rk)-[\w-]{8,}/g, '[secret]'],
  [/\b(?:ghp_|gho_|ghs_|github_pat_|xox[abp]-|AKIA|AIza)[\w-]{8,}/g, '[secret]'],
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '[secret]'],
  [/[A-Za-z]:[\\/][^\s"'<>|，。、）)]*/g, '[path]'],
  [/\\\\[\w.-]+\\[^\s，。]*/g, '[path]'],
  [/(?:~|\.{1,2})?\/(?:[\w.-]+\/)+[\w.-]*/g, '[path]'],
  [/\b[\w-]+\.(?:docx?|xlsx?|pptx?|pdf|txt|md|py|js|mjs|ts|tsx|jsx|json|csv|html?|css|png|jpe?g|gif|mp4|mov|zip|sql|db|env|ya?ml|toml|ini|log)\b/gi, '[file]'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]'],
  [/\d[\d -]{4,}\d/g, '[number]'],
]

export const MAX_REDACTED = 1500

export function redact(text: string): string {
  let out = text
  for (const [re, label] of RULES) out = out.replace(re, label)
  return out.slice(0, MAX_REDACTED)
}
