import { expect, test } from 'claude-code/testing'
import { PAGER_ARROW_NEXT, PAGER_ARROW_PREV, canNext, canPrev, pageAfterReflow, pageSlice, pagerKey, pagerLabels, pagerLayout, pagerReduce } from '../hooks/presence-pager'
import { cellWidth } from '../hooks/changelog'

const NO_MODS = { ctrl: false, alt: false, meta: false, shift: false }
const TEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

test('箭頭是卡片指定的字，照 1 格算', async () => {
  expect(PAGER_ARROW_PREV).toBe('◀')
  expect(PAGER_ARROW_NEXT).toBe('▶')
  expect(cellWidth(PAGER_ARROW_PREV)).toBe(1)
  expect(cellWidth(PAGER_ARROW_NEXT)).toBe(1)
})

test('pagerLayout 卡片例子：放不下要箭頭', async () => {
  expect(pagerLayout(10, 40, 8, 1, 2)).toEqual({ perPage: 4, pageCount: 3, needsArrows: true })
})

test('pagerLayout 卡片例子：全部放得下不要箭頭', async () => {
  expect(pagerLayout(8, 80, 8, 1, 2)).toEqual({ perPage: 8, pageCount: 1, needsArrows: false })
})

test('pagerLayout total 是 0 時 pageCount 是 1', async () => {
  expect(pagerLayout(0, 40, 8, 1, 2)).toEqual({ perPage: 1, pageCount: 1, needsArrows: false })
  expect(pagerLayout(0, 0, 8, 1, 2)).toEqual({ perPage: 1, pageCount: 1, needsArrows: false })
})

test('pagerLayout 窄到一個項目都放不下時 perPage 至少 1', async () => {
  expect(pagerLayout(3, 5, 8, 1, 2)).toEqual({ perPage: 1, pageCount: 3, needsArrows: true })
})

test('pagerLayout 剛好放得下與少 1 格的臨界', async () => {
  expect(pagerLayout(9, 80, 8, 1, 2)).toEqual({ perPage: 9, pageCount: 1, needsArrows: false })
  expect(pagerLayout(9, 79, 8, 1, 2)).toEqual({ perPage: 8, pageCount: 2, needsArrows: true })
})

test('pagerLayout gap 是 0', async () => {
  expect(pagerLayout(5, 40, 8, 0, 2)).toEqual({ perPage: 5, pageCount: 1, needsArrows: false })
  expect(pagerLayout(6, 40, 8, 0, 2)).toEqual({ perPage: 4, pageCount: 2, needsArrows: true })
})

test('pagerLayout 要箭頭時 perPage 有扣掉兩個箭頭的格數', async () => {
  expect(pagerLayout(10, 44, 8, 1, 2)).toEqual({ perPage: 4, pageCount: 3, needsArrows: true })
  expect(pagerLayout(10, 44, 8, 1, 0)).toEqual({ perPage: 5, pageCount: 2, needsArrows: true })
})

test('pagerLayout itemCells 小於 1 當 1', async () => {
  expect(pagerLayout(3, 10, 0, 0, 0)).toEqual({ perPage: 3, pageCount: 1, needsArrows: false })
  expect(pagerLayout(30, 10, 0, 0, 0)).toEqual({ perPage: 10, pageCount: 3, needsArrows: true })
})

test('pagerLayout 十萬人也不會出事', async () => {
  const layout = pagerLayout(100000, 40, 8, 1, 2)
  expect(layout.perPage).toBe(4)
  expect(layout.pageCount).toBe(25000)
  expect(layout.needsArrows).toBe(true)
})

test('pagerLayout 對 NaN、Infinity、負數、小數不丟例外且結果照正規化', async () => {
  expect(() => pagerLayout(NaN, NaN, NaN, NaN, NaN)).not.toThrow()
  expect(pagerLayout(NaN, 40, 8, 1, 2)).toEqual({ perPage: 1, pageCount: 1, needsArrows: false })
  expect(pagerLayout(10, Infinity, 8, 1, 2)).toEqual({ perPage: 1, pageCount: 10, needsArrows: true })
  expect(pagerLayout(-5, -40, -8, -1, -2)).toEqual({ perPage: 1, pageCount: 1, needsArrows: false })
  expect(pagerLayout(10.9, 40.9, 8.9, 1.9, 2.9)).toEqual({ perPage: 4, pageCount: 3, needsArrows: true })
  expect(pagerLayout(10, 40, 8, 1, 2).perPage).toBeGreaterThanOrEqual(1)
})

