// 網頁版（web-2）打包檢查：不用開伺服器。node relay/worker/app.test.mjs
// 真的在瀏覽器裡加入、看列表、離開，要開 wrangler dev 另外跑（見 CLAUDE.md）。
import { execFileSync } from 'node:child_process'
import vm from 'node:vm'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { ACTION_LABEL, SUBJECT_LABEL } from '../../mod/hooks/taxonomy.ts'
import { CHANGELOG } from '../../mod/hooks/changelog.ts'

const here = import.meta.dirname
const out = mkdtempSync(join(tmpdir(), 'wf-app-'))
let passed = 0
const failed = []
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed.push(name)
    console.log(`  ✗ ${name}\n    ${err.message.split('\n').join('\n    ')}`)
  }
}

try {
  execFileSync(process.execPath, [join(here, 'build_plugin.mjs'), '--out', out], { stdio: 'ignore' })
  const files = readdirSync(out)
  const read = f => readFileSync(join(out, f), 'utf8')

  await check('打包有網頁版：/ 就是網頁版（朋友的邀請連結「網址#邀請碼」在瀏覽器打開就到這頁）', () => {
    for (const f of ['index.html', 'app.js', 'app.css', 'labels.js', '_headers']) assert.ok(files.includes(f), f)
  })
  await check('--no-app 就不帶網頁版', () => {
    const out2 = mkdtempSync(join(tmpdir(), 'wf-app-'))
    try {
      execFileSync(process.execPath, [join(here, 'build_plugin.mjs'), '--out', out2, '--no-app'], { stdio: 'ignore' })
      assert.ok(!readdirSync(out2).includes('index.html'))
    } finally {
      rmSync(out2, { recursive: true, force: true })
    }
  })
  await check('分類文字跟外掛同一份（labels.js 由 taxonomy.ts 產生）', () => {
    const m = /window\.WF_LABELS = Object\.freeze\((.*)\)\n$/s.exec(read('labels.js'))
    assert.ok(m, 'labels.js 格式')
    assert.deepEqual(JSON.parse(m[1]), { ACTION_LABEL, SUBJECT_LABEL })
  })
  await check('CSP：只連同一個網址、不載外部腳本與樣式', () => {
    const csp = read('_headers')
    for (const want of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]) assert.ok(csp.includes(want), want)
  })
  await check('頁面沒有內嵌腳本、內嵌樣式、外部網址', () => {
    const html = read('index.html')
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), '內嵌 <script>')
    assert.ok(!/<style/i.test(html) && !/\sstyle=/i.test(html), '內嵌樣式')
    assert.ok(!/(src|href)="https?:/i.test(html), '外部網址')
  })
  await check('朋友的名字只用 textContent 放進畫面（不碰 innerHTML 這類會解析 HTML 的東西）', () => {
    const js = read('app.js')
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) assert.ok(!js.includes(bad), bad)
  })
  await check('網頁成員只送在線：心跳只帶 state 和 conn，不送動態代碼', () => {
    const js = read('app.js')
    const bodies = [...js.matchAll(/api\('POST', '\/status', (\{[^}]*\})/g)].map(x => x[1])
    assert.ok(bodies.length >= 2, '找不到送狀態的地方')
    for (const b of bodies) assert.ok(!/action|subject|version/.test(b), b)
  })

  // ---- sec-12：真的跑 app.js（vm＋最小的假 DOM＋假中繼），中繼回惡意名字和群組名，頁面上只能是純文字 ----
  const EVIL = [
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    'javascript:alert(1)',
    '"><svg onload=alert(1)>',
    'Z​W‮J⁦',
    'L'.repeat(500),
  ]
  const EVIL_GROUP = '<b onmouseover=alert(1)>grp</b> javascript:alert(2)'
  async function runPage({ failStatus = 0, failFor = undefined, stored = true, lang = 'en', members = EVIL.map((name, i) => ({ id: 'f' + i, name, isMe: false, isOwner: false, presence: ['working', 'idle', 'offline'][i % 3], action: 'fixing-bugs', subject: 'website', activityAgoSec: 5, seenAgoSec: 9 })), groupName = EVIL_GROUP } = {}) {
    const html = read('index.html')
    const created = []
    const htmlWrites = []
    class El {
      constructor(tag, id) { this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this._text = ''; this.attrs = {}; this.dataset = {}; this.hidden = false; this.className = ''; this.value = ''; this.disabled = false; this.title = ''; this.classList = { toggle: () => {}, add: () => {}, remove: () => {} } }
      get textContent() { return this._text + this.children.map(c => c.textContent).join('') }
      set textContent(v) { this._text = String(v); this.children = [] }
      append(...n) { for (const x of n) { if (typeof x === 'string') this._text += x; else this.children.push(x) } }
      appendChild(x) { this.append(x); return x }
      replaceChildren(...n) { this.children = []; this._text = ''; this.append(...n) }
      setAttribute(k, v) { this.attrs[k] = String(v) }
      addEventListener(t, fn) { (this.listeners ??= {})[t] = fn }
      focus() {}
      select() {}
      set innerHTML(v) { htmlWrites.push(['innerHTML', v]) }
      set outerHTML(v) { htmlWrites.push(['outerHTML', v]) }
      insertAdjacentHTML(_, v) { htmlWrites.push(['insertAdjacentHTML', v]) }
    }
    const byId = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new El('div', m[1])]))
    const dataT = [...html.matchAll(/data-t="([^"]+)"/g)].map(m => Object.assign(new El('span'), { dataset: { t: m[1] } }))
    const store = { 'wf.lang': lang, ...(stored ? { 'wf.membership': JSON.stringify({ groupId: 'g1', memberId: 'm1', memberKey: 'k1', invite: 'g1.inv', name: 'Me', groupName: 'Old' }) } : {}) }
    const sent = []
    const document = {
      getElementById: id => byId[id] ?? (byId[id] = new El('div', id)),
      createElement: tag => { const e = new El(tag); created.push(e); return e },
      querySelectorAll: () => dataT,
      documentElement: { lang: '' },
      title: '',
      hidden: false,
      addEventListener() {},
      write: v => htmlWrites.push(['document.write', v]),
    }
    const ctx = {
      document, console, URL, JSON, Math, Date, Promise, Object, Array, String, Number, Boolean, RegExp, Error, encodeURIComponent, decodeURIComponent,
      navigator: { languages: ['en'], language: 'en', clipboard: { writeText: async () => {} } },
      location: { origin: 'https://relay.test', pathname: '/', hash: '' },
      history: { replaceState() {} },
      localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v) }, removeItem: k => { delete store[k] } },
      crypto: { randomUUID: () => 'conn-1234-5678' },
      setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
      addEventListener() {},
      fetch: async (path, init) => {
        sent.push({ path, init })
        // web-5：failFor(path) 回狀態碼、'net'（連不上）或 undefined（照常）
        const f = failFor?.(path)
        if (f === 'net') throw new TypeError('Failed to fetch ' + EVIL.join(' '))
        if (typeof f === 'number') return { ok: false, status: f, json: async () => ({ error: EVIL.join(' ') }) }
        if (path === '/join') return { ok: true, status: 200, json: async () => ({ groupId: 'g2', memberId: 'm9', memberKey: 'k9', groupName: 'New', invite: 'g2.inv', isOwner: false }) }
        if (failStatus) return { ok: false, status: failStatus, json: async () => ({ error: EVIL.join(' ') }) }
        return { ok: true, status: 200, json: async () => ({ ok: true, groupName, members: [{ id: 'm1', name: 'Me', isMe: true, isOwner: true, presence: 'idle', action: '', subject: '', activityAgoSec: null, seenAgoSec: 0 }, ...members] }) }
      },
    }
    ctx.window = ctx
    vm.createContext(ctx)
    vm.runInContext(read('labels.js'), ctx)
    // 句子表也拿出來給測試比對（web-5）
    vm.runInContext(read('app.js') + '\n;window.__STR = STR', ctx)
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
    const all = []
    const walk = e => { all.push(e); for (const c of e.children) walk(c) }
    for (const e of Object.values(byId)) walk(e)
    return { byId, created, htmlWrites, all, document, sent, store, STR: ctx.__STR }
  }

  await check('每個請求都帶 x-friends-version: web（ver-2b）', async () => {
    const p = await runPage()
    assert.ok(p.sent.length > 0, '有跟中繼要資料')
    for (const r of p.sent) assert.equal(r.init?.headers?.['x-friends-version'], 'web', r.path)
  })
  await check('XSS：中繼回惡意名字和群組名 → 沒有任何 innerHTML／insertAdjacentHTML／document.write（sec-12）', async () => {
    const p = await runPage()
    assert.ok(p.sent.length > 0, '有跟中繼要資料')
    assert.deepEqual(p.htmlWrites, [])
  })
  await check('XSS：頁面上新增的元素只有程式自己的 li／span／div，名字不會變成元素（sec-12）', async () => {
    const p = await runPage()
    assert.ok(p.created.length >= EVIL.length * 3, '好友列表真的畫出來了')
    assert.deepEqual([...new Set(p.created.map(e => e.tagName))].sort(), ['DIV', 'LI', 'SPAN'])
    for (const e of p.all) assert.ok(!['IMG', 'SCRIPT', 'SVG', 'B', 'A', 'IFRAME'].includes(e.tagName), e.tagName)
  })
  await check('XSS：名字原封不動當純文字顯示（每個惡意名字都找得到一個 textContent 剛好等於它的元素）（sec-12）', async () => {
    const p = await runPage()
    for (const name of EVIL) assert.ok(p.all.some(e => e._text === name), JSON.stringify(name).slice(0, 40))
  })
  await check('XSS：屬性只有程式自己設的 aria-*，className 不含好友文字，沒有任何 href／src／on…（sec-12）', async () => {
    const p = await runPage()
    for (const e of p.all) {
      for (const k of Object.keys(e.attrs)) assert.ok(/^aria-(hidden|label)$/.test(k), k)
      for (const v of Object.values(e.attrs)) for (const bad of ['<', 'javascript:', 'onerror', 'onload']) assert.ok(!v.includes(bad), v)
      assert.ok(/^[\w -]*$/.test(e.className), e.className)
      for (const k of ['href', 'src', 'onerror', 'onload', 'onclick']) assert.equal(e[k], undefined, k)
    }
  })
  await check('XSS：群組名只進 textContent 和 document.title（純文字），惡意字照原樣、不被解析（sec-12）', async () => {
    const p = await runPage()
    assert.equal(p.byId['group-name'].textContent, EVIL_GROUP)
    assert.equal(p.document.title, `${EVIL_GROUP} · Friends with Claude`)
  })
  await check('XSS：中繼回錯誤、錯誤內文是惡意文字 → 畫面上只有固定句子，找不到那段文字（sec-12）', async () => {
    for (const status of [400, 403, 429, 500]) {
      const p = await runPage({ failStatus: status })
      assert.deepEqual(p.htmlWrites, [], String(status))
      for (const e of p.all) for (const bad of ['<img', '<script', 'javascript:', 'onerror']) assert.ok(!e.textContent.includes(bad), `${status} ${e.id ?? e.tagName}`)
    }
  })
  // web-5：連不上／邀請失效／被移出群組／群組滿了／伺服器出錯，各一句固定句子＋下一步，中英都跑；中繼回的字一律不上畫面
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }
  const allText = p => p.all.map(e => e.textContent).join('\n')
  const submitJoin = async (p, invite = 'g2.validinvite', name = 'Sam') => {
    p.byId.invite.value = invite
    p.byId.name.value = name
    await p.byId['join-form'].listeners.submit({ preventDefault() {} })
    await settle()
    return p.byId['join-err']
  }
  for (const lang of ['en', 'zh-TW']) {
    await check(`web-5（${lang}）：已加入、連不上中繼或中繼 5xx → 「連不上，會自動重試」，不顯示中繼的字`, async () => {
      for (const f of ['net', 500, 503]) {
        const p = await runPage({ lang, failFor: () => f })
        assert.equal(p.byId.net.textContent, p.STR[lang].netBad, String(f))
        assert.ok(!allText(p).includes('<img'), String(f))
      }
    })
    await check(`web-5（${lang}）：被移出群組（401）→ 回到加入畫面、說明已不在群組、可以用新邀請再加入`, async () => {
      const p = await runPage({ lang, failFor: path => (path === '/status' ? 401 : undefined) })
      const err = p.byId['join-err']
      assert.equal(err.hidden, false)
      assert.equal(err.textContent, p.STR[lang].gone)
      assert.equal(p.byId.join.hidden, false, '回到加入畫面')
      assert.equal(p.store['wf.membership'], undefined, '本機存的成員資料清掉了')
    })
    for (const [label, f, key] of [['邀請失效或打錯、群組滿了（403）', 403, 'err403'], ['試太多次（429）', 429, 'err429'], ['連不上', 'net', 'errNet'], ['伺服器出錯（500）', 500, 'errServer'], ['格式不對（400）', 400, 'err400']]) {
      await check(`web-5（${lang}）：加入時${label} → 固定句子 ${key}`, async () => {
        const p = await runPage({ lang, stored: false, failFor: path => (path === '/join' ? f : undefined) })
        const err = await submitJoin(p)
        assert.equal(err.hidden, false)
        assert.equal(err.textContent, p.STR[lang][key])
        assert.ok(!allText(p).includes('<img'))
      })
    }
    await check(`web-5（${lang}）：加入時 404（這個網址不是中繼）→ errOtherRelay：請直接打開朋友傳來的連結`, async () => {
      const p = await runPage({ lang, stored: false, failFor: path => (path === '/join' ? 404 : undefined) })
      const err = await submitJoin(p)
      assert.equal(err.textContent, p.STR[lang].errOtherRelay)
    })
    await check(`web-5（${lang}）：貼的不是邀請 → errInvite，不打中繼`, async () => {
      const p = await runPage({ lang, stored: false })
      const before = p.sent.length
      const err = await submitJoin(p, 'hello there')
      assert.equal(err.textContent, p.STR[lang].errInvite)
      assert.equal(p.sent.length, before)
    })
    await check(`web-5（${lang}）：403 那句同時寫了「重新複製」和「群組滿了要先有人離開」兩種下一步`, async () => {
      const p = await runPage({ lang, stored: false })
      assert.match(p.STR[lang].err403, lang === 'en' ? /copy it again[\s\S]*someone has to leave/ : /重新複製[\s\S]*先有人離開/)
    })
  }
  await check('XSS：title 提示文字（滑鼠移上去）也只是字串屬性；頭像只取名字第一個看得到的字（sec-12）', async () => {
    const p = await runPage()
    const lis = p.byId.who.children
    assert.equal(lis.length, EVIL.length)
    for (const li of lis) assert.equal(typeof li.title, 'string')
    const firstLetters = lis.map(li => li.children[0].textContent)
    for (const ch of firstLetters) assert.ok(Array.from(ch).length === 1, ch)
    assert.ok(!firstLetters.includes('​') && !firstLetters.includes('‮'), '看不見的字不當頭像')
  })

  // fix-9 ⑤：版本紀錄的版本要對得上 plugin.json。plugin test 的沙箱讀不到真的 plugin.json，所以「不小於」這條放在這裡（Node 讀得到）
  const semverGt = (a, b) => {
    const x = a.split('.').map(Number), y = b.split('.').map(Number)
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
    return false
  }
  const manifestVersion = JSON.parse(readFileSync(join(here, '..', '..', 'mod', '.claude-plugin', 'plugin.json'), 'utf8')).version
  await check('changelog.ts 最上面那段的版本不小於 plugin.json 的版本（升版忘了寫版本紀錄會失敗，fix-9 ⑤）', () => {
    assert.ok(!semverGt(manifestVersion, CHANGELOG[0].version), `plugin.json 是 ${manifestVersion}，changelog.ts 最上面是 ${CHANGELOG[0].version}`)
  })
  // 在暫存資料夾裡複製一份 build_plugin.mjs＋mod 的必要檔，改 plugin.json 的版本，跑正式建置（不能碰真的 relay/worker/public/）
  const buildCopy = version => {
    const root = mkdtempSync(join(tmpdir(), 'wf-ver-'))
    const modSrc = join(here, '..', '..', 'mod')
    mkdirSync(join(root, 'relay', 'worker'), { recursive: true })
    cpSync(join(here, 'build_plugin.mjs'), join(root, 'relay', 'worker', 'build_plugin.mjs'))
    cpSync(join(modSrc, 'hooks'), join(root, 'mod', 'hooks'), { recursive: true })
    cpSync(join(modSrc, 'types', 'index.d.ts'), join(root, 'mod', 'types', 'index.d.ts'))
    const manifest = JSON.parse(readFileSync(join(modSrc, '.claude-plugin', 'plugin.json'), 'utf8'))
    manifest.version = version
    mkdirSync(join(root, 'mod', '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, 'mod', '.claude-plugin', 'plugin.json'), JSON.stringify(manifest))
    const run = extra => {
      try {
        execFileSync(process.execPath, [join(root, 'relay', 'worker', 'build_plugin.mjs'), '--no-guide', '--no-app', ...extra], { stdio: 'pipe' })
        return { ok: true, stderr: '' }
      } catch (err) {
        return { ok: false, stderr: String(err.stderr) }
      }
    }
    return { root, run, pub: join(root, 'relay', 'worker', 'public') }
  }
  await check('正式建置：plugin.json 版本跟 changelog.ts 最上面那段不一樣 → 丟錯、不產 zip、不建 public/（fix-9 ⑤）', () => {
    const b = buildCopy('9.9.9')
    try {
      const r = b.run([])
      assert.equal(r.ok, false, '版本對不上要失敗')
      assert.match(r.stderr, /changelog\.ts/)
      assert.match(r.stderr, new RegExp('9\\.9\\.9'))
      assert.ok(r.stderr.includes(CHANGELOG[0].version), '兩邊的版本都要寫在訊息裡')
      assert.ok(!existsSync(b.pub), '不能產出任何東西（連 public/ 都不建）')
    } finally {
      rmSync(b.root, { recursive: true, force: true })
    }
  })
  await check('正式建置：版本一樣就照常產 zip；--out --version 的測試建置不受影響（fix-9 ⑤）', () => {
    const top = CHANGELOG[0].version
    const ok = buildCopy(top)
    try {
      const r = ok.run([])
      assert.equal(r.ok, true, r.stderr)
      assert.ok(readdirSync(ok.pub).includes(`with-friends-${top}.zip`))
    } finally {
      rmSync(ok.root, { recursive: true, force: true })
    }
    // 測試建置（更新測試用）：plugin.json 版本跟 changelog.ts 對不上也要能建
    const t = buildCopy('9.9.9')
    try {
      const outDir = join(t.root, 'testout')
      const r = t.run(['--out', outDir, '--version', '1.2.3'])
      assert.equal(r.ok, true, r.stderr)
      assert.ok(readdirSync(outDir).includes('with-friends-1.2.3.zip'))
    } finally {
      rmSync(t.root, { recursive: true, force: true })
    }
  })
} finally {
  rmSync(out, { recursive: true, force: true })
}
console.log(`\n${passed} 通過，${failed.length} 失敗`)
process.exitCode = failed.length ? 1 : 0
