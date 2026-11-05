import { expect, test } from 'claude-code/testing'
import { INITIAL_INPUT, canSend, inputInfo, reduceInput } from '../hooks/chat-input'
import type { ChatInputState } from '../hooks/chat-input'

const idle: ChatInputState = { draft: 'hi', status: 'idle' }
const sending: ChatInputState = { draft: 'hi', status: 'sending' }
const failed: ChatInputState = { draft: 'hi', status: 'failed' }

test('INITIAL_INPUT 是空草稿、狀態 idle', () => {
  expect(INITIAL_INPUT).toEqual({ draft: '', status: 'idle' })
})

test('reduceInput 在 idle 狀態下處理五種 action', () => {
  expect(reduceInput(idle, { type: 'edit', text: 'new' })).toEqual({ draft: 'new', status: 'idle' })
  expect(reduceInput(idle, { type: 'send' })).toEqual({ draft: 'hi', status: 'sending' })
  expect(reduceInput(idle, { type: 'sent' })).toBe(idle)
  expect(reduceInput(idle, { type: 'failed' })).toBe(idle)
  expect(reduceInput(idle, { type: 'clear' })).toEqual({ draft: '', status: 'idle' })
})

test('reduceInput 在 sending 狀態下鎖住草稿，只接受 sent 與 failed', () => {
  expect(reduceInput(sending, { type: 'edit', text: 'new' })).toBe(sending)
  expect(reduceInput(sending, { type: 'send' })).toBe(sending)
  expect(reduceInput(sending, { type: 'sent' })).toEqual({ draft: '', status: 'idle' })
  expect(reduceInput(sending, { type: 'failed' })).toEqual({ draft: 'hi', status: 'failed' })
  expect(reduceInput(sending, { type: 'clear' })).toBe(sending)
})

test('reduceInput 在 failed 狀態下處理五種 action：改字回到 idle，可以重送', () => {
  expect(reduceInput(failed, { type: 'edit', text: 'new' })).toEqual({ draft: 'new', status: 'idle' })
  expect(reduceInput(failed, { type: 'send' })).toEqual({ draft: 'hi', status: 'sending' })
  expect(reduceInput(failed, { type: 'sent' })).toBe(failed)
  expect(reduceInput(failed, { type: 'failed' })).toBe(failed)
  expect(reduceInput(failed, { type: 'clear' })).toEqual({ draft: '', status: 'idle' })
})

test('reduceInput 的 send 在空白或過長時原樣回傳', () => {
  const blank: ChatInputState = { draft: '   ', status: 'idle' }
  expect(reduceInput(blank, { type: 'send' })).toBe(blank)
  const tooLong: ChatInputState = { draft: 'a'.repeat(2001), status: 'idle' }
  expect(reduceInput(tooLong, { type: 'send' })).toBe(tooLong)
  const empty: ChatInputState = { draft: '', status: 'idle' }
  expect(reduceInput(empty, { type: 'send' })).toBe(empty)
})

test('reduceInput 不修改傳入的 state', () => {
  const frozen = Object.freeze({ draft: 'hi', status: 'idle' } as ChatInputState)
  reduceInput(frozen, { type: 'edit', text: 'new' })
  reduceInput(frozen, { type: 'send' })
  reduceInput(frozen, { type: 'clear' })
  expect(frozen).toEqual({ draft: 'hi', status: 'idle' })
})

test('完整流程：edit 後 send，failed 後草稿還在，edit 再 send，最後 sent 清空', () => {
  let s = reduceInput(INITIAL_INPUT, { type: 'edit', text: 'hello' })
  expect(s).toEqual({ draft: 'hello', status: 'idle' })
  s = reduceInput(s, { type: 'send' })
  expect(s).toEqual({ draft: 'hello', status: 'sending' })
  s = reduceInput(s, { type: 'failed' })
  expect(s).toEqual({ draft: 'hello', status: 'failed' })
  s = reduceInput(s, { type: 'edit', text: 'hello again' })
  expect(s).toEqual({ draft: 'hello again', status: 'idle' })
  s = reduceInput(s, { type: 'send' })
  expect(s).toEqual({ draft: 'hello again', status: 'sending' })
  s = reduceInput(s, { type: 'sent' })
  expect(s).toEqual({ draft: '', status: 'idle' })
})

test('inputInfo 用 trim 後的 UTF-8 位元組數計算（卡片例子）', () => {
  expect(inputInfo('a'.repeat(2000))).toEqual({ bytes: 2000, remaining: 0, tooLong: false, isBlank: false })
  expect(inputInfo('a'.repeat(2001)).tooLong).toBe(true)
  expect(inputInfo('a'.repeat(2001)).remaining).toBe(-1)
  expect(inputInfo('你'.repeat(666))).toEqual({ bytes: 1998, remaining: 2, tooLong: false, isBlank: false })
  expect(inputInfo('你'.repeat(667)).bytes).toBe(2001)
  expect(inputInfo('你'.repeat(667)).tooLong).toBe(true)
  expect(inputInfo('😀'.repeat(500))).toEqual({ bytes: 2000, remaining: 0, tooLong: false, isBlank: false })
  expect(inputInfo('😀'.repeat(501)).tooLong).toBe(true)
  expect(inputInfo('  hi  ').bytes).toBe(2)
})

test('inputInfo 的空白判斷與位元組邊界 1999', () => {
  expect(inputInfo('   \n ')).toEqual({ bytes: 0, remaining: 2000, tooLong: false, isBlank: true })
  expect(inputInfo('')).toEqual({ bytes: 0, remaining: 2000, tooLong: false, isBlank: true })
  expect(inputInfo('a'.repeat(1999)).bytes).toBe(1999)
  expect(inputInfo('a'.repeat(1999)).tooLong).toBe(false)
})

test('canSend 依狀態、空白與長度判斷', () => {
  expect(canSend({ draft: 'hi', status: 'idle' })).toBe(true)
  expect(canSend({ draft: 'hi', status: 'failed' })).toBe(true)
  expect(canSend({ draft: 'hi', status: 'sending' })).toBe(false)
  expect(canSend({ draft: '   ', status: 'idle' })).toBe(false)
  expect(canSend({ draft: '', status: 'idle' })).toBe(false)
  expect(canSend({ draft: 'a'.repeat(2000), status: 'idle' })).toBe(true)
  expect(canSend({ draft: 'a'.repeat(2001), status: 'idle' })).toBe(false)
})
