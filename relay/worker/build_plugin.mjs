// 把 mod 打包成 zip＋marketplace.json，放進 public/ 讓中繼網址直接提供（test-0f）。
// 朋友：/plugin marketplace add <中繼網址>/marketplace.json → /plugin install with-friends@with-friends
// 官方 marketplace-reference：URL 來源的 marketplace 只抓 marketplace.json，外掛要用 archive 來源（https＋sha256，Claude Code 2.1.224+）
// 用法：node build_plugin.mjs [--base https://...]；zip 內容固定時間戳，同樣的程式打出同樣的 sha256
// 測更新用（ui-19）：--out <資料夾> 不寫 public/、不放說明頁；--version <x.y.z> 只改包進去的版本號
// 部署但不帶說明頁：--no-guide
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
if (arg('--version')) {
  if (!isTestBuild) throw new Error('--version 只給測試用，要搭配 --out')
  manifest.version = arg('--version')
}
// 只放外掛本體：manifest、hooks、types 宣告；測試和 tsc 用的型別檔不放
const files = [
  '.claude-plugin/plugin.json',
  ...readdirSync(join(mod, 'hooks')).sort().map(f => 'hooks/' + f),
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
console.log(`${zipName} ${buf.length} bytes sha256 ${sha256}\nmarketplace.json → ${base}/${zipName}`)
