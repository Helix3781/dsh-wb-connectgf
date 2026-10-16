import { describe, expect, it } from 'vitest'
import { REQUIRED_PI_AI_VERSION, piAiVersionWarning, resolvedPiAiVersion } from '../src/pi-ai-guard.ts'

/**
 * The guard's whole product is one sentence, so the sentence is what is tested:
 * it must name both versions and the remedy, and it must stay silent on the
 * copy this plugin declares.
 *
 * The failure it reports is otherwise invisible: the host folds the system
 * prompt into `messages` the 0.87 way, an older pi-ai reads `.length` off a
 * block it does not model, and every request dies at `PI_AI_ERROR` before any
 * upstream HTTP — a message that names neither pi-ai nor a direction.
 */
describe('pi-ai version guard', () => {
  it('stays silent for the declared generation', () => {
    expect(piAiVersionWarning(REQUIRED_PI_AI_VERSION)).toBeUndefined()
  })

  it('stays silent when the resolved version cannot be read', () => {
    expect(piAiVersionWarning(undefined)).toBeUndefined()
  })

  it('names both versions and the remedy for a mismatched copy', () => {
    const warning = piAiVersionWarning('0.85.1')
    expect(warning).toBeDefined()
    expect(warning).toContain('0.85.1')
    expect(warning).toContain(REQUIRED_PI_AI_VERSION)
    expect(warning).toContain('nodeLinker')
  })

  it('reads a version off the module graph this process actually loaded', () => {
    // The devDependency pins the required generation, so the live read is the
    // one case that can assert an exact answer rather than "defined".
    expect(resolvedPiAiVersion()).toBe(REQUIRED_PI_AI_VERSION)
  })
})
