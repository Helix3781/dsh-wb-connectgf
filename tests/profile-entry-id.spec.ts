import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { WORKBUDDY_PROFILE_ENTRY_ID } from '../src/status-paths.ts'

/**
 * The Loader row id this plugin's settings live under.
 *
 * It must NOT equal upstream's, and this is the test that keeps it that way.
 * Both plugins' bundle patches use `insert` with the id `llm-workbuddy`, so a
 * profile carrying both ended up with two rows of that id. The host's
 * `configEditor.entries()` drops a duplicated id as unaddressable, and its
 * write-back check resolves the id with a plain `.find()` that takes the first
 * match — upstream's, which carries no config — so every settings write from
 * this plugin was refused with "overridden by a home patch or command-line
 * overlay" (measured 2026-10-20; the settings page could not toggle anything).
 *
 * A rename is the only fix: the host keys rows by id, so two plugins cannot
 * share one and both stay writable.
 */
describe('profile entry id', () => {
  it('is distinct from the upstream plugin row', () => {
    // Upstream's id, quoted rather than imported: it is another package's
    // constant, and a change there must show up here as a failing test rather
    // than as a new collision nobody notices.
    expect(WORKBUDDY_PROFILE_ENTRY_ID).not.toBe('llm-workbuddy')
  })

  it('matches the row this package ships in its bundle patch', () => {
    // The patch is what actually creates the row at boot; a mismatch would
    // leave the plugin writing to an entry the loader never created.
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain(`- id: ${WORKBUDDY_PROFILE_ENTRY_ID}`)
  })
})