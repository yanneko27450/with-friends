import { expect, test } from 'claude-code/testing'
import { DEMO_BOT_ENABLED, DEMO_BOT_ID, DEMO_BOT_SHOW_BELOW, demoBot, isDemoBot, withDemoBot } from '../hooks/demo-bot'
import { ACTIONS, SUBJECTS } from '../hooks/taxonomy'
import type { Friend } from '../types'

function friend(id: string, over: Partial<Friend> = {}): Friend {
  return {
    id,
    name: id,
    isMe: false,
    isOwner: false,
    presence: 'working',
    action: 'building-features',
    subject: 'website',
    activityAgoSec: 0,
    seenAgoSec: 0,
    ...over,
  }
}

function realFriends(n: number): Friend[] {
  return ['Ann', 'Bob', 'Cid', 'Dee', 'Eli', 'Fay'].map((name) => friend('f-' + name.toLowerCase(), { name })).slice(0, n)
}

test('DEMO_BOT_ID 是 demo-bot，isDemoBot 只認這個 id', () => {
  expect(DEMO_BOT_ID).toBe('demo-bot')
  expect(isDemoBot({ id: 'demo-bot' })).toBe(true)
  expect(isDemoBot({ id: 'demo-bot2' })).toBe(false)
  expect(isDemoBot({ id: '' })).toBe(false)
})

test('DEMO_BOT_ENABLED 是 boolean，目前為 true', () => {
  expect(typeof DEMO_BOT_ENABLED).toBe('boolean')
  expect(DEMO_BOT_ENABLED).toBe(true)
})

test('DEMO_BOT_SHOW_BELOW 目前是 3，人數改變時這條會先變紅提醒', () => {
  expect(DEMO_BOT_SHOW_BELOW).toBe(3)
})

test('demoBot 是純函式：同一個 nowMs 多次呼叫結果相同（兩種語言各測）', () => {
  for (const lang of ['en', 'zh-TW'] as const) {
    const first = demoBot(lang, 20000 * 7 + 5000)
    expect(demoBot(lang, 20000 * 7 + 5000)).toEqual(first)
    expect(demoBot(lang, 20000 * 7 + 5000)).toEqual(first)
  }
})

test('demoBot 的固定欄位是 id、isMe false、isOwner false、presence working、seenAgoSec 0', () => {
  const bot = demoBot('en', 123456)
  expect(bot.id).toBe(DEMO_BOT_ID)
  expect(bot.isMe).toBe(false)
  expect(bot.isOwner).toBe(false)
  expect(bot.presence).toBe('working')
  expect(bot.seenAgoSec).toBe(0)
})

test('demoBot 的名字依語言切換，而且都含 Robot 或機器人字樣', () => {
  expect(demoBot('en', 0).name).toBe('Robot (demo)')
  expect(demoBot('zh-TW', 0).name).toBe('機器人（示範）')
  expect(demoBot('en', 0).name).toContain('Robot')
  expect(demoBot('zh-TW', 0).name).toContain('機器人')
})

test('每個 20 秒區間的 action 與 subject 都在清單內，而且不是 other', () => {
  for (let nowMs = 0; nowMs <= 500000; nowMs += 20000) {
    const bot = demoBot('en', nowMs)
    expect(ACTIONS).toContain(bot.action)
    expect(bot.action).not.toBe('other')
    expect(SUBJECTS).toContain(bot.subject)
    expect(bot.subject).not.toBe('other')
  }
})

test('同一個區間內 action 與 subject 不變，跨到下一個區間兩者都換', () => {
  const start = demoBot('en', 20000 * 7)
  const end = demoBot('en', 20000 * 7 + 19999)
  expect(end.action).toBe(start.action)
  expect(end.subject).toBe(start.subject)
  const next = demoBot('en', 20000 * 8)
  expect(next.action).not.toBe(start.action)
  expect(next.subject).not.toBe(start.subject)
})

test('輪播照清單順序（去掉 other）走，而且會走遍全部 action 與 subject', () => {
  const actions = ACTIONS.filter((a) => a !== 'other')
  const subjects = SUBJECTS.filter((s) => s !== 'other')
  for (let step = 0; step < actions.length; step++) {
    expect(demoBot('en', 20000 * step).action).toBe(actions[step])
  }
  for (let step = 0; step < subjects.length; step++) {
    expect(demoBot('en', 20000 * step).subject).toBe(subjects[step])
  }
  for (let step = 0; step < actions.length; step++) {
    expect(demoBot('en', 20000 * (step + actions.length)).action).toBe(actions[step])
  }
  for (let step = 0; step < subjects.length; step++) {
    expect(demoBot('en', 20000 * (step + subjects.length)).subject).toBe(subjects[step])
  }
})

