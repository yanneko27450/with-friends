// 正式部署入口：npm run deploy [-- wrangler 的參數]。先跑 deploy-guard（測試專用開關不能進正式環境），通過才呼叫 wrangler deploy。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNoTestFaults, readWranglerFiles } from './deploy-guard.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
// 這些參數會讓 wrangler 去讀／上傳 guard 沒檢查過的檔案（別的設定檔、密鑰檔）：一律不收，要用請先改 deploy.mjs 並重新審查
const BLOCKED = ['-c', '--config', '--secrets-file', '--env-file']
const blocked = args.find(a => BLOCKED.some(b => a === b || a.startsWith(b + '=')))
if (blocked) {
  console.error(`拒絕：npm run deploy 不接受 ${blocked}（它會讓 wrangler 讀 guard 沒檢查過的檔案）`)
  process.exit(1)
}
try {
  assertNoTestFaults({ wranglerFiles: readWranglerFiles(here), env: process.env, args })
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
// 明確指定剛剛檢查過的那個設定檔（--config 一給，wrangler 就不會去跟 .wrangler/deploy/config.json 的轉址）
const configFile = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].find(f => existsSync(join(here, f)))
if (!configFile) {
  console.error('拒絕：找不到 wrangler 設定檔')
  process.exit(1)
}
const result = spawnSync(process.execPath, [join(here, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'deploy', '--config', join(here, configFile), ...args], { cwd: here, stdio: 'inherit' })
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)
