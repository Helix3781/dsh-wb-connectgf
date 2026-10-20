import { describe, expect, it } from 'vitest'
import { hostCapabilities, hostResolvesPaths, hostSettings } from '../src/host-capabilities.ts'

/**
 * The host-capability probes.
 *
 * These exist because the plugin has to run on more than one DSH generation, and
 * the only honest way to decide what a host supports is to look at the object it
 * handed over. A version comparison guesses; these answer.
 *
 * The cases below are the shapes actually shipped: the 0.1.7+/0.2.x forms
 * facade, the older section API, a half-installed service (one method of two),
 * and a missing service. Each must land in exactly one bucket, because the
 * caller degrades on that answer — a false positive means a settings control
 * that cannot save.
 */
describe('settings generation probe', () => {
  it('accepts the forms facade (0.1.7 and later)', () => {
    const service = {
      configure: () => () => {},
      update: async () => {},
      describe: () => ({}),
    }
    const answer = hostSettings(service)
    expect(answer.settings).toBe('forms')
    expect(answer.write).toBeDefined()
    expect(answer.policy).toBeDefined()
  })

  it('refuses the pre-0.1.7 section API, which cannot persist an entry config', () => {
    // installSection is the 0.1.5/0.1.6 shape: it installs a schema section,
    // which is not the write path this build speaks.
    const answer = hostSettings({ installSection() {}, update: async () => {} })
    expect(answer.settings).toBe('none')
  })

  it('refuses a service that can only do half the job', () => {
    // configure without update would install a form whose edits are lost;
    // update without configure would leave the host drawing a second page.
    expect(hostSettings({ configure: () => () => {} }).settings).toBe('none')
    expect(hostSettings({ update: async () => {} }).settings).toBe('none')
  })

  it('refuses an absent or non-object service', () => {
    expect(hostSettings(undefined).settings).toBe('none')
    expect(hostSettings(null).settings).toBe('none')
    expect(hostSettings('settings').settings).toBe('none')
  })

  it('binds the host methods to their own receiver', async () => {
    // Both implementations keep state on this; a detached reference throws
    // inside the host.
    const calls: unknown[][] = []
    const service = {
      configure(this: unknown, presentation: { auto?: boolean }, owner?: unknown) {
        calls.push(['configure', this === service, presentation, owner])
        return () => {}
      },
      async update(this: unknown, id: string, patch: object) {
        calls.push(['update', this === service, id, patch])
      },
    }
    const answer = hostSettings(service)
    answer.policy?.configure({ auto: false }, 'fiber')
    await answer.write?.update('llm-workbuddy', { a: 1 })
    expect(calls).toEqual([
      ['configure', true, { auto: false }, 'fiber'],
      ['update', true, 'llm-workbuddy', { a: 1 }],
    ])
  })
})

describe('host path translation probe', () => {
  it('accepts a filesystem service that can translate a host path', () => {
    expect(hostResolvesPaths({ processPathFromHostPath: () => '/tmp/x' })).toBe(true)
  })

  it('refuses one that cannot, and one that is absent', () => {
    expect(hostResolvesPaths({ readFile: () => {} })).toBe(false)
    expect(hostResolvesPaths(undefined)).toBe(false)
    expect(hostResolvesPaths(null)).toBe(false)
  })
})

describe('the combined answer', () => {
  it('reports both capabilities from the services as reached', () => {
    const answer = hostCapabilities({
      settings: { configure: () => () => {}, update: async () => {} },
      fs: { processPathFromHostPath: () => '/tmp/x' },
    })
    expect(answer.settings).toBe('forms')
    expect(answer.hostPaths).toBe(true)
  })

  it('degrades both when the profile mounts neither', () => {
    const answer = hostCapabilities({})
    expect(answer.settings).toBe('none')
    expect(answer.hostPaths).toBe(false)
  })
})