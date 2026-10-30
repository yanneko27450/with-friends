// Demo friend, drawn only in the local pane so an almost-empty group still
// shows what the product looks like. It never goes through the relay and is
// not a group member. To remove the feature, delete this file and its call
// site; setting DEMO_BOT_ENABLED to false switches it off.
import { ACTIONS, SUBJECTS, type Lang } from './taxonomy'
import type { Friend } from '../types'

export const DEMO_BOT_ENABLED = true

export const DEMO_BOT_ID = 'demo-bot'

export const DEMO_BOT_SHOW_BELOW = 3

const ROTATE_MS = 20000

const ROTATION_ACTIONS = ACTIONS.filter((a) => a !== 'other')
const ROTATION_SUBJECTS = SUBJECTS.filter((s) => s !== 'other')

export function isDemoBot(f: { id: string }): boolean {
  return f.id === DEMO_BOT_ID
}

export function demoBot(lang: Lang, nowMs: number): Friend {
  const step = Math.floor(nowMs / ROTATE_MS)
  return {
    id: DEMO_BOT_ID,
    name: lang === 'zh-TW' ? '機器人（示範）' : 'Robot (demo)',
    isMe: false,
    isOwner: false,
    presence: 'working',
    action: ROTATION_ACTIONS[step % ROTATION_ACTIONS.length]!,
    subject: ROTATION_SUBJECTS[step % ROTATION_SUBJECTS.length]!,
    activityAgoSec: Math.floor((nowMs % ROTATE_MS) / 1000),
    seenAgoSec: 0,
  }
}

export function withDemoBot(real: Friend[], lang: Lang, nowMs: number, isHidden = false): Friend[] {
  if (!DEMO_BOT_ENABLED) return real
  if (isHidden) return real
  if (real.some(isDemoBot)) return real
  const realCount = real.filter((f) => !f.isMe && !isDemoBot(f)).length
  if (realCount >= DEMO_BOT_SHOW_BELOW) return real
  return [...real, demoBot(lang, nowMs)]
}
