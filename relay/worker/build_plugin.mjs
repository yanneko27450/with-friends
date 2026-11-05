// 把 mod 打包成 zip＋marketplace.json，放進 public/ 讓中繼網址直接提供（test-0f）。
// 朋友：/plugin marketplace add <中繼網址>/marketplace.json → /plugin install with-friends@with-friends
// 官方 marketplace-reference：URL 來源的 marketplace 只抓 marketplace.json，外掛要用 archive 來源（https＋sha256，Claude Code 2.1.224+）
// 用法：node build_plugin.mjs [--base https://...]；zip 內容固定時間戳，同樣的程式打出同樣的 sha256
// 測更新用（ui-19）：--out <資料夾> 不寫 public/、不放說明頁；--version <x.y.z> 只改包進去的版本號
// 部署但不帶說明頁：--no-guide；不帶網頁版：--no-app
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

const here = import.meta.dirname
const mod = join(here, '..', '..', 'mod')
const arg = name => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const out = arg('--out') ?? join(here, 'public')
const isTestBuild = arg('--out') !== undefined
const base = (arg('--base') ?? 'https://friends-status-relay.friends-status-relay.workers.dev').replace(/\/+$/, '')

const manifest = JSON.parse(readFileSync(join(mod, '.claude-plugin', 'plugin.json'), 'utf8'))
const realVersion = manifest.version // --version 蓋掉之前的真實版本（zip 裡的程式碼是這一版的）
if (arg('--version')) {
  if (!isTestBuild) throw new Error('--version 只給測試用，要搭配 --out')
  manifest.version = arg('--version')
}
// 版本紀錄對得上（fix-9 ⑤）：正式建置（不是 --out 測試建置）時，plugin.json 的版本要跟版本紀錄 mod/hooks/changelog.ts 最上面那段一樣，
// 不然升版時 pane 的「版本紀錄」會把新版那段當成「比自己新」整段藏起來（或新版根本沒寫紀錄）。對不上就丟錯、不產 zip，也不動 public/。
// 讀法：直接載入 changelog.ts 取出 CHANGELOG（跟下面讀 taxonomy.ts 同一招，Node 22.18+ 直接跑 .ts）——是外掛實際會用的那份資料，不是另外用字串去比對原始碼
if (!isTestBuild) {
  const { CHANGELOG } = await import(pathToFileURL(join(mod, 'hooks', 'changelog.ts')).href)
  const top = CHANGELOG?.[0]?.version
  if (top !== manifest.version) {
    throw new Error(`plugin.json 的版本是 ${manifest.version}，但 mod/hooks/changelog.ts 最上面那段是 ${top}：升版時兩邊要一起改（替新版寫版本紀錄），不然 pane 的「版本紀錄」會缺這一版。沒有產 zip。`)
  }
  // ver-1b：CHANGELOG.md 和版本紀錄的每一版、日期也要對得上（主人要使用者看得到每個小版本）。
  // 公開 repo 兩個都沒有（CHANGELOG.md 只留私人 repo），跳過並印一行（產出的 zip 不受影響）；只有其中一個＝私人 repo 被搬亂了，不默默跳過
  const checker = join(here, '..', '..', 'team', 'tools', 'changelog_check.mjs')
  const hasMd = existsSync(join(here, '..', '..', 'CHANGELOG.md')), hasChecker = existsSync(checker)
  if (hasMd && hasChecker) {
    const { checkRepo } = await import(pathToFileURL(checker).href)
    const errors = await checkRepo(join(here, '..', '..'))
    if (errors.length) throw new Error(`CHANGELOG.md 和 mod/hooks/changelog.ts 對不上（node team/tools/changelog_check.mjs 看全部）：\n${errors.join('\n')}\n沒有產 zip。`)
  } else if (hasMd || hasChecker) {
    throw new Error(`找得到 ${hasMd ? 'CHANGELOG.md' : 'team/tools/changelog_check.mjs'} 卻找不到 ${hasMd ? 'team/tools/changelog_check.mjs' : 'CHANGELOG.md'}：版本紀錄對照沒辦法跑。沒有產 zip。`)
  } else {
    console.log('（沒有 CHANGELOG.md 和 team/tools/：略過版本紀錄對照）')
  }
}
// CHAT-5 發版鎖：外掛有聊天的版本（0.6.0 起）要先有相容閘門——兩個中繼（Node 版、Worker 版）都要有簽章回應的 GET /capability，不然不產 zip。
// 只看 plugin.json 的真實版本（zip 裡的程式碼是這一版的；--version 只改標籤），不管輸出到哪、不管有沒有 --out。
// 一開始試過「只擋輸出在 relay/worker/public 之內」，但同一個資料夾的寫法太多（長路徑前綴、UNC、junction、subst、8.3 短名），猜不完，所以改成不猜路徑。
// 代價：0.6.0 以上的外掛，在中繼端做完之前連測試用的建置都不能出（先做中繼端，再升版）。版本讀不出來（例如 0.x）一律當作要擋。
// 這只是最後一道絆線（看原始碼有沒有這條路由）；真正的相容測試是 docs/drafts/chat5-gate-design.md 第 5 節的 T1～T7
const isChatVersion = version => {
  const [major, minor] = String(version).split('.').map(Number)
  return !Number.isInteger(major) || !Number.isInteger(minor) || major > 0 || minor >= 6
}
if (isChatVersion(realVersion)) {
  for (const file of [join(here, '..', 'server.mjs'), join(here, 'src', 'index.mjs')]) {
    if (!existsSync(file) || !readFileSync(file, 'utf8').includes('GET /capability')) {
      throw new Error(`plugin.json 的版本是 ${realVersion}（有聊天或讀不出版本），但 ${file} 沒有 GET /capability：聊天相容閘門還沒做完，不能出這一版（docs/drafts/chat5-gate-design.md）。沒有產 zip。`)
    }
  }
}
// 只放外掛本體：manifest、hooks、types 宣告；測試和 tsc 用的型別檔不放
const files = [
  '.claude-plugin/plugin.json',
  // dot files are scratch (for example mutation-test copies) and never ship
  ...readdirSync(join(mod, 'hooks')).filter(f => !f.startsWith('.')).sort().map(f => 'hooks/' + f),
  'types/index.d.ts',
]