test('pageSlice 取出指定一頁', async () => {
  expect(pageSlice(TEN, 0, 4)).toEqual([0, 1, 2, 3])
  expect(pageSlice(TEN, 1, 4)).toEqual([4, 5, 6, 7])
  expect(pageSlice(TEN, 2, 4)).toEqual([8, 9])
})

test('pageSlice 頁碼越界會夾住', async () => {
  expect(pageSlice(TEN, 99, 4)).toEqual([8, 9])
  expect(pageSlice(TEN, -3, 4)).toEqual([0, 1, 2, 3])
  expect(pageSlice(TEN, NaN, 4)).toEqual([0, 1, 2, 3])
})

test('pageSlice perPage 小於 1 當 1、小數捨去', async () => {
  expect(pageSlice(TEN, 2, 0)).toEqual([2])
  expect(pageSlice(TEN, 1, 4.9)).toEqual([4, 5, 6, 7])
  expect(pageSlice(TEN, 0, NaN)).toEqual([0])
})

test('pageSlice 空陣列回空陣列', async () => {
  expect(pageSlice([], 0, 4)).toEqual([])
  expect(pageSlice([], 5, 4)).toHaveLength(0)
})

test('pageSlice 回新陣列且不改傳入陣列（凍結過也行）', async () => {
  const frozen = Object.freeze([1, 2, 3, 4, 5])
  expect(() => pageSlice(frozen, 1, 2)).not.toThrow()
  expect(pageSlice(frozen, 1, 2)).toEqual([3, 4])
  expect(frozen).toEqual([1, 2, 3, 4, 5])
  const out = pageSlice(TEN, 0, 4)
  out.push(99)
  expect(TEN).toHaveLength(10)
})

test('pageAfterReflow 卡片例子', async () => {
  expect(pageAfterReflow(2, 4, 3, 10)).toBe(2)
  expect(pageAfterReflow(2, 4, 8, 10)).toBe(1)
})

test('pageAfterReflow 原本這一頁的第一個人仍然看得見', async () => {
  expect(pageAfterReflow(2, 4, 6, 20)).toBe(1)
  expect(pageSlice([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19], pageAfterReflow(2, 4, 6, 20), 6)).toContain(8)
})

test('pageAfterReflow 越界與 total 是 0', async () => {
  expect(pageAfterReflow(9, 4, 4, 10)).toBe(2)
  expect(pageAfterReflow(2, 4, 3, 0)).toBe(0)
  expect(pageAfterReflow(0, 4, 3, 10)).toBe(0)
})

test('pageAfterReflow 對怪輸入不丟例外，perPage 小於 1 當 1', async () => {
  expect(() => pageAfterReflow(NaN, NaN, NaN, NaN)).not.toThrow()
  expect(pageAfterReflow(NaN, 4, 3, 10)).toBe(0)
  expect(pageAfterReflow(2, 4, 0, 10)).toBe(8)
  expect(pageAfterReflow(-1, 4, 3, 10)).toBe(0)
  expect(pageAfterReflow(1.9, 4, 3, 10)).toBe(1)
})

test('pagerReduce prev 與 next 一般情況', async () => {
  expect(pagerReduce(2, { type: 'prev', pageCount: 4 })).toBe(1)
  expect(pagerReduce(0, { type: 'next', pageCount: 4 })).toBe(1)
  expect(pagerReduce(1.9, { type: 'next', pageCount: 4 })).toBe(2)
})

test('pagerReduce 到頭到尾不繞回', async () => {
  expect(pagerReduce(0, { type: 'prev', pageCount: 4 })).toBe(0)
  expect(pagerReduce(3, { type: 'next', pageCount: 4 })).toBe(3)
})

test('pagerReduce first、last、clamp', async () => {
  expect(pagerReduce(3, { type: 'first', pageCount: 4 })).toBe(0)
  expect(pagerReduce(0, { type: 'last', pageCount: 4 })).toBe(3)
  expect(pagerReduce(99, { type: 'clamp', pageCount: 3 })).toBe(2)
  expect(pagerReduce(1, { type: 'clamp', pageCount: 3 })).toBe(1)
})

test('pagerReduce pageCount 小於 1 當 1、page 不是有限數字當 0', async () => {
  expect(pagerReduce(0, { type: 'next', pageCount: 0 })).toBe(0)
  expect(pagerReduce(0, { type: 'last', pageCount: 1 })).toBe(0)
  expect(pagerReduce(NaN, { type: 'clamp', pageCount: 3 })).toBe(0)
  expect(pagerReduce(NaN, { type: 'prev', pageCount: 3 })).toBe(0)
  expect(pagerReduce(Infinity, { type: 'next', pageCount: 3 })).toBe(1)
})

