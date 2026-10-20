import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  SUPPORTED_HOSTS,
  SUPPORTED_MINIMUM,
  SUPPORTED_PEER_RANGE,
  SUPPORTED_PI_AI_RANGE,
  SUPPORTED_TESTED,
} from '../src/supported-hosts.ts'

/**
 * The support matrix, pinned against the manifest it describes.
 *
 * This is the file that stops the two halves drifting: the table says which DSH
 * lines the plugin supports, `peerDependencies` decides whether the package
 * manager will even install it there. Upstream shipped the failure mode — peers
 * pinned to one prerelease, so the next one was uninstallable — and a test is
 * cheaper than discovering it from an install error.
 */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  peerDependencies: Record<string, string>
}

describe('supported host matrix', () => {
  it('lists the newest line first, because that is the one this build compiles against', () => {
    expect(SUPPORTED_HOSTS[0]?.packages).toBe('^0.2.1-rc.1')
    expect(SUPPORTED_TESTED).toBe(SUPPORTED_HOSTS[0]?.packages)
  })

  it('derives the peer range from the table', () => {
    expect(SUPPORTED_PEER_RANGE).toBe(SUPPORTED_HOSTS.map(host => host.packages).join(' || '))
    expect(SUPPORTED_MINIMUM).toBe(SUPPORTED_HOSTS[SUPPORTED_HOSTS.length - 1]?.packages)
  })

  it('declares exactly that range for every DSH package it peers on', () => {
    // Compared as SETS: the alternatives' order is not part of the contract,
    // and pinning the string would make a harmless reordering look like a
    // support change.
    const alternatives = (range: string): string[] =>
      range.split('||').map(part => part.trim()).sort()
    const dshPeers = Object.entries(manifest.peerDependencies)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    expect(dshPeers.length).toBeGreaterThan(0)
    for (const [name, range] of dshPeers) {
      // Every DSH peer must admit every supported line, or an install on that
      // line is refused before the capability probes ever get to answer.
      expect([name, alternatives(range)]).toEqual([name, alternatives(SUPPORTED_PEER_RANGE)])
    }
  })

  it('declares the pi-ai range the table records', () => {
    // Load-bearing: a pi-ai from another generation fails before any request is
    // sent, with an error that names nothing useful.
    expect(manifest.peerDependencies['@earendil-works/pi-ai']?.split('||').map(p => p.trim()).sort())
      .toEqual(SUPPORTED_PI_AI_RANGE.split('||').map(p => p.trim()).sort())
  })

  it('records what was verified for every line, and which one was actually run', () => {
    for (const host of SUPPORTED_HOSTS) {
      expect(host.line).not.toBe('')
      expect(host.verified.length).toBeGreaterThan(20)
    }
    // Exactly one line carries a runtime verification of this build; the rest
    // say so honestly rather than implying they were tested.
    const ran = SUPPORTED_HOSTS.filter(host => host.verified.includes('full suite'))
    expect(ran).toHaveLength(1)
    expect(ran[0]?.packages).toBe(SUPPORTED_TESTED)
  })
})