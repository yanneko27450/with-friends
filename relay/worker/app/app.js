// Friends with Claude 網頁版（web-2）：瀏覽器貼邀請 → 取名 → 看到跟 pane 一樣的好友列表。
// 網頁成員自己沒有動態（Chat 沒有地方能自動回報），只送「這頁開著＝在線」。
// 規則：朋友傳來的名字一律用 textContent 放進畫面（不用任何會解析 HTML 的寫法）；中繼回的錯誤文字不顯示，只看狀態碼挑固定句子。
// 金鑰只存在這個瀏覽器的 localStorage（清掉就要重新加入）；只連同一個網址（CSP connect-src 'self'）。
'use strict'

const STR = {
  'zh-TW': {
    langBtn: 'English',
    joinTitle: '用網頁看朋友在不在線',
    joinLede: '貼上朋友給你的邀請，取個名字就加入了。網頁版只看朋友，不會分享你在做什麼。',
    joinH: '加入群組',
    inviteLabel: '邀請',
    inviteHint: '朋友傳來的整串（例：https://…#…）、「/friends join …」那一行，或只有邀請碼都可以。',
    nameLabel: '你的名字',
    nameHint: '朋友會看到這個名字，最多 20 個字。',
    joinBtn: '加入',
    joining: '加入中…',
    notesH: '網頁版和外掛差在哪',
    note1: '這頁開著，朋友看到你「在線」；關掉就離線。',
    note2: '網頁版不分享你在做什麼。要讓朋友看到「修錯誤 · 網站」這類動態，要用電腦上的 Claude Code 裝外掛。',
    note3: '送出去的資料、存多久、怎麼驗證：',
    note3Link: '說明頁',
    errInvite: '看不出是邀請。請貼朋友傳來的整串連結。',
    errOtherRelay: '這個邀請屬於別的伺服器，請直接用瀏覽器打開朋友傳來的連結。',
    errName: '請填一個名字。',
    err403: '邀請不對、已經失效，或群組滿了（最多 5 人）。請朋友在面板重新複製一次；如果是群組滿了，要先有人離開。',
    err429: '試太多次了，請一小時後再試。',
    err400: '格式不對，請重新貼一次邀請。',
    errNet: '連不上伺服器，請確認網路後再試。',
    errServer: '伺服器暫時出了問題，請過一分鐘再試。',
    recent: '最近動態',
    online: n => `位好友在線`,
    whoLabel: '群組成員',
    me: '（你）',
    doingPrefix: { working: '正在', idle: '剛剛在' },
    presence: { working: '工作中', idle: '閒置', offline: '離線' },
    noActivity: '在線，沒有動態',
    viaWeb: '在線',
    justNow: '剛剛',
    minAgo: n => `${n} 分鐘前`,
    hourAgo: n => `${n} 小時前`,
    dayAgo: n => `${n} 天前`,
    updated: '已更新',
    netBad: '連不上伺服器，會自動重試',
    loading: '讀取中…',
    emptyAlone: '群組裡還沒有其他人。按「複製邀請連結」傳給朋友。',
    meTitle: '好友看到的你',
    rowName: '名字',
    rowOnline: '在不在線',
    rowOnlineV: '在線（這頁開著）',
    rowDoing: '在做什麼',
    rowDoingV: '不分享',
    meFoot: '關掉這頁＝你離線。網頁版不會送出任何對話內容。',
    copyInvite: '複製邀請連結',
    copiedOk: '已複製，傳給朋友就好',
    copyManual: '請手動複製下面這串：',
    leave: '離開群組',
    leaveQ: '確定離開？',
    leaveYes: '離開',
    leaveNo: '先不要',
    leaveErr: '離開失敗，你還在群組裡。請稍後再試。',
    gone: '你已經不在這個群組（被移除或群組已刪除）。可以用新的邀請再加入。',
    noStorage: '這個瀏覽器不讓網頁存資料：重新整理後要再加入一次。',
  },
  en: {
    langBtn: '中文',
    joinTitle: 'See which friends are online, in your browser',
    joinLede: "Paste the invite a friend sent you and pick a name. The web version only shows friends; it doesn't share what you're doing.",
    joinH: 'Join a group',
    inviteLabel: 'Invite',
    inviteHint: 'The whole link (https://…#…), the "/friends join …" line, or just the invite code.',
    nameLabel: 'Your name',
    nameHint: 'Friends will see this name. Up to 20 characters.',
    joinBtn: 'Join',
    joining: 'Joining…',
    notesH: 'How the web version differs',
    note1: 'While this page is open, friends see you as online. Close it and you go offline.',
    note2: "The web version doesn't share what you're doing. To show activity like \"Fixing bugs · a website\", install the plugin in Claude Code on your computer.",
    note3: 'What is sent, how long it is kept, and how to check:',
    note3Link: 'the guide',
    errInvite: "That doesn't look like an invite. Paste the whole link your friend sent.",
    errOtherRelay: 'This invite belongs to a different server. Open the link your friend sent directly in the browser.',
    errName: 'Please enter a name.',
    err403: 'The invite is wrong, expired, or the group is full (5 people). Ask your friend to copy it again from the panel; if the group is full, someone has to leave first.',
    err429: 'Too many tries. Please try again in an hour.',
    err400: 'Something was malformed. Please paste the invite again.',
    errNet: "Can't reach the server. Check your connection and try again.",
    errServer: 'The server had a problem. Please try again in a minute.',
    recent: 'Recent activity',
    online: n => (n === 1 ? 'friend online' : 'friends online'),
    whoLabel: 'Group members',
    me: ' (you)',
    doingPrefix: { working: '', idle: 'Last: ' },
    presence: { working: 'Working', idle: 'Idle', offline: 'Offline' },
    noActivity: 'Online, no activity',
    viaWeb: 'Online',
    justNow: 'just now',
    minAgo: n => `${n} min ago`,
    hourAgo: n => (n === 1 ? '1 hour ago' : `${n} hours ago`),
    dayAgo: n => (n === 1 ? '1 day ago' : `${n} days ago`),
    updated: 'Updated',
    netBad: "Can't reach the server. Retrying…",
    loading: 'Loading…',
    emptyAlone: 'Nobody else is in the group yet. Press "Copy invite link" and send it to a friend.',
    meTitle: 'What friends see',
    rowName: 'Name',
    rowOnline: 'Online',
    rowOnlineV: 'Yes (this page is open)',
    rowDoing: 'Doing',
    rowDoingV: 'Not shared',
    meFoot: 'Close this page and you go offline. The web version never sends any conversation.',
    copyInvite: 'Copy invite link',
    copiedOk: 'Copied. Send it to a friend.',
    copyManual: 'Copy this by hand:',
    leave: 'Leave group',
    leaveQ: 'Leave this group?',
    leaveYes: 'Leave',
    leaveNo: 'Not now',
    leaveErr: "Couldn't leave. You're still in the group; please try again later.",
    gone: "You're no longer in this group (removed, or the group was deleted). You can join again with a new invite.",
    noStorage: "This browser won't let the page save data: you'll need to join again after reloading.",
  },
}

