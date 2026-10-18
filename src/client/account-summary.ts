/**
 * One pooled account, reduced to what a surface states about it.
 *
 * Two surfaces show the same facts about the same accounts — the accounts card on
 * the settings page, and the Models page's provider card — and they used to
 * derive them separately: the settings page rendered a stat grid per expanded
 * account, the provider card rendered its own dot and a single credit tag. The
 * questions a reader asks are the same on both ("can it serve now?", "how much is
 * left?", "when does it come back?"), so the answers are computed once here and
 * each surface renders them in its own frame.
 *
 * React-free on purpose: the tone mapping and the meta line are the parts worth
 * testing, and they run from Node without a DOM.
 *
 * @module dsh-workbuddy-connect/client/account-summary
 */

import type { WorkBuddyWebAccount } from '../status-paths.ts'
import { describeWait } from '../status-paths.ts'

/** The words one surface supplies; the keys live in that surface's dictionary. */
export interface AccountSummaryCopy {
  /** Switched off by the user. */
  disabled: string
  /** The upstream refused the session and a refresh could not fix it. */
  sessionDead: string
  /** Benched for a credit reason. */
  exhausted: string
  /** Benched for a rate reason. */
  limited: string
  /** A pasted token that lapsed and cannot renew itself. */
  expired: string
  /** The balance lookup failed. */
  creditsFailed: string
  /** The balance has not been read yet. */
  creditsPending: string
  remainingOf(template: { remaining: string, total: string }): string
  remaining(template: { remaining: string }): string
  used(template: { used: string }): string
  requests(template: { count: string }): string
  inputTokens(template: { value: string }): string
  outputTokens(template: { value: string }): string
  cache(template: { percent: string }): string
  resets(template: { when: string }): string
  tokenExpires(template: { when: string }): string
  wait(template: { value: number, unit: 'minute' | 'hour' }): string
}

/** How an account reads right now: the dot's tone and the chip's word. */
export interface AccountSummaryState {
  tone: 'ok' | 'warn' | 'error' | 'off'
  /** Empty for a healthy account: a ready row states nothing in the head line. */
  text: string
  /**
   * Whether the account may serve a request at this instant.
   *
   * Not the same as `tone === 'ok'`: a switched-off account is neither ready nor
   * failing, and the pool's own answer is what a caller should branch on.
   */
  servable: boolean
}

/**
 * How rotation reads this account right now.
 *
 * Precedence is the pool's own, restated once so no surface can disagree: an
 * account switched off is off whatever else is true, a judged-dead session is a
 * failure, a live bench is a warning, and a lapsed pasted token is a failure the
 * user has to act on.
 *
 * A bench states the REASON only. The countdown belongs to the meta line, which
 * already says when the allowance returns; stating it in both places made a
 * benched row read "rate limited" over "resets in 7 min" twice.
 */
export function accountSummaryState(
  account: WorkBuddyWebAccount,
  now: number,
  copy: AccountSummaryCopy,
): AccountSummaryState {
  if (account.enabled !== true) return { tone: 'off', text: copy.disabled, servable: false }
  if (account.sessionDead === true) return { tone: 'error', text: copy.sessionDead, servable: false }
  const cooldown = account.cooldown
  if (cooldown !== undefined && cooldown.untilMs > now) {
    const text = cooldown.reason === 'credit'
      ? copy.exhausted
      : cooldown.reason === 'session' ? copy.sessionDead : copy.limited
    return { tone: 'warn', text, servable: false }
  }
  // An expired pasted token is the one state the user must act on, and it is
  // indistinguishable from an idle account unless it is named.
  if (account.expiresAtMs > 0 && account.expiresAtMs <= now && account.renewable !== true) {
    return { tone: 'error', text: copy.expired, servable: false }
  }
  return { tone: 'ok', text: '', servable: account.available }
}

/**
 * The grey line under an account's name: remaining / used / requests / token
 * counts / cache hit / when the allowance returns.
 *
 * Every piece is conditional on the document actually carrying the fact. A
 * balance that was never read is NAMED rather than omitted — it is the one state
 * the reader can act on (press Refresh) — while a request tally of zero is
 * omitted, because "no traffic yet" changes nothing they would do.
 *
 * The join is a middot: the line is one sentence of small figures, not a table,
 * and the separator is what keeps it readable when it wraps.
 */
export function accountSummaryMeta(account: WorkBuddyWebAccount, now: number, copy: AccountSummaryCopy): string {
  const parts: string[] = []
  const credit = account.credits
  if (credit === undefined) {
    parts.push(account.creditsError === undefined ? copy.creditsPending : copy.creditsFailed)
  } else if (account.creditsTotal !== undefined && account.creditsTotal > 0) {
    parts.push(copy.remainingOf({ remaining: formatCredit(credit), total: formatCredit(account.creditsTotal) }))
  } else {
    parts.push(copy.remaining({ remaining: formatCredit(credit) }))
  }
  if (account.creditsUsed !== undefined) parts.push(copy.used({ used: formatCredit(account.creditsUsed) }))

  const usage = account.usage
  if (usage !== undefined && usage.requests > 0) {
    parts.push(copy.requests({ count: String(usage.requests) }))
    if (usage.reported > 0) {
      parts.push(copy.inputTokens({ value: shortTokens(usage.promptTokens) }))
      parts.push(copy.outputTokens({ value: shortTokens(usage.completionTokens) }))
      if (usage.cacheHitRate !== undefined) {
        parts.push(copy.cache({ percent: `${(usage.cacheHitRate * 100).toFixed(1)}%` }))
      }
    }
  }

  // A bench outranks the cycle reset: while an account is set aside, the wait
  // that matters is the one that returns it.
  const cooldown = account.cooldown
  if (cooldown !== undefined && cooldown.untilMs > now) {
    parts.push(copy.resets({ when: waitText(cooldown.untilMs, now, copy) }))
  } else if (account.creditsResetAtMs !== undefined && account.creditsResetAtMs > now) {
    parts.push(copy.resets({ when: waitText(account.creditsResetAtMs, now, copy) }))
  } else if (account.expiresAtMs > 0 && account.expiresAtMs > now && account.renewable !== true) {
    // A pasted token cannot renew itself, so its expiry is the one date the
    // reader has to act on. Renewing accounts refresh on their own; naming the
    // date there would be a countdown to nothing.
    parts.push(copy.tokenExpires({ when: waitText(account.expiresAtMs, now, copy) }))
  }

  return parts.join(' · ')
}

/** A credit figure, grouped the way every other surface in this plugin groups one. */
export function formatCredit(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)
}

/**
 * A token count as the reader should see it: 1M reads better than 1000000.
 *
 * Only exact multiples are compacted. "1.5M" would imply a precision the tally
 * does not have (it is a sum of per-answer figures), and rounding 999,999 up to
 * "1M" would overstate it.
 */
export function shortTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${String(tokens / 1_000_000)}M`
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${String(tokens / 1_000)}K`
  return String(tokens)
}

/** A wait, in the unit that reads best, worded by the caller's dictionary. */
function waitText(untilMs: number, now: number, copy: AccountSummaryCopy): string {
  const wait = describeWait(untilMs, now)
  return copy.wait({ value: wait.value, unit: wait.unit })
}