function zip(entries) {
  const locals = [], centrals = []
  let offset = 0
  for (const [name, data] of entries) {
    const n = Buffer.from(name, 'utf8'), body = deflateRawSync(data), crc = crc32(data)
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8)
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12) // 1980-01-01 00:00
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10)
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14)
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28)
    c.writeUInt32LE(offset, 42)
    locals.push(h, n, body); centrals.push(c, n)
    offset += h.length + n.length + body.length
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const zipName = `${manifest.name}-${manifest.version}.zip`
const read = f => (f === '.claude-plugin/plugin.json' ? Buffer.from(JSON.stringify(manifest, null, 2) + '\n') : readFileSync(join(mod, f)))
const buf = zip(files.map(f => [`${manifest.name}/${f}`, isTestBuild ? read(f) : readFileSync(join(mod, f))]))
const sha256 = createHash('sha256').update(buf).digest('hex')
const market = {
  name: 'with-friends',
  owner: { name: 'Friends with Claude' },
  description: 'Friends with Claude (a Claude Code plugin): see which friends are online and what kind of work they do with Claude.',
  plugins: [{
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    source: { source: 'archive', url: `${base}/${zipName}`, sha256 },
  }],
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
writeFileSync(join(out, zipName), buf)
writeFileSync(join(out, 'marketplace.json'), JSON.stringify(market, null, 2) + '\n')
// 說明頁（ui-14）：/guide＋css／js，_headers 給所有靜態檔加 CSP；原稿在 guide/，public/ 每次重建
const guide = join(here, 'guide')
// --no-guide：這次不帶說明頁（10-12 說明頁 v2 還在 31c04ba8 那邊重寫，主人沒說要上線就不帶）
const isWithGuide = !isTestBuild && !process.argv.includes('--no-guide')
if (isWithGuide) for (const f of readdirSync(guide)) writeFileSync(join(out, f), readFileSync(join(guide, f)))
// 網頁版（web-2）：中繼網址本身（/）就是網頁版，朋友的邀請連結「網址#邀請碼」在瀏覽器打開就能加入；原稿在 app/。
// 分類文字跟外掛同一份（mod/hooks/taxonomy.ts），打包時寫成 labels.js；CSP 一樣靠 guide/_headers（不帶說明頁時也要帶它）
if (!process.argv.includes('--no-app')) {
  const app = join(here, 'app')
  for (const f of readdirSync(app)) writeFileSync(join(out, f), readFileSync(join(app, f)))
  const { ACTION_LABEL, SUBJECT_LABEL } = await import(pathToFileURL(join(mod, 'hooks', 'taxonomy.ts')).href)
  writeFileSync(join(out, 'labels.js'), `// 由 build_plugin.mjs 從 mod/hooks/taxonomy.ts 產生，不要手改
window.WF_LABELS = Object.freeze(${JSON.stringify({ ACTION_LABEL, SUBJECT_LABEL })})
`)
  if (!isWithGuide) writeFileSync(join(out, '_headers'), readFileSync(join(guide, '_headers')))
}
console.log(`${zipName} ${buf.length} bytes sha256 ${sha256}\nmarketplace.json → ${base}/${zipName}`)