const PULL_MS = 15_000 // 頁面看得到：跟 pane 開著一樣 15 秒一次
const HIDDEN_MS = 60_000 // 分頁在背景：60 秒一次心跳（中繼 150 秒沒消息才算離線）
const HIDDEN_STOP_MS = 30 * 60_000 // 背景放超過 30 分鐘就停（算離線），切回來再開始；省中繼的請求量（relay/COST.md）
const KEY = 'wf.membership'
const LANG_KEY = 'wf.lang'
const FILLS = 6
const ORDER = { working: 0, idle: 1, offline: 2 }

// ---- 存取（localStorage 可能被擋：私密視窗、封鎖網站資料）----
let memStore = null
let canStore = true
function load(k) {
  try { return localStorage.getItem(k) } catch { canStore = false; return memStore?.[k] ?? null }
}
function save(k, v) {
  try {
    if (v === null) localStorage.removeItem(k)
    else localStorage.setItem(k, v)
  } catch {
    canStore = false
    memStore ??= {}
    if (v === null) delete memStore[k]
    else memStore[k] = v
  }
}

function pickLang() {
  const saved = load(LANG_KEY)
  if (saved === 'en' || saved === 'zh-TW') return saved
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language || 'en']
  // 跟外掛（ui-21）同一個規則：中文任何寫法 → 繁中，其他 → 英文
  return langs.some(l => /^zh\b/i.test(l)) ? 'zh-TW' : 'en'
}
let lang = pickLang()
const s = () => STR[lang]

function readMembership() {
  try {
    const m = JSON.parse(load(KEY) ?? 'null')
    if (m && typeof m.groupId === 'string' && typeof m.memberId === 'string' && typeof m.memberKey === 'string') return m
  } catch { /* 壞掉就當沒加入 */ }
  return null
}
let membership = readMembership()
let friends = []
let lastOkAt = 0
let isNetOk = true
let timer = 0
let lastPullAt = 0
let hiddenSince = 0
let goneNotice = false
// 這個分頁的連線 id：中繼靠它分辨同一個人開的不同分頁／對話
const conn = (crypto.randomUUID?.() ?? String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)

