/**
 * The daily check-in ("签到") request.
 *
 * Ported from the mechanism `linguo2625469/workbuddy2api-panel` proved against
 * this upstream: a POST to the billing meter family with an empty body, whose
 * envelope reports either success or an idempotent "already checked in" refusal.
 * Nothing here is guessed — the paths, the headers and the refusal markers are
 * copied from that implementation's wire observations.
 *
 * Two properties matter and are easy to lose:
 *
 * - **A refusal is not a failure.** "Already checked in today" arrives as a
 *   non-zero `code` with a message naming it, and treating that as an error
 *   would make every run after the first one look broken. It is reported as its
 *   own outcome so the caller can say "already done" rather than "failed".
 * - **Only transient failures are retried.** An upstream 5xx or a transport
 *   error is worth two more attempts; a 4xx, a business refusal and "already
 *   checked in" are conclusions about THIS request and are returned as they came.
 *
 * The path is region-split because the two gateways disagree: the international
 * one serves the bare `/billing/meter/...` family, the CN one serves the `/v2`
 * prefixed family. Each is tried with the other as a fallback on 404 only, which
 * is the one status that means "this path does not exist here".
 *
 * @module dsh-workbuddy-connect/checkin
 */

import { describeFetchFailure } from './fetch-failure.ts'
import { isJsonObject } from './json-value.ts'
import type { WorkBuddyCredential } from './auth.ts'
import { regionOf } from './upstream.ts'

/** How one check-in ended. */
export type WorkBuddyCheckinOutcome =
  /** The upstream accepted today's check-in. */
  | { state: 'checked-in' }
  /** Today was already claimed; a second call is a no-op, not a failure. */
  | { state: 'already' }
  /** The upstream refused for a reason the caller should see. */
  | { state: 'failed', reason: string }

/** Options for {@link checkIn}. */
export interface WorkBuddyCheckinOptions {
  /** Transport, injectable so tests never reach the network. */
  fetch?: typeof globalThis.fetch
  /** Attempts per path, including the first. Default 3. */
  attempts?: number
  /** Delay before retry `n` (1-based), in ms. */
  retryDelayMs?: (attempt: number) => number
  /** Sleep, injectable so a test never waits. */
  sleep?: (ms: number) => Promise<void>
}

/** The path families, per region, in the order they are tried. */
const CHECKIN_PATHS: Readonly<Record<'cn' | 'global', readonly string[]>> = {
  cn: ['/v2/billing/meter/daily-checkin'],
  global: ['/billing/meter/daily-checkin', '/v2/billing/meter/daily-checkin'],
}

/**
 * Markers the upstream uses for "you already did this today".
 *
 * Matched against the envelope's own message, never against a transport error:
 * a network failure that happened to contain the word "already" would otherwise
 * be recorded as a completed check-in for an account that never checked in.
 */
const ALREADY_MARKERS = ['已签到', 'already'] as const

/** Envelope shape the check-in answers with, as far as this module reads it. */
interface CheckinEnvelope {
  code: number
  msg: string
}

/** The upstream origin the billing family lives on. */
function billingOrigin(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global'
    ? 'https://www.workbuddy.ai'
    : 'https://www.codebuddy.cn'
}

/**
 * Headers for the billing family.
 *
 * The same identity picture as the credit read, because these endpoints split by
 * account on the same headers: an enterprise account that omits the pair is
 * answered for the personal one.
 */
function checkinHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: 'Bearer ' + credential.accessToken,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/** Whether an envelope's message says this account already checked in. */
export function isAlreadyCheckin(message: string): boolean {
  const lower = message.toLowerCase()
  return ALREADY_MARKERS.some(marker => message.includes(marker) || lower.includes(marker.toLowerCase()))
}

/** The default retry schedule: 2s, then 4s. */
function defaultRetryDelay(attempt: number): number {
  return 2000 * 2 ** (attempt - 1)
}

/** Sleep, without pulling a timer module into the bundle. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Claim today's check-in for one credential.
 *
 * @param credential - the account to check in as.
 * @param options - transport and retry seams.
 * @returns how it ended; never throws for an upstream refusal.
 */
export async function checkIn(
  credential: WorkBuddyCredential,
  options: WorkBuddyCheckinOptions = {},
): Promise<WorkBuddyCheckinOutcome> {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args))
  const attempts = Math.max(1, options.attempts ?? 3)
  const retryDelay = options.retryDelayMs ?? defaultRetryDelay
  const sleep = options.sleep ?? defaultSleep
  const region = regionOf(credential.domain) === 'global' ? 'global' : 'cn'
  const paths = CHECKIN_PATHS[region]

  let lastFailure = 'check-in did not complete'
  for (let pathIndex = 0; pathIndex < paths.length; pathIndex += 1) {
    const url = billingOrigin(credential) + paths[pathIndex]
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: checkinHeaders(credential),
          // An empty object, exactly as the panel sends it: the endpoint takes no
          // parameters, and some gateways reject a bodyless POST outright.
          body: '{}',
          signal: AbortSignal.timeout(20_000),
        })
      } catch (error: unknown) {
        // Transport: worth retrying, and never evidence about the account.
        lastFailure = describeFetchFailure(error)
        if (attempt < attempts) {
          await sleep(retryDelay(attempt))
          continue
        }
        break
      }

      // A 404 is the one status that means "this path is not here": move to the
      // next family rather than spending the remaining attempts on it.
      if (response.status === 404 && pathIndex < paths.length - 1) break

      const text = await response.text().catch(() => '')
      const envelope = parseEnvelope(text)
      if (!response.ok) {
        // A check-in that is refused because another channel already claimed
        // today is SUCCESS in disguise, and the upstream reports it as a plain
        // 4xx (measured: 400 "already checked in"). Retrying would repeat the
        // refusal, and reporting it as `failed` made the row claim the account
        // had not checked in while the server said it had — the exact complaint
        // this branch fixes.
        //
        // The marker is matched against the answer's own message only, never
        // against a transport error, and 404 keeps its path-fallback meaning.
        if (isAlreadyCheckin(envelope?.msg ?? text)) return { state: 'already' }
        // A 5xx is the upstream being unwell; retry it. Any other 4xx is a verdict.
        if (response.status >= 500) {
          lastFailure = 'http ' + String(response.status) + ': ' + (envelope?.msg ?? text.slice(0, 120))
          if (attempt < attempts) {
            await sleep(retryDelay(attempt))
            continue
          }
          break
        }
        return {
          state: 'failed',
          reason: 'http ' + String(response.status) + ': ' + (envelope?.msg ?? text.slice(0, 160)),
        }
      }
      if (envelope === undefined) {
        return { state: 'failed', reason: 'unreadable answer: ' + text.slice(0, 160) }
      }
      if (envelope.code === 0) return { state: 'checked-in' }
      // A business refusal. "Already" is success in disguise; anything else is a
      // real refusal, and retrying it would only repeat the same answer.
      if (isAlreadyCheckin(envelope.msg)) return { state: 'already' }
      return { state: 'failed', reason: 'code ' + String(envelope.code) + ': ' + envelope.msg.slice(0, 160) }
    }
  }
  return { state: 'failed', reason: lastFailure.slice(0, 200) }
}

/** Read the two envelope fields this module uses, or `undefined`. */
function parseEnvelope(text: string): CheckinEnvelope | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isJsonObject(parsed)) return undefined
  return {
    code: typeof parsed['code'] === 'number' ? parsed['code'] : 0,
    msg: typeof parsed['msg'] === 'string' ? parsed['msg'] : '',
  }
}
