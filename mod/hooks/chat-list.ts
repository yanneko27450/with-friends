// mod/hooks/chat-list.ts
// Chat tab message list helpers: ordering, time labels, one-line truncation.
// Pure functions only: no storage, no console, no side effects.
import { cellWidth } from './changelog'
import type { ChatViewMessage, Lang } from './chat-types'

function effectiveSentAt(msg: ChatViewMessage): number {
  return Number.isFinite(msg.sentAt) ? msg.sentAt : 0
}

export function sortMessages(msgs: readonly ChatViewMessage[]): ChatViewMessage[] {
  const seen = new Set<string>()
  const out: ChatViewMessage[] = []
  for (const msg of msgs) {
    if (seen.has(msg.id)) continue
    seen.add(msg.id)
    out.push(msg)
  }
  out.sort((a, b) => {
    const ka = effectiveSentAt(a)
    const kb = effectiveSentAt(b)
    if (ka !== kb) return ka - kb
    if (a.id < b.id) return -1
    if (a.id > b.id) return 1
    return 0
  })
  return out
}

type LocalParts = { y: number; m: number; d: number; hh: number; mm: number }

function localParts(ms: number, tzOffsetMin: number): LocalParts {
  const shifted = new Date(ms + tzOffsetMin * 60000)
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatMessageTime(sentAt: number, nowMs: number, lang: Lang, tzOffsetMin: number): string {
  const justNow = lang === 'zh-TW' ? '剛剛' : 'Just now'
  if (!Number.isFinite(sentAt)) return justNow
  if (nowMs - sentAt < 60000) return justNow
  const sent = localParts(sentAt, tzOffsetMin)
  const now = localParts(nowMs, tzOffsetMin)
  if (Number.isNaN(sent.y) || Number.isNaN(now.y)) return justNow
  const hm = pad2(sent.hh) + ':' + pad2(sent.mm)
  if (sent.y === now.y && sent.m === now.m && sent.d === now.d) return hm
  const prev = new Date(Date.UTC(now.y, now.m, now.d - 1))
  if (sent.y === prev.getUTCFullYear() && sent.m === prev.getUTCMonth() && sent.d === prev.getUTCDate()) {
    return lang === 'zh-TW' ? '昨天 ' + hm : 'Yesterday ' + hm
  }
  if (sent.y === now.y) return pad2(sent.m + 1) + '/' + pad2(sent.d) + ' ' + hm
  return String(sent.y) + '/' + pad2(sent.m + 1) + '/' + pad2(sent.d)
}

export function truncateToCells(text: string, maxCells: number): string {
  if (!Number.isFinite(maxCells) || maxCells <= 0) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (cellWidth(flat) <= maxCells) return flat
  let out = ''
  let width = 0
  for (const ch of flat) {
    const w = cellWidth(ch)
    if (width + w + 1 > maxCells) break
    out += ch
    width += w
  }
  return out + '…'
}

export function formatMessageLine(msg: ChatViewMessage, nowMs: number, lang: Lang, tzOffsetMin: number, maxCells: number): string {
  const name = msg.isMe ? (lang === 'zh-TW' ? '你' : 'You') : truncateToCells(msg.senderName, 12)
  const line = formatMessageTime(msg.sentAt, nowMs, lang, tzOffsetMin) + '  ' + name + ': ' + msg.text
  return truncateToCells(line, maxCells)
}

export function tailWindow(sorted: readonly ChatViewMessage[], maxRows: number): { shown: ChatViewMessage[]; hiddenOlder: number } {
  if (!Number.isFinite(maxRows) || maxRows <= 0) return { shown: [], hiddenOlder: sorted.length }
  const n = Math.floor(maxRows)
  if (n >= sorted.length) return { shown: [...sorted], hiddenOlder: 0 }
  return { shown: sorted.slice(sorted.length - n), hiddenOlder: sorted.length - n }
}
