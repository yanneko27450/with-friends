import { isAction, isSubject } from './taxonomy.ts'

export const TAXONOMY_WARNING = 'taxonomy-invalid' as const
export const TAXONOMY_WARNING_INTERVAL_MS = 5 * 60 * 1000

export type TaxonomyDiagnosticState = Readonly<{
  violations: number
  lastWarningAt: number | null
}>

export const EMPTY_TAXONOMY_DIAGNOSTICS: TaxonomyDiagnosticState = Object.freeze({ violations: 0, lastWarningAt: null })

type IncomingTaxonomy = Readonly<{
  signatureValid: boolean
  payload: unknown
}>

export type TaxonomyDecision = Readonly<{
  accepted: boolean
  warning: typeof TAXONOMY_WARNING | null
  state: TaxonomyDiagnosticState
}>

const exactTaxonomy = (value: unknown): value is { action: string; subject: string } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return keys.length === 2 && keys[0] === 'action' && keys[1] === 'subject' && isAction(record.action) && isSubject(record.subject)
}

/**
 * Pure, local-only policy. It deliberately returns neither the input nor a reason
 * derived from it, so an attacker-controlled value cannot reach a pane, log, or
 * Claude conversation through the diagnostic result.
 */
export function diagnoseTaxonomy(input: IncomingTaxonomy, previous: TaxonomyDiagnosticState, now: number): TaxonomyDecision {
  let accepted = false
  try {
    accepted = input.signatureValid === true && exactTaxonomy(input.payload)
  } catch { /* every untrusted access becomes the same fixed rejection below */ }
  if (accepted) return { accepted: true, warning: null, state: previous }
  const shouldWarn = previous.lastWarningAt === null || now - previous.lastWarningAt >= TAXONOMY_WARNING_INTERVAL_MS
  return {
    accepted: false,
    warning: shouldWarn ? TAXONOMY_WARNING : null,
    state: Object.freeze({ violations: Math.min(Number.MAX_SAFE_INTEGER, previous.violations + 1), lastWarningAt: shouldWarn ? now : previous.lastWarningAt }),
  }
}