const $ = id => document.getElementById(id)

// ---- 代碼 → 文字（labels.js 由 build_plugin.mjs 從 mod/hooks/taxonomy.ts 產生，同一份清單）----
function activityText(action, subject) {
  const L = window.WF_LABELS
  if (!L) return ''
  const A = L.ACTION_LABEL[lang], S = L.SUBJECT_LABEL[lang]
  const left = Object.hasOwn(A, action) ? A[action] : A.other
  const right = Object.hasOwn(S, subject) ? S[subject] : ''
  return right ? `${left} · ${right}` : left
}

function ago(sec) {
  if (sec === null || sec === undefined) return ''
  if (sec < 60) return s().justNow
  if (sec < 3600) return s().minAgo(Math.floor(sec / 60))
  if (sec < 86400) return s().hourAgo(Math.floor(sec / 3600))
  return s().dayAgo(Math.floor(sec / 86400))
}

// 頭像跟外掛 avatar.ts 一樣：同一個成員永遠同一個顏色，只取名字第一個看得到的字
function fillFor(id) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % FILLS
}
function initial(name) {
  const cleaned = String(name).replace(/[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿\s]/g, '')
  return (Array.from(cleaned)[0] ?? '?').toUpperCase()
}
function avatar(f) {
  const el = document.createElement('span')
  const p = ORDER[f.presence] === undefined ? 'offline' : f.presence
  el.className = `av ${p} c${fillFor(String(f.id))}`
  el.textContent = initial(f.name)
  el.setAttribute('aria-hidden', 'true')
  return el
}

// ---- 中繼 ----
class HttpError extends Error {
  constructor(status) { super(String(status)); this.status = status }
}
async function api(method, path, body, keepalive = false) {
  // ver-2b：網頁版帶 web（外掛帶自己的版本號），中繼將來才分得出是誰
  const headers = { 'content-type': 'application/json', 'x-friends-version': 'web' }
  if (membership) headers.authorization = `Bearer ${membership.groupId}.${membership.memberId}.${membership.memberKey}`
  let res
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), keepalive, cache: 'no-store' })
  } catch {
    throw new HttpError(0)
  }
  if (!res.ok) throw new HttpError(res.status)
  return res.json()
}