test('activityAgoSec 等於區間內已過的秒數，永遠是 0 到 19 的整數', () => {
  expect(demoBot('en', 20000 * 5).activityAgoSec).toBe(0)
  expect(demoBot('en', 20000 * 5 + 1000).activityAgoSec).toBe(1)
  expect(demoBot('en', 20000 * 5 + 19999).activityAgoSec).toBe(19)
  for (let nowMs = 0; nowMs <= 200000; nowMs += 1379) {
    const sec = demoBot('en', nowMs).activityAgoSec
    if (sec === null) throw new Error('activityAgoSec should not be null')
    expect(sec % 1).toBe(0)
    expect(sec).toBeGreaterThanOrEqual(0)
    expect(sec).toBeLessThanOrEqual(19)
  }
})

test('真好友少於 SHOW_BELOW 時，withDemoBot 在最後補上機器人，且不改動傳入陣列', () => {
  const real = realFriends(DEMO_BOT_SHOW_BELOW - 1)
  const snapshot = [...real]
  const out = withDemoBot(real, 'en', 0)
  expect(out).not.toBe(real)
  expect(out).toHaveLength(real.length + 1)
  expect(out.slice(0, real.length)).toEqual(real)
  expect(out.slice(-1).map((f) => f.id)).toEqual([DEMO_BOT_ID])
  expect(real).toEqual(snapshot)
  expect(real).toHaveLength(snapshot.length)
})

test('沒有真好友時，withDemoBot 只回傳機器人一個', () => {
  const out = withDemoBot([], 'zh-TW', 0)
  expect(out).toHaveLength(1)
  expect(out.map((f) => f.id)).toEqual([DEMO_BOT_ID])
})

test('真好友剛好等於或多於 SHOW_BELOW 時，withDemoBot 原樣回傳不加機器人', () => {
  const exact = realFriends(DEMO_BOT_SHOW_BELOW)
  expect(withDemoBot(exact, 'en', 0)).toBe(exact)
  const more = realFriends(DEMO_BOT_SHOW_BELOW + 1)
  expect(withDemoBot(more, 'en', 0)).toBe(more)
})

test('自己不算真好友：只有自己時會加機器人，自己加滿 SHOW_BELOW 位真好友時不加', () => {
  const me = friend('me', { isMe: true, isOwner: true })
  const meOnly = withDemoBot([me], 'zh-TW', 0)
  expect(meOnly).toHaveLength(2)
  expect(meOnly.map((f) => f.id)).toContain(DEMO_BOT_ID)
  const fewer = [me, ...realFriends(DEMO_BOT_SHOW_BELOW - 1)]
  expect(withDemoBot(fewer, 'en', 0).map((f) => f.id)).toContain(DEMO_BOT_ID)
  const full = [me, ...realFriends(DEMO_BOT_SHOW_BELOW)]
  expect(withDemoBot(full, 'en', 0)).toBe(full)
})

test('已經有機器人時不再加第二個，機器人也不算進真好友人數', () => {
  const bot = demoBot('en', 0)
  const full = [...realFriends(DEMO_BOT_SHOW_BELOW), bot]
  expect(withDemoBot(full, 'en', 0)).toBe(full)
  const fewer = [...realFriends(DEMO_BOT_SHOW_BELOW - 1), bot]
  expect(withDemoBot(fewer, 'en', 0)).toBe(fewer)
  expect(withDemoBot(fewer, 'en', 0).filter(isDemoBot)).toHaveLength(1)
})

test('withDemoBot：isHidden 傳 true 時原樣回傳，不加示範機器人（兩種語言）', () => {
  for (const lang of ['en', 'zh-TW'] as const) {
    const real = realFriends(DEMO_BOT_SHOW_BELOW - 1)
    expect(withDemoBot(real, lang, 0, true)).toBe(real)
    const empty: Friend[] = []
    expect(withDemoBot(empty, lang, 0, true)).toBe(empty)
  }
})

test('withDemoBot：isHidden 傳 false 與不傳第四個參數結果相同，照舊加示範機器人', () => {
  const real = realFriends(DEMO_BOT_SHOW_BELOW - 1)
  const withFalse = withDemoBot(real, 'en', 0, false)
  expect(withFalse).toEqual(withDemoBot(real, 'en', 0))
  expect(withFalse.filter(isDemoBot)).toHaveLength(1)
  expect(withFalse).toHaveLength(real.length + 1)
})