test('pagerReduce 不改傳入的 action（凍結過也行）', async () => {
  const action = Object.freeze({ type: 'next' as const, pageCount: 3 })
  expect(pagerReduce(0, action)).toBe(1)
  expect(action).toEqual({ type: 'next', pageCount: 3 })
})

test('canPrev 與 canNext', async () => {
  expect(canPrev(0)).toBe(false)
  expect(canPrev(1)).toBe(true)
  expect(canPrev(-1)).toBe(false)
  expect(canNext(0, 3)).toBe(true)
  expect(canNext(1, 3)).toBe(true)
  expect(canNext(2, 3)).toBe(false)
  expect(canNext(0, 1)).toBe(false)
  expect(canNext(0, 0)).toBe(false)
  expect(canNext(NaN, NaN)).toBe(false)
})

test('pagerKey 沒有修飾鍵時的對應', async () => {
  expect(pagerKey('ArrowLeft', NO_MODS)).toBe('prev')
  expect(pagerKey('Left', NO_MODS)).toBe('prev')
  expect(pagerKey('ArrowRight', NO_MODS)).toBe('next')
  expect(pagerKey('Right', NO_MODS)).toBe('next')
  expect(pagerKey('Home', NO_MODS)).toBe('first')
  expect(pagerKey('End', NO_MODS)).toBe('last')
})

test('pagerKey 其他按鍵回 null', async () => {
  expect(pagerKey('a', NO_MODS)).toBe(null)
  expect(pagerKey('', NO_MODS)).toBe(null)
  expect(pagerKey('arrowleft', NO_MODS)).toBe(null)
  expect(pagerKey('PageDown', NO_MODS)).toBe(null)
})

test('pagerKey 有任何修飾鍵一律 null（四種各一）', async () => {
  expect(pagerKey('ArrowRight', { ctrl: true, alt: false, meta: false, shift: false })).toBe(null)
  expect(pagerKey('ArrowLeft', { ctrl: false, alt: true, meta: false, shift: false })).toBe(null)
  expect(pagerKey('Home', { ctrl: false, alt: false, meta: true, shift: false })).toBe(null)
  expect(pagerKey('End', { ctrl: false, alt: false, meta: false, shift: true })).toBe(null)
})

test('pagerKey key 不是字串回 null、mods 凍結過也行', async () => {
  expect(pagerKey(123 as unknown as string, NO_MODS)).toBe(null)
  expect(pagerKey(undefined as unknown as string, NO_MODS)).toBe(null)
  expect(pagerKey('ArrowLeft', Object.freeze({ ctrl: false, alt: false, meta: false, shift: false }))).toBe('prev')
})

test('pagerLabels 英文', async () => {
  expect(pagerLabels('en', 1, 4)).toEqual({ prev: 'Show earlier friends', next: 'Show more friends', position: 'Page 2 of 4' })
  expect(pagerLabels('en', 0, 4).position).toBe('Page 1 of 4')
})

test('pagerLabels 繁中', async () => {
  expect(pagerLabels('zh-TW', 1, 4)).toEqual({ prev: '看前面的朋友', next: '看後面的朋友', position: '第 2 頁，共 4 頁' })
  expect(pagerLabels('zh-TW', 3, 4).position).toBe('第 4 頁，共 4 頁')
})

test('pagerLabels 只有一頁時 position 是空字串', async () => {
  expect(pagerLabels('en', 0, 1).position).toBe('')
  expect(pagerLabels('zh-TW', 0, 1).position).toBe('')
  expect(pagerLabels('en', 0, 0).position).toBe('')
})

test('pagerLabels 頁碼正規化', async () => {
  expect(pagerLabels('en', 1.9, 4).position).toBe('Page 2 of 4')
  expect(pagerLabels('en', -2, 4).position).toBe('Page 1 of 4')
  expect(pagerLabels('en', NaN, 4).position).toBe('Page 1 of 4')
})

test('pagerLabels 每個字串都在 40 格以內', async () => {
  const cases: Array<[string, number, number]> = [['en', 1, 4], ['zh-TW', 1, 4], ['en', 999, 1000], ['zh-TW', 999, 1000], ['en', 0, 1], ['zh-TW', 0, 1]]
  for (const [lang, page, count] of cases) {
    const labels = pagerLabels(lang as 'en' | 'zh-TW', page, count)
    expect(cellWidth(labels.prev)).toBeLessThanOrEqual(40)
    expect(cellWidth(labels.next)).toBeLessThanOrEqual(40)
    expect(cellWidth(labels.position)).toBeLessThanOrEqual(40)
  }
})
