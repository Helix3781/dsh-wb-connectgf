/**
 * Automatic daily check-in for the whole pool.
 *
 * What it does, once per account per day: calls {@link checkIn} with that
 * account's credential, and records the result. What it deliberately does NOT
 * do: run on a fixed interval that fires every hour and relies on the upstream
 * rejecting repeats — that is one round trip per account per tick forever, for
 * an answer this plugin already knows.
 *
 * The schedule is therefore two-layered, and both layers are cheap:
 *
 * 1. a timer that wakes rarely ({@link SWEEP_INTERVAL_MS}), and
 * 2. a per-account record (`checkin-store.ts`) that makes each wake-up a no-op
 *    until the local day changes.
 *
 * The local day — not UTC — decides, because the upstream's own "today" is the
 * user's day: checking in at 00:30 local after a 23:50 local check-in is a new
 * day for both sides.
 *
 * Failure handling mirrors the rest of the plugin: an account that fails is
 * recorded as failed for this run and retried on the next wake-up, and a failed
 * check-in never benches an account or touches its session — the weakest possible
 * coupling, because a check-in is a bonus, not a request the user asked for.
 *
 * @module dsh-workbuddy-connect/checkin-service
 */

import type { WorkBuddyAccount, WorkBuddyAccountPool } from './account-pool.ts'
import { credentialOf } from './account-pool.ts'
import type { WorkBuddyCheckinRecord, WorkBuddyCheckinStore } from './checkin-store.ts'
import { checkIn } from './checkin.ts'
import type { WorkBuddyCheckinOptions } from './checkin.ts'

/**
 * How often the sweep looks for work.
 *
 * Fifteen minutes rather than an hour: the check-in window is a day, so being
 * late by up to a quarter of an hour is harmless, while an hourly timer made a
 * machine that woke from sleep just after the hour wait most of one. Each
 * wake-up costs nothing unless a record says a day has turned.
 */
export const SWEEP_INTERVAL_MS = 15 * 60_000

/** What one account did on the last run. */
export interface CheckinAccountResult {
  accountId: string
  name: string
  state: 'checked-in' | 'already' | 'failed' | 'skipped'
  /** Why it failed, or why it was skipped. */
  reason?: string
  /** Epoch ms of the attempt. */
  atMs: number
}

/** What one sweep did. */
export interface CheckinRunResult {
  atMs: number
  accounts: readonly CheckinAccountResult[]
}

/** Constructor dependencies. */
export interface WorkBuddyCheckinServiceOptions {
  variantId: string
  pool: WorkBuddyAccountPool
  store: WorkBuddyCheckinStore
  /** Transport and retry seams, forwarded to {@link checkIn}. */
  checkin?: WorkBuddyCheckinOptions
  /** Whether auto check-in is enabled; read live, so a settings write applies at once. */
  enabled: () => boolean
  logger?: { warn(...args: unknown[]): void, info?(...args: unknown[]): void }
  /** Injectable clock, for tests. */
  now?: () => number
}

/**
 * The scheduler and its manual entry point.
 *
 * One instance per variant, because the pool and the records are per variant —
 * two products' accounts have different ids in the same document space.
 */
export class WorkBuddyCheckinService {
  private readonly options: WorkBuddyCheckinServiceOptions
  private timer: ReturnType<typeof setInterval> | undefined
  private inFlight: Promise<CheckinRunResult> | undefined
  private lastRun: CheckinRunResult | undefined

  constructor(options: WorkBuddyCheckinServiceOptions) {
    this.options = options
  }

  /** The most recent sweep, for the status document. */
  get last(): CheckinRunResult | undefined {
    return this.lastRun
  }

  /**
   * The recorded claim for one account, when there is one.
   *
   * Exposed so the status document can state "checked in on <day>" without
   * reaching into the store itself: the service owns the variant id that keys
   * the record, and a caller that guessed it would eventually guess wrong.
   */
  record(accountId: string): WorkBuddyCheckinRecord | undefined {
    return this.options.store.recordFor(this.options.variantId, accountId)
  }

