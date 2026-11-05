import type { Lang } from './chat-types'

/** 終端機版的箭頭字（桌面版用圖示，不用這個）。單格字元；東亞寬字體下 ◀ ▶ 可能被畫成 2 格，實作部會實測，這裡照 1 格算 */
export const PAGER_ARROW_PREV = '◀'
export const PAGER_ARROW_NEXT = '▶'

export type PagerLayout = Readonly<{ perPage: number; pageCount: number; needsArrows: boolean }>

export type PagerAction = Readonly<{ type: 'prev' | 'next' | 'first' | 'last' | 'clamp'; pageCount: number }>

const normInt = (v: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0
  return Math.floor(v)
}

const normPerPage = (v: number): number => Math.max(1, normInt(v))

const normPageCount = (v: number): number => Math.max(1, normInt(v))

const clampPage = (page: number, pageCount: number): number => Math.min(Math.max(page, 0), pageCount - 1)

export function pagerLayout(total: number, widthCells: number, itemCells: number, gapCells: number, arrowCells: number): PagerLayout {
  const t = normInt(total)
  const width = normInt(widthCells)
  const item = normPerPage(itemCells)
  const gap = normInt(gapCells)
  const arrow = normInt(arrowCells)
  const fitAll = Math.floor((width + gap) / (item + gap))
  if (t <= fitAll) return { perPage: Math.max(1, t), pageCount: 1, needsArrows: false }
  const usable = Math.max(0, width - 2 * arrow)
  const perPage = Math.max(1, Math.floor((usable + gap) / (item + gap)))
  return { perPage, pageCount: Math.ceil(t / perPage), needsArrows: true }
}

export function pageSlice<T>(items: readonly T[], page: number, perPage: number): T[] {
  const per = normPerPage(perPage)
  if (items.length === 0) return []
  const pageCount = Math.ceil(items.length / per)
  const p = clampPage(normInt(page), pageCount)
  return items.slice(p * per, p * per + per)
}

export function pageAfterReflow(oldPage: number, oldPerPage: number, newPerPage: number, total: number): number {
  const per = normPerPage(newPerPage)
  const firstIndex = normInt(oldPage) * normPerPage(oldPerPage)
  const maxPage = Math.max(0, Math.ceil(normInt(total) / per) - 1)
  return Math.min(Math.floor(firstIndex / per), maxPage)
}

export function pagerReduce(page: number, action: PagerAction): number {
  const pageCount = normPageCount(action.pageCount)
  const p = normInt(page)
  if (action.type === 'first') return 0
  if (action.type === 'last') return pageCount - 1
  if (action.type === 'prev') return clampPage(p - 1, pageCount)
  if (action.type === 'next') return clampPage(p + 1, pageCount)
  return clampPage(p, pageCount)
}

export const canPrev: (page: number) => boolean = (page) => normInt(page) > 0

export const canNext: (page: number, pageCount: number) => boolean = (page, pageCount) => normInt(page) < normPageCount(pageCount) - 1

export function pagerKey(key: string, mods: Readonly<{ ctrl: boolean; alt: boolean; meta: boolean; shift: boolean }>): 'prev' | 'next' | 'first' | 'last' | null {
  if (typeof key !== 'string') return null
  if (mods && (mods.ctrl || mods.alt || mods.meta || mods.shift)) return null
  if (key === 'ArrowLeft' || key === 'Left') return 'prev'
  if (key === 'ArrowRight' || key === 'Right') return 'next'
  if (key === 'Home') return 'first'
  if (key === 'End') return 'last'
  return null
}

export function pagerLabels(lang: Lang, page: number, pageCount: number): { prev: string; next: string; position: string } {
  const p = normInt(page)
  const count = normPageCount(pageCount)
  const zh = lang === 'zh-TW'
  const prev = zh ? '看前面的朋友' : 'Show earlier friends'
  const next = zh ? '看後面的朋友' : 'Show more friends'
  const position = count <= 1 ? '' : zh ? `第 ${p + 1} 頁，共 ${count} 頁` : `Page ${p + 1} of ${count}`
  return { prev, next, position }
}
