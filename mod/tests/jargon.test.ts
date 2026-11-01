import { expect, test } from 'claude-code/testing'
import { STRINGS } from '../hooks/i18n'
import { CHANGELOG } from '../hooks/changelog'

type Collected = { key: string, text: string }

const ZH_JARGON = new RegExp('pane|中繼|釘選|membership', 'i')
const EN_PANE = new RegExp('\\bpane\\b', 'i')

const ARG_SETS: unknown[][] = [
  [],
  ['x'],
  [1],
  [1, 2, 3, 'x'],
  [['a', 'b']],
  ['https://relay.test'],
  ['x', 'y'],
]

const RELAY_ERROR_ARG_SETS: unknown[][] = [[0], [400], [403], [404], [503], [-1], [-2], [-3], [-4], [500]]

const collectInto = (value: unknown, key: string, out: Collected[]): void => {
  if (typeof value === 'string') {
    out.push({ key, text: value })
    return
  }
  if (typeof value === 'function') {
    const fn = value as (...args: unknown[]) => unknown
    const sets = key === 'relayError' ? [...ARG_SETS, ...RELAY_ERROR_ARG_SETS] : ARG_SETS
    for (const args of sets) {
      try {
        collectInto(fn(...args), key, out)
      } catch {
        // 引數不合的呼叫跳過（規格要求吃掉錯誤，只收有回傳的字串）
      }
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectInto(item, key, out)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [name, inner] of Object.entries(value)) {
      collectInto(inner, key ? `${key}.${name}` : name, out)
    }
  }
}

const collect = (value: unknown): Collected[] => {
  const out: Collected[] = []
  collectInto(value, '', out)
  return out
}

// 英文版專用：跳過 installMessage 這一個鍵（N-4 固定承諾句，卡上唯一的例外）
const collectEn = (value: unknown): Collected[] => {
  const out: Collected[] = []
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [name, inner] of Object.entries(value)) {
      if (name === 'installMessage') continue
      collectInto(inner, name, out)
    }
    return out
  }
  collectInto(value, '', out)
  return out
}

test('繁中介面字串不含 pane／中繼／釘選／membership', async () => {
  for (const c of collect(STRINGS['zh-TW'])) {
    expect(c.text, c.key).not.toMatch(ZH_JARGON)
  }
})

test('英文介面字串不含單字 pane（installMessage 除外）', async () => {
  for (const c of collectEn(STRINGS.en)) {
    expect(c.text, c.key).not.toMatch(EN_PANE)
  }
})

test('installMessage 例外還在：英文固定句仍含 pane', async () => {
  expect(STRINGS.en.installMessage).toContain('pane')
})

test('版本紀錄：繁中條目不含術語、英文條目不含單字 pane', async () => {
  for (const entry of CHANGELOG) {
    for (const s of entry.items['zh-TW']) {
      expect(s, `${entry.version} zh-TW`).not.toMatch(ZH_JARGON)
    }
    for (const s of entry.items.en) {
      expect(s, `${entry.version} en`).not.toMatch(EN_PANE)
    }
  }
})

test('掃描器自測：假物件裡的 pane 與中繼會被抓到', async () => {
  const fake = collect({ sample: 'Friends pane', nested: { note: '公開中繼' } })
  let hits = 0
  for (const c of fake) {
    if (ZH_JARGON.test(c.text)) hits += 1
  }
  expect(hits).toBe(2)
})
