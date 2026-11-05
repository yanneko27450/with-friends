// Small shared helpers of the chat client modules (CHAT3-CLIENT). Same rules as chat-envelope.ts / chat-rekey.ts:
// strict base64url (canonical form only), own-data-property snapshots of caller objects, constant-shape comparisons.

export const encoder = new TextEncoder()
const base64urlPattern = /^[A-Za-z0-9_-]+$/
export const tokenPattern = /^[A-Za-z0-9_-]{1,100}$/

export const toB64 = (value: Uint8Array): string => {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decodes canonical base64url of exactly `length` bytes (re-encoding must give the same string), else null. */
export const fromB64 = (value: unknown, length: number): Uint8Array | null => {
  if (typeof value !== 'string' || value.length > Math.ceil(length * 4 / 3) || !base64urlPattern.test(value)) return null
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
    const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0))
    return bytes.length === length && toB64(bytes) === value ? bytes : null
  } catch { return null }
}

/** Own enumerable data properties of a plain object with exactly the expected keys; getters, proxies' traps, symbols and extra keys give null. */
export const plain = (value: unknown, expected: readonly string[]): Readonly<Record<string, unknown>> | null => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== expected.length || keys.some(key => typeof key !== 'string') || expected.some(key => !keys.includes(key))) return null
    const snapshot: Record<string, unknown> = {}
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) return null
      snapshot[key] = descriptor.value
    }
    return Object.freeze(snapshot)
  } catch { return null }
}

export const validToken = (value: unknown): value is string => typeof value === 'string' && tokenPattern.test(value)
export const safeCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0)
export const safePositive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0

export const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  let different = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index++) different |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return different === 0
}
export const allZero = (value: Uint8Array): boolean => {
  let bits = 0
  for (const byte of value) bits |= byte
  return bits === 0
}
export const wipe = (...values: (Uint8Array | null | undefined)[]): void => { for (const value of values) value?.fill(0) }
/** A private copy of a plain Uint8Array of the given length (not slice(): a species hook could hand back the caller's own object). */
export const copyBytes = (value: unknown, length: number): Uint8Array | null => {
  try {
    if (!value || Object.getPrototypeOf(value) !== Uint8Array.prototype) return null
    const copy = new Uint8Array(value as Uint8Array)
    return copy.length === length ? copy : null
  } catch { return null }
}

export type Fail<R extends string> = Readonly<{ ok: false; reason: R }>
export const fail = <R extends string>(reason: R): Fail<R> => Object.freeze({ ok: false as const, reason })
