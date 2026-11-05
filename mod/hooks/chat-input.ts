// mod/hooks/chat-input.ts
// Chat input box state machine: draft text, send lock, failure handling.
// The draft lives only in this in-memory state; nothing is stored here.
import { CHAT_MAX_TEXT_BYTES } from './chat-types'

export type ChatInputStatus = 'idle' | 'sending' | 'failed'
export type ChatInputState = Readonly<{ draft: string; status: ChatInputStatus }>
export type ChatInputAction =
  | { type: 'edit'; text: string }
  | { type: 'send' }
  | { type: 'sent' }
  | { type: 'failed' }
  | { type: 'clear' }

export const INITIAL_INPUT: ChatInputState = { draft: '', status: 'idle' }

export function inputInfo(draft: string): { bytes: number; remaining: number; tooLong: boolean; isBlank: boolean } {
  const trimmed = draft.trim()
  const bytes = new TextEncoder().encode(trimmed).length
  return {
    bytes,
    remaining: CHAT_MAX_TEXT_BYTES - bytes,
    tooLong: bytes > CHAT_MAX_TEXT_BYTES,
    isBlank: trimmed.length === 0,
  }
}

export function canSend(state: ChatInputState): boolean {
  if (state.status === 'sending') return false
  const info = inputInfo(state.draft)
  return !info.isBlank && !info.tooLong
}

export function reduceInput(state: ChatInputState, action: ChatInputAction): ChatInputState {
  switch (action.type) {
    case 'edit':
      if (state.status === 'sending') return state
      return { draft: action.text, status: 'idle' }
    case 'send':
      if (!canSend(state)) return state
      return { draft: state.draft, status: 'sending' }
    case 'sent':
      if (state.status !== 'sending') return state
      return { draft: '', status: 'idle' }
    case 'failed':
      if (state.status !== 'sending') return state
      return { draft: state.draft, status: 'failed' }
    case 'clear':
      if (state.status === 'sending') return state
      return { draft: '', status: 'idle' }
  }
  return state
}
