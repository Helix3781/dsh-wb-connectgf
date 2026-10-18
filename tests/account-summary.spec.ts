import { describe, expect, it } from 'vitest'
import {
  accountSummaryMeta,
  accountSummaryState,
  formatCredit,
  shortTokens,
  type AccountSummaryCopy,
} from '../src/client/account-summary.ts'
import type { WorkBuddyWebAccount } from '../src/status-paths.ts'

/**
 * The one projection every surface uses to describe a pooled account.
 *
 * These are behaviour pins, not formatting tests: what matters is which facts a
 * row states, in which order, and which ones it refuses to invent. The two
 * failure modes that used to exist are both here — a balance printed as a zero,
 * and a countdown stated twice in one row.
 */

/** A deliberate, literal dictionary: the assertions then read as the output. */
const copy: AccountSummaryCopy = {
  disabled: 'Off',
  sessionDead: 'Sign-in expired',
  exhausted: 'Out of quota',
  limited: 'Rate limited',
  expired: 'Token lapsed',
  creditsFailed: 'Balance unavailable',
  creditsPending: 'Not read yet',
  remainingOf: ({ remaining, total }) => `${remaining} / ${total} left`,
  remaining: ({ remaining }) => `${remaining} left`,
  used: ({ used }) => `${used} used`,
  requests: ({ count }) => `${count} requests`,
  inputTokens: ({ value }) => `in ${value}`,
  outputTokens: ({ value }) => `out ${value}`,
  cache: ({ percent }) => `cache ${percent}`,
  resets: ({ when }) => `resets in ${when}`,
  tokenExpires: ({ when }) => `token expires in ${when}`,
  wait: ({ value, unit }) => `${String(value)} ${unit}`,
}

/** One pool member, with only the fields under test. */
function account(overrides: Partial<WorkBuddyWebAccount> = {}): WorkBuddyWebAccount {
  return {
    id: 'uid-a:ent',
    uid: 'uid-a',
    name: '主账号',
    origin: 'desktop',
    domain: 'copilot.tencent.com',
    renewable: true,
    enabled: true,
    available: true,
    expiresAtMs: 0,
    lastUsedAtMs: 0,
    addedAtMs: 0,
    ...overrides,
  }
}

const NOW = 1_760_000_000_000

describe('account state', () => {
  it('says nothing in the head line while the account is ready', () => {
    const state = accountSummaryState(account(), NOW, copy)
    expect(state).toEqual({ tone: 'ok', text: '', servable: true })
  })

  it('names the bench reason without repeating the countdown', () => {
    const state = accountSummaryState(
      account({ available: false, cooldown: { untilMs: NOW + 7 * 60_000, reason: 'rate', strikes: 1 } }),
      NOW,
      copy,
    )
    expect(state.tone).toBe('warn')
    expect(state.text).toBe('Rate limited')
    expect(state.servable).toBe(false)
    // The countdown lives in the meta line only.
    expect(accountSummaryMeta(
      account({ available: false, cooldown: { untilMs: NOW + 7 * 60_000, reason: 'rate', strikes: 1 } }),
      NOW,
      copy,
    )).toContain('resets in 7 minute')
  })

  it('reads an expired, non-renewable token as a failure the user must act on', () => {
    const state = accountSummaryState(
      account({ renewable: false, expiresAtMs: NOW - 1_000, origin: 'cookie' }),
      NOW,
      copy,
    )
    expect(state.tone).toBe('error')
    expect(state.text).toBe('Token lapsed')
  })

  it('prefers the user\'s own switch over every other state', () => {
    const state = accountSummaryState(
      account({ enabled: false, sessionDead: true, available: false }),
      NOW,
      copy,
    )
    expect(state).toEqual({ tone: 'off', text: 'Off', servable: false })
  })
})

describe('account meta line', () => {
  it('states remaining against the cap, then used, then the tally, then the reset', () => {
    const meta = accountSummaryMeta(account({
      credits: 800,
      creditsTotal: 1000,
      creditsUsed: 200,
      creditsResetAtMs: NOW + 2 * 3_600_000,
      usage: {
        requests: 12,
        reported: 10,
        promptTokens: 1_000_000,
        completionTokens: 25_000,
        cacheReadTokens: 750_000,
        cacheWriteTokens: 0,
        cacheHitRate: 0.75,
        sinceMs: NOW - 86_400_000,
        lastAtMs: NOW,
      },
    }), NOW, copy)
    expect(meta).toBe('800 / 1,000 left · 200 used · 12 requests · in 1M · out 25K · cache 75.0% · resets in 2 hour')
  })

  it('names an unread balance instead of drawing a zero', () => {
    expect(accountSummaryMeta(account(), NOW, copy)).toBe('Not read yet')
    expect(accountSummaryMeta(account({ creditsError: 'HTTP 401' }), NOW, copy)).toBe('Balance unavailable')
  })

  it('states a balance alone when the upstream declared no cap', () => {
    expect(accountSummaryMeta(account({ credits: 500 }), NOW, copy)).toBe('500 left')
  })

  it('omits a request tally of zero and a cache rate nobody reported', () => {
    const meta = accountSummaryMeta(account({
      credits: 500,
      usage: {
        requests: 0,
        reported: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        sinceMs: NOW,
        lastAtMs: NOW,
      },
    }), NOW, copy)
    expect(meta).toBe('500 left')
  })

  it('names a lapsed token only when the account cannot renew it', () => {
    const pasted = account({ renewable: false, expiresAtMs: NOW + 30 * 60_000 })
    expect(accountSummaryMeta(pasted, NOW, copy)).toBe('Not read yet · token expires in 30 minute')
    // A renewable account refreshes on its own; a countdown there would be a
    // countdown to nothing.
    expect(accountSummaryMeta(account({ expiresAtMs: NOW + 30 * 60_000 }), NOW, copy)).toBe('Not read yet')
  })
})

describe('figures', () => {
  it('compacts only exact token multiples', () => {
    expect(shortTokens(1_000_000)).toBe('1M')
    expect(shortTokens(25_000)).toBe('25K')
    expect(shortTokens(999_999)).toBe('999999')
    expect(shortTokens(1_500)).toBe('1500')
  })

  it('groups credit with at most one decimal', () => {
    expect(formatCredit(5266)).toBe('5,266')
    expect(formatCredit(0.25)).toBe('0.3')
  })
})