/** 邀請：整串連結、「/friends join 連結」、或純邀請碼（跟外掛 parseInvite 同規則） */
function parseInvite(raw) {
  let t = String(raw).trim()
  const cmd = /^\/friends\s+join\s+(\S+)/i.exec(t)
  if (cmd) t = cmd[1]
  const m = /^(https?:\/\/[^\s#]+)#([^\s#]+)$/.exec(t)
  if (m) {
    let origin
    try { origin = new URL(m[1]).origin } catch { return { error: 'errInvite' } }
    if (origin !== location.origin) return { error: 'errOtherRelay' }
    t = m[2]
  }
  if (!/^[\w.-]{4,200}$/.test(t)) return { error: 'errInvite' }
  return { invite: t }
}
const inviteLink = () => `${location.origin}#${membership.invite}`

// ---- 畫面 ----
function applyText() {
  document.documentElement.lang = lang === 'zh-TW' ? 'zh-Hant' : 'en'
  for (const el of document.querySelectorAll('[data-t]')) {
    const v = s()[el.dataset.t]
    if (typeof v === 'string') el.textContent = v
  }
  $('lang').textContent = s().langBtn
  $('who').setAttribute('aria-label', s().whoLabel)
  $('linkbox').setAttribute('aria-label', s().copyInvite)
}

function render() {
  applyText()
  const joined = Boolean(membership)
  $('top-joined').hidden = !joined
  $('top-join').hidden = joined
  $('join').hidden = joined
  $('feed').hidden = !joined
  $('me').hidden = !joined
  document.title = joined && membership.groupName ? `${membership.groupName} · Friends with Claude` : 'Friends with Claude'
  if (!joined) return renderJoin()
  $('group-name').textContent = membership.groupName || 'Friends with Claude'
  // 中繼清過的名字為準（控制字元、超過 20 字會被拿掉）
  $('me-name').textContent = friends.find(f => f.isMe)?.name ?? membership.name ?? ''
  const others = friends.filter(f => !f.isMe)
  const onlineN = others.filter(f => f.presence !== 'offline').length
  $('online-n').textContent = String(onlineN)
  $('total-n').textContent = others.length ? ` / ${others.length}` : ''
  $('online-label').textContent = s().online(onlineN)
  const who = $('who')
  who.replaceChildren(...[...others].sort((a, b) => ORDER[a.presence] - ORDER[b.presence]).map(f => {
    const li = document.createElement('li')
    li.append(avatar(f))
    li.title = `${f.name} · ${s().presence[f.presence] ?? ''}`
    const sr = document.createElement('span')
    sr.className = 'sr'
    sr.textContent = li.title
    li.append(sr)
    return li
  }))
  renderFeed(others)
  renderNet()
}

function renderFeed(others) {
  const tl = $('tl')
  const empty = $('empty')
  if (!lastOkAt && !friends.length) {
    tl.replaceChildren()
    empty.hidden = false
    empty.textContent = s().loading
    return
  }
  empty.hidden = others.length > 0
  empty.textContent = s().emptyAlone
  // 在線的照「動態多新」排；離線的放最後
  const online = others.filter(f => f.presence !== 'offline')
    .sort((a, b) => (a.activityAgoSec ?? Infinity) - (b.activityAgoSec ?? Infinity))
  const offline = others.filter(f => f.presence === 'offline')
  tl.replaceChildren(...[...online, ...offline].map(friendRow))
}

function friendRow(f) {
  const li = document.createElement('li')
  const p = ORDER[f.presence] === undefined ? 'offline' : f.presence
  li.className = p
  li.append(avatar(f))
  const card = document.createElement('div')
  card.className = 'card'
  const line = document.createElement('div')
  line.className = 'line'
  const name = document.createElement('span')
  name.className = 'who-n'
  name.textContent = f.name
  line.append(name)
  const hasActivity = p !== 'offline' && f.action
  if (hasActivity) {
    const doing = document.createElement('span')
    doing.className = 'doing'
    const prefix = s().doingPrefix[p === 'working' ? 'working' : 'idle']
    doing.textContent = (prefix ? prefix + ' ' : '') + activityText(f.action, f.subject)
    line.append(doing)
  }
  const meta = document.createElement('div')
  meta.className = 'meta'
  const dot = document.createElement('span')
  dot.className = `dot ${p}`
  const st = document.createElement('span')
  st.textContent = p === 'offline' ? s().presence.offline : hasActivity ? s().presence[p] : s().noActivity
  meta.append(dot, st)
  const when = hasActivity ? ago(f.activityAgoSec) : p === 'offline' ? ago(f.seenAgoSec) : ''
  if (when) {
    const w = document.createElement('span')
    w.className = 'when'
    w.textContent = when
    meta.append(w)
  }
  card.append(line, meta)
  li.append(card)
  return li
}

function renderNet() {
  const n = $('net')
  n.classList.toggle('bad', !isNetOk)
  n.textContent = !isNetOk ? s().netBad : lastOkAt ? `${s().updated} ${new Date(lastOkAt).toLocaleTimeString(lang === 'zh-TW' ? 'zh-TW' : 'en', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''
}

function renderJoin() {
  const err = $('join-err')
  if (goneNotice) {
    err.hidden = false
    err.textContent = s().gone
  }
}

// ---- 動作 ----
async function pull() {
  if (!membership) return
  lastPullAt = Date.now()
  try {
    const data = await api('POST', '/status', { state: 'idle', conn })
    if (Array.isArray(data.members)) friends = data.members.filter(f => f && typeof f.id === 'string' && typeof f.name === 'string')
    if (typeof data.groupName === 'string' && data.groupName !== membership.groupName) {
      membership = { ...membership, groupName: data.groupName }
      save(KEY, JSON.stringify(membership))
    }
    lastOkAt = Date.now()
    isNetOk = true
  } catch (e) {
    // 401＝金鑰失效（被移除、群組刪了）：清掉本機、回到加入畫面
    if (e.status === 401) return forget(true)
    isNetOk = false
  }
  render()
}

function schedule() {
  clearTimeout(timer)
  if (!membership) return
  if (document.hidden && hiddenSince && Date.now() - hiddenSince > HIDDEN_STOP_MS) return
  timer = setTimeout(async () => { await pull(); schedule() }, document.hidden ? HIDDEN_MS : PULL_MS)
}

function forget(isGone) {
  membership = null
  friends = []
  lastOkAt = 0
  goneNotice = isGone
  save(KEY, null)
  clearTimeout(timer)
  render()
}

async function join(ev) {
  ev.preventDefault()
  const err = $('join-err')
  const show = key => { err.hidden = false; err.textContent = s()[key] }
  goneNotice = false
  err.hidden = true
  const inv = parseInvite($('invite').value)
  if (inv.error) return show(inv.error)
  const name = $('name').value.trim()
  if (!name) return show('errName')
  const btn = $('join-btn')
  btn.disabled = true
  btn.textContent = s().joining
  try {
    const r = await api('POST', '/join', { invite: inv.invite, name })
    if (typeof r.memberKey !== 'string' || typeof r.memberId !== 'string' || typeof r.groupId !== 'string') throw new HttpError(-1)
    membership = { groupId: r.groupId, memberId: r.memberId, memberKey: r.memberKey, invite: inv.invite, groupName: String(r.groupName ?? ''), name, isOwner: false }
    save(KEY, JSON.stringify(membership))
    // 邀請碼別留在網址列（截圖、分享畫面時才不會露出來）
    history.replaceState(null, '', location.pathname)
    render()
    // 加入鈕已經藏起來了：焦點移到群組名稱，讀螢幕的人才知道進來了
    $('group-name').focus()
    await pull()
    schedule()
  } catch (e) {
    // web-5：只用狀態碼挑固定句子（中繼回的文字不上畫面）。邀請錯和群組滿中繼都回 403，分不出來，同一句兩種下一步都寫；
    // 404＝這個網址不是中繼（中繼一定有 /join）：請使用者直接打開朋友傳來的連結
    show(e.status === 403 ? 'err403' : e.status === 429 ? 'err429' : e.status === 0 ? 'errNet' : e.status === 400 ? 'err400' : e.status === 404 ? 'errOtherRelay' : 'errServer')
  } finally {
    btn.disabled = false
    btn.textContent = s().joinBtn
  }
}

async function copyInvite() {
  const link = inviteLink()
  const out = $('copied')
  const box = $('linkbox')
  try {
    await navigator.clipboard.writeText(link)
    out.textContent = s().copiedOk
    box.hidden = true
  } catch {
    out.textContent = s().copyManual
    box.hidden = false
    box.value = link
    box.select()
  }
}

async function leave() {
  const err = $('leave-err')
  err.hidden = true
  $('leave-yes').disabled = true
  try {
    await api('POST', '/leave', {})
    forget(false)
  } catch (e) {
    if (e.status === 401) return forget(false)
    err.hidden = false
    err.textContent = s().leaveErr
  } finally {
    $('leave-yes').disabled = false
    showLeaveConfirm(false)
  }
}
function showLeaveConfirm(on) {
  $('leave').hidden = on
  $('leave-confirm').hidden = !on
  if (on) $('leave-no').focus()
}

// 關分頁：告訴中繼這條連線離線了（其他分頁、外掛的對話不受影響）
function goodbye() {
  if (!membership) return
  api('POST', '/status', { state: 'offline', conn }, true).catch(() => {})
}

function init() {
  $('lang').addEventListener('click', () => {
    lang = lang === 'zh-TW' ? 'en' : 'zh-TW'
    save(LANG_KEY, lang)
    render()
  })
  $('join-form').addEventListener('submit', join)
  $('copy').addEventListener('click', copyInvite)
  $('leave').addEventListener('click', () => showLeaveConfirm(true))
  $('leave-no').addEventListener('click', () => showLeaveConfirm(false))
  $('leave-yes').addEventListener('click', leave)
  document.addEventListener('visibilitychange', () => {
    if (!membership) return
    hiddenSince = document.hidden ? Date.now() : 0
    // 切回來：距上次不滿 15 秒就不馬上送（來回切分頁不會一直打中繼）
    if (!document.hidden && Date.now() - lastPullAt >= PULL_MS) pull()
    schedule()
  })
  addEventListener('pagehide', goodbye)
  addEventListener('pageshow', e => { if (e.persisted && membership) { pull(); schedule() } })
  // 從朋友的邀請連結打開（https://…#邀請碼）：填進去；已經加入了就不動
  if (location.hash.length > 1) {
    const raw = location.hash.slice(1)
    let v = raw
    try { v = decodeURIComponent(raw) } catch { /* 解不開就用原字串，parseInvite 會擋 */ }
    if (!membership) $('invite').value = v
    // 讀進來就從網址列拿掉（截圖、分享畫面時不露出；瀏覽紀錄裡仍會有，見 SECURITY.md）
    history.replaceState(null, '', location.pathname)
  }
  render()
  if (!canStore) {
    const err = $('join-err')
    err.hidden = false
    err.textContent = s().noStorage
  }
  if (membership) { pull(); schedule() }
  else if ($('invite').value) $('name').focus()
}
init()
