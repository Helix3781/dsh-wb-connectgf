// The cached-status predicate is React-free logic, so it needs no DOM.
import { describe, expect, it } from 'vitest'
import { hasRenderableProbeResults } from '../src/client/WorkBuddySettingsPage.tsx'
import type { WorkBuddyWebStatus } from '../src/status-paths.ts'

/**
 * Why this predicate exists: the settings page paints its first frame from a
 * `localStorage` document, and the shared discriminator check
 * (`isWorkBuddyWebStatus`) says nothing about `probe.results`. A row whose
 * `efforts` is absent makes the model row dereference `.length` while
 * rendering, which throws inside the composer slot the page shares with the
 * conversation — the reported "Cannot read properties of undefined (reading
 * 'length')". The cache is the one entry point the live route's own validation
 * does not cover, so it gets its own check.
 */

function signedIn(probe: unknown): WorkBuddyWebStatus {
  return { status: 'signed-in', probe } as WorkBuddyWebStatus
}

describe('cached status probe results', () => {
  it('accepts a document with no probe section at all', () => {
    expect(hasRenderableProbeResults({ status: 'signed-out' } as WorkBuddyWebStatus)).toBe(true)
    expect(hasRenderableProbeResults(signedIn(undefined))).toBe(true)
  })

  it('accepts results whose efforts is a real array, including an empty one', () => {
    expect(hasRenderableProbeResults(signedIn({
      results: [{ id: 'glm-5.2', name: 'GLM-5.2', validation: 'non-validating', efforts: [], probedAt: 1 }],
    }))).toBe(true)
    expect(hasRenderableProbeResults(signedIn({
      results: [{ id: 'glm-5.2', name: 'GLM-5.2', validation: 'validating', efforts: ['low'], probedAt: 1 }],
    }))).toBe(true)
  })

  it('rejects a result row with no efforts field', () => {
    expect(hasRenderableProbeResults(signedIn({
      results: [{ id: 'glm-5.2', name: 'GLM-5.2', validation: 'validating', probedAt: 1 }],
    }))).toBe(false)
  })

  it('rejects a row whose efforts is not an array', () => {
    expect(hasRenderableProbeResults(signedIn({
      results: [{ id: 'glm-5.2', name: 'GLM-5.2', validation: 'validating', efforts: 'low', probedAt: 1 }],
    }))).toBe(false)
    expect(hasRenderableProbeResults(signedIn({
      results: [{ id: 'glm-5.2', name: 'GLM-5.2', validation: 'validating', efforts: null, probedAt: 1 }],
    }))).toBe(false)
  })

  it('rejects a results field that is not an array', () => {
    expect(hasRenderableProbeResults(signedIn({ results: {} }))).toBe(false)
  })
})