  /**
   * Start the timer. Idempotent: a second call returns the same disposer.
   *
   * The first sweep is NOT immediate — it runs one interval in. A host start is
   * already busy (routes, catalogs, credits), and a check-in has all day.
   */
  start(): () => void {
    this.timer ??= setInterval(() => { void this.sweep() }, SWEEP_INTERVAL_MS)
    // Never hold the process open for a check-in.
    this.timer.unref?.()
    return () => {
      if (this.timer === undefined) return
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Check every account in for today, skipping the ones already recorded.
   *
   * Concurrent calls share one sweep: the timer and a user pressing the button
   * must not spend two round trips per account.
   */
  sweep(): Promise<CheckinRunResult> {
    this.inFlight ??= this.run().finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  /**
   * Check ONE account in, whatever its record says.
   *
   * The manual path: a user who just added an account should not have to wait
   * for tomorrow, and asking again after "already" is harmless (the upstream is
   * idempotent).
   */
  async checkOne(accountId: string): Promise<CheckinAccountResult> {
    const account = this.options.pool.get(accountId)
    const now = this.options.now?.() ?? Date.now()
    if (account === undefined) {
      return { accountId, name: accountId, state: 'failed', reason: 'account not found', atMs: now }
    }
    const result = await this.attempt(account, now)
    // A manual check-in counts for the day even when the upstream said "already":
    // the point of the record is to stop the SCHEDULER re-asking, and this
    // answer is just as good evidence as a fresh one.
    if (result.state === 'checked-in' || result.state === 'already') {
      this.options.store.remember(this.options.variantId, account.id, now)
    }
    return result
  }

  /** Run one sweep over the pool. */
  private async run(): Promise<CheckinRunResult> {
    const now = this.options.now?.() ?? Date.now()
    const results: CheckinAccountResult[] = []
    if (!this.options.enabled()) {
      const document = { atMs: now, accounts: results }
      this.lastRun = document
      return document
    }
    for (const account of this.options.pool.list()) {
      if (this.options.store.doneToday(this.options.variantId, account.id, now)) {
        results.push({ accountId: account.id, name: displayNameOf(account), state: 'skipped', reason: 'checked in today', atMs: now })
        continue
      }
      // A switched-off or judged-dead account is not checked in: the first is
      // the user's decision, and the second would spend a request that the
      // upstream will refuse.
      if (!account.enabled || account.sessionDead === true) {
        results.push({
          accountId: account.id,
          name: displayNameOf(account),
          state: 'skipped',
          reason: account.enabled ? 'sign-in expired' : 'switched off',
          atMs: now,
        })
        continue
      }
      results.push(await this.attempt(account, now))
    }
    const document = { atMs: now, accounts: results }
    this.lastRun = document
    return document
  }

  /** One account, one attempt, with the record written on success. */
  private async attempt(account: WorkBuddyAccount, atMs: number): Promise<CheckinAccountResult> {
    const outcome = await checkIn(credentialOf(account), this.options.checkin)
    if (outcome.state === 'failed') {
      // A warning, not a bench: a bonus that did not land is not a reason to
      // stop serving with the account.
      this.options.logger?.warn(`dsh-workbuddy-connect: check-in for ${account.id} failed: ${outcome.reason}`)
      return { accountId: account.id, name: displayNameOf(account), state: 'failed', reason: outcome.reason, atMs }
    }
    this.options.store.remember(this.options.variantId, account.id, atMs)
    return { accountId: account.id, name: displayNameOf(account), state: outcome.state, atMs }
  }
}

/** The name a report line uses for one account. */
function displayNameOf(account: WorkBuddyAccount): string {
  return account.label ?? account.nickname ?? `${account.uid.slice(0, 8)}…`
}
