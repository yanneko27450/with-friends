// 好友頭像：圓形色塊＋名字第一個字＋狀態環（工作中綠、閒置黃、離線灰）。
// 名字是好友傳來的、不可信：只取第一個字、拿掉控制與雙向字元、XML 跳脫後才放進 SVG。
import type { Presence } from '../types'

// 中間色階配白字，淺色、深色主題都看得清楚（SVG 是圖片，吃不到主題變數）
const FILLS = ['#378ADD', '#7F77DD', '#1D9E75', '#D85A30', '#D4537E', '#BA7517']
const RING: Record<Presence, string> = { working: '#639922', idle: '#EF9F27', offline: '' }
const OFFLINE_FILL = '#888780'

const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? '')

/** 名字的第一個看得到的字（大寫）；沒有就用 ? */
export function initial(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩\s]/g, '')
  const first = Array.from(cleaned)[0] ?? '?'
  return first.toUpperCase()
}

/** 同一個成員永遠同一個顏色 */
export function fillFor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return FILLS[h % FILLS.length] ?? FILLS[0]!
}

export function avatarSvg(id: string, name: string, presence: Presence, size: number): string {
  const r = size / 2
  const ring = RING[presence]
  const inner = ring ? r - 3 : r
  const fill = presence === 'offline' ? OFFLINE_FILL : fillFor(id)
  const font = Math.round(size * 0.42)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    (ring ? `<circle cx="${r}" cy="${r}" r="${r - 1}" fill="none" stroke="${ring}" stroke-width="2"/>` : '') +
    `<circle cx="${r}" cy="${r}" r="${inner - 1}" fill="${fill}"/>` +
    `<text x="${r}" y="${r}" dy="0.35em" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${font}" font-weight="600" fill="#ffffff">${escapeXml(initial(name))}</text>` +
    `</svg>`
  )
}
