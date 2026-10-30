// 好友頭像：圓形色塊＋名字第一個字＋狀態環（工作中綠、閒置黃、離線灰）。
// 名字是好友傳來的、不可信：只取第一個字、拿掉控制與雙向字元、XML 跳脫後才放進 SVG。
import type { Presence } from '../types'
import type { Avatar } from './taxonomy'
import { AVATAR_ART } from './avatar-art'

/** ui-22：頭像代碼 → 表情符號。pane 的圖改用 avatar-art.ts（ui-22b）；表情符號留給終端機那行和指令回覆 */
export const AVATAR_EMOJI: Record<Avatar, string> = {
  cat: '🐱', dog: '🐶', fox: '🦊', panda: '🐼', rabbit: '🐰', bear: '🐻', koala: '🐨', tiger: '🐯',
  lion: '🦁', frog: '🐸', owl: '🦉', penguin: '🐧', octopus: '🐙', whale: '🐳', unicorn: '🦄', robot: '🤖',
}

// 中間色階配白字，淺色、深色主題都看得清楚（SVG 是圖片，吃不到主題變數）
const FILLS = ['#378ADD', '#7F77DD', '#1D9E75', '#D85A30', '#D4537E', '#BA7517']
const RING: Record<Presence, string> = { working: '#639922', idle: '#EF9F27', offline: '' }
const OFFLINE_FILL = '#888780'

// 沒成對的代理字元和 U+FFFE／U+FFFF 在 XML 裡不合法，整張 SVG 會畫不出來（a11y-1 審查）：先拿掉。
// 解析器讀不了正規表示式字面值裡的 \u，所以用 new RegExp
const NOT_XML = new RegExp('[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]|[\\ufffe\\uffff]', 'g')
const escapeXml = (s: string) =>
  s.replace(NOT_XML, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? '')

/** 名字的第一個看得到的字（大寫）；沒有就用 ? */
export function initial(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩\s]/g, '')
  const first = Array.from(cleaned)[0] ?? '?'
  return first.toUpperCase()
}

/** 同一個成員永遠同一個顏色：回 FILLS 的第幾個（移除確認框用它說「藍色頭像」，見 register.tsx removeWho） */
export function fillIndexFor(id: string): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % FILLS.length
}

/** 同一個成員永遠同一個顏色 */
export function fillFor(id: string): string {
  return FILLS[fillIndexFor(id)] ?? FILLS[0]!
}

// ui-8（主人 10-12 選「像 Spotify 好友動態」的版面）：不畫外環，改在右上角一個小點（工作中綠、閒置黃、離線不畫）
// 顏色沿用自己的狀態色，不用對方的品牌綠（主人問「不會有做太像被罵的風險吧」）
const DOT: Record<Presence, string> = { working: RING.working, idle: RING.idle, offline: '' }

/**
 * 有選頭像（清單內代碼）就畫主人選的線稿圓框圖（ui-22b，avatar-art.ts），沒有就照舊畫名字第一個字。
 * 狀態照舊：dot＝右上小點（工作中綠、閒置黃）、ring＝外環；離線＝灰底上把整張圖淡掉（不用濾鏡，SVG 裡不出現 url(）
 */
export function avatarSvg(id: string, name: string, presence: Presence, size: number, mark: 'ring' | 'dot' = 'ring', avatar?: Avatar, label?: string): string {
  const r = size / 2
  // a11y-1：圖本身也帶文字（<title>），跟元件的 alt 一樣；SVG 被單獨拿出去看時也讀得到
  const title = label ? `<title>${escapeXml(label)}</title>` : ''
  const art = avatar ? AVATAR_ART[avatar] : undefined
  if (art) {
    const dot = mark === 'dot' ? DOT[presence] : ''
    const ring = mark === 'ring' ? RING[presence] : ''
    const d = Math.max(4, Math.round(size * 0.14))
    const isOffline = presence === 'offline'
    // ring 樣式外圈留 3px 畫狀態環，圖縮在裡面
    const pad = ring ? 3 : 0
    const inner = art.replace('<svg ', `<svg x="${pad}" y="${pad}" width="${size - 2 * pad}" height="${size - 2 * pad}" `)
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` + title +
      (ring ? `<circle cx="${r}" cy="${r}" r="${r - 1}" fill="none" stroke="${ring}" stroke-width="2"/>` : '') +
      (isOffline ? `<circle cx="${r}" cy="${r}" r="${r - 1 - pad}" fill="${OFFLINE_FILL}"/><g opacity="0.4">${inner}</g>` : inner) +
      (dot ? `<circle cx="${size - d - 1}" cy="${d + 1}" r="${d}" fill="${dot}" stroke="#ffffff" stroke-width="1.5"/>` : '') +
      `</svg>`
    )
  }
  if (mark === 'dot') {
    const dot = DOT[presence]
    const d = Math.max(4, Math.round(size * 0.14))
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` + title +
      `<circle cx="${r}" cy="${r}" r="${r - 1}" fill="${presence === 'offline' ? OFFLINE_FILL : fillFor(id)}"/>` +
      `<text x="${r}" y="${r}" dy="0.35em" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${Math.round(size * 0.4)}" font-weight="700" fill="#ffffff">${escapeXml(initial(name))}</text>` +
      (dot ? `<circle cx="${size - d - 1}" cy="${d + 1}" r="${d}" fill="${dot}" stroke="#ffffff" stroke-width="1.5"/>` : '') +
      `</svg>`
    )
  }
  const ring = RING[presence]
  const inner = ring ? r - 3 : r
  const fill = presence === 'offline' ? OFFLINE_FILL : fillFor(id)
  const font = Math.round(size * 0.42)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` + title +
    (ring ? `<circle cx="${r}" cy="${r}" r="${r - 1}" fill="none" stroke="${ring}" stroke-width="2"/>` : '') +
    `<circle cx="${r}" cy="${r}" r="${inner - 1}" fill="${fill}"/>` +
    `<text x="${r}" y="${r}" dy="0.35em" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${font}" font-weight="600" fill="#ffffff">${escapeXml(initial(name))}</text>` +
    `</svg>`
  )
}
