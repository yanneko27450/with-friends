// 部署前檢查：Worker 的測試專用開關（FRIENDS_TEST_FAULTS、FRIENDS_TEST_CLOCK）絕對不能進正式環境。
// FRIENDS_TEST_FAULTS 打開時，/__test/fault、/__test/reload 兩條路由才存在（還要連到本機主機名），用來注入儲存失敗。
// FRIENDS_TEST_CLOCK 打開時，x-friends-test-now 標頭可以指定「現在」（同樣還要連到本機主機名），用來測到期。
// 只要 wrangler 設定檔、環境變數、或命令列的 --var 出現它們，就拒絕部署／拒絕組公開 repo。
// 用法：node relay/worker/deploy-guard.mjs [wrangler 的參數…]（只檢查，通過 exit 0、不通過 exit 1）
// 正式部署請用 npm run deploy（deploy.mjs 先跑這個檢查，通過才呼叫 wrangler deploy）。
// 這裡只看得到本機能看到的三個地方：Cloudflare 後台手動設的變數看不到，RELEASE_CHECKLIST 另有一條人工確認。
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FORBIDDEN_VARS = ['FRIENDS_TEST_FAULTS', 'FRIENDS_TEST_CLOCK']
const CONFIG_FILES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']

/** 回傳違規清單（空陣列＝通過）。wranglerFiles：{ 檔名: 內容 }；env：環境變數；args：要傳給 wrangler 的參數 */
export function findTestFaultSettings({ wranglerFiles = {}, env = {}, args = [] } = {}) {
  const found = []
  for (const name of FORBIDDEN_VARS) {
    for (const [file, text] of Object.entries(wranglerFiles)) if (String(text).includes(name)) found.push(`${file} 裡出現 ${name}`)
    if (Object.hasOwn(env, name)) found.push(`環境變數 ${name} 有設定`)
    if (args.some(a => String(a).includes(name))) found.push(`命令列參數出現 ${name}`)
  }
  return found
}

/** 讀這個資料夾裡的 wrangler 設定檔 */
export function readWranglerFiles(dir = fileURLToPath(new URL('.', import.meta.url))) {
  const files = {}
  for (const f of CONFIG_FILES) if (existsSync(join(dir, f))) files[f] = readFileSync(join(dir, f), 'utf8')
  return files
}

/** 有違規就丟錯（訊息寫清楚怎麼辦） */
export function assertNoTestFaults(opts) {
  const found = findTestFaultSettings(opts)
  if (found.length) throw new Error(`拒絕：測試專用開關不能進正式環境（${found.join('；')}）。請移除後再試。`)
}

// 直接執行時才跑檢查。兩邊都取真實路徑：從連結（junction／symlink）進來也要認得出是自己，不然檢查會默默跳過（盲審 SF）
const isMain = (() => { try { return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]) } catch { return false } })()
if (isMain) {
  try {
    assertNoTestFaults({ wranglerFiles: readWranglerFiles(), env: process.env, args: process.argv.slice(2) })
    console.log('部署檢查通過：沒有測試專用開關')
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
