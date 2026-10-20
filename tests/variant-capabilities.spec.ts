import { describe, expect, it } from 'vitest'
import { AI_VARIANT, CN_VARIANT, WORKBUDDY_VARIANTS } from '../src/variants.ts'

/**
 * The per-product capabilities that decide which surfaces exist at all.
 *
 * The two products are not the same service with two hostnames: the CN gateway
 * grants a daily check-in, the international one retired it. Encoding that as a
 * flag is what lets the scheduler, the route seam and the settings section
 * disappear together — a branch at each call site is how one of the three ends
 * up forgotten, and a button that always fails is worse than no button.
 */
describe('variant capabilities', () => {
  it('gives the daily check-in to the CN product only', () => {
    expect(CN_VARIANT.checkinSupported).toBe(true)
    // The international gateway has no such endpoint; offering it would be a
    // guaranteed 4xx on every press.
    expect(AI_VARIANT.checkinSupported).toBe(false)
  })

  it('keeps every other per-product surface on both', () => {
    // A capability flag must not quietly become a general "is CN" switch: the
    // pools, catalogs, probes and visibility lists exist on both products.
    for (const variant of WORKBUDDY_VARIANTS) {
      expect(variant.statusPath).not.toBe('')
      expect(variant.probePath).not.toBe('')
      expect(variant.accountPath).not.toBe('')
      expect(variant.checkinFilename).not.toBe('')
      expect(variant.usageFilename).not.toBe('')
    }
  })
})