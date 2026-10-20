import { describe, expect, it } from 'vitest'
import { checkIn, isAlreadyCheckin } from '../src/checkin.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

/**
 * The daily check-in request.
 *
 * Three behaviours decide whether this is usable in a scheduler, and each has a
 * test below: a check-in that already happened must read as success, a transient
 * upstream failure must be retried a bounded number of times, and a verdict
 * (4xx, business refusal) must not be retried at all.
 */

/** A CN credential; the international one differs only by domain. */
function credential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    uid: 'uid-1',
    domain: 'copilot.tencent.com',
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAtMs: 0,
    ...overrides,
  } as WorkBuddyCredential
}

/** A fake transport that answers the nth call from a script. */
function scriptedTransport(answers: readonly (() => Response | Promise<Response>)[]): {
  calls: string[]
  fetch: typeof globalThis.fetch
} {
  const calls: string[] = []
  let index = 0
  const fetch = (async (url: string | URL | Request) => {
    calls.push(String(url))
    const answer = answers[Math.min(index, answers.length - 1)]
    index += 1
    if (answer === undefined) throw new Error('no answer scripted')
    return answer()
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

/** A JSON response with the given status. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const noWait = { sleep: async () => {} }

describe('isAlreadyCheckin', () => {
  it('recognises both wordings the upstream uses', () => {
    expect(isAlreadyCheckin('今日已签到')).toBe(true)
    expect(isAlreadyCheckin('今天已签到')).toBe(true)
    expect(isAlreadyCheckin('Already checked in')).toBe(true)
  })

  it('does not treat an unrelated refusal as a completed check-in', () => {
    // A network error containing "already" must never be recorded as success:
    // the account would be marked checked in for a day it never claimed.
    expect(isAlreadyCheckin('request illegal')).toBe(false)
    expect(isAlreadyCheckin('')).toBe(false)
  })
})

describe('checkIn', () => {
  it('claims the daily check-in on the CN path', async () => {
    const { calls, fetch } = scriptedTransport([() => json(200, { code: 0, data: {} })])
    const outcome = await checkIn(credential(), { fetch, ...noWait })
    expect(outcome).toEqual({ state: 'checked-in' })
    expect(calls).toEqual(['https://www.codebuddy.cn/v2/billing/meter/daily-checkin'])
  })

  it('reads a repeat as already, not as a failure', async () => {
    const { fetch } = scriptedTransport([() => json(200, { code: 14001, msg: '今日已签到' })])
    expect(await checkIn(credential(), { fetch, ...noWait })).toEqual({ state: 'already' })
  })


  /**
   * A check-in refused because another channel already claimed today arrives
   * as a plain 4xx. It is success in disguise: reporting it as `failed` made the
   * row claim the account had not checked in while the server said it had.
   */
  it('reads an \"already checked in\" 400 as success rather than failure', async () => {
    const { calls, fetch } = scriptedTransport([
      () => json(400, { code: 14001, msg: '今天已签到' }),
    ])
    const outcome = await checkIn(credential(), { fetch, ...noWait })
    expect(outcome).toEqual({ state: 'already' })
    // And it is not retried: the answer is a verdict, not a wobble.
    expect(calls).toHaveLength(1)
  })

  it('also recognises the English wording on a 400', async () => {
    const { fetch } = scriptedTransport([() => json(400, { msg: 'Already checked in today' })])
    expect(await checkIn(credential(), { fetch, ...noWait })).toEqual({ state: 'already' })
  })

  it('still fails a 400 that is not about an existing check-in', async () => {
    // The marker decides, not the status: a plain 400 must stay a refusal.
    const { fetch } = scriptedTransport([() => json(400, { code: 11140, msg: 'request illegal' })])
    const outcome = await checkIn(credential(), { fetch, ...noWait })
    expect(outcome.state).toBe('failed')
  })

  it('sends the identity headers the billing family splits on', async () => {
    let seen: Record<string, string> = {}
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = (init?.headers ?? {}) as Record<string, string>
      return json(200, { code: 0 })
    }) as unknown as typeof globalThis.fetch
    await checkIn(credential({ enterpriseId: 'ent-9' } as Partial<WorkBuddyCredential>), { fetch, ...noWait })
    expect(seen['X-User-Id']).toBe('uid-1')
    expect(seen['X-Enterprise-Id']).toBe('ent-9')
    expect(seen['X-Tenant-Id']).toBe('ent-9')
  })

  it('retries a transient 500 and succeeds on the second attempt', async () => {
    const { calls, fetch } = scriptedTransport([
      () => json(500, { code: 10000, msg: 'API request failed with status code: 500' }),
      () => json(200, { code: 0 }),
    ])
    expect(await checkIn(credential(), { fetch, ...noWait })).toEqual({ state: 'checked-in' })
    expect(calls).toHaveLength(2)
  })

  it('gives up after three attempts and reports the last failure', async () => {
    const { calls, fetch } = scriptedTransport([() => json(500, { code: 10000, msg: 'boom' })])
    const outcome = await checkIn(credential(), { fetch, ...noWait })
    expect(outcome.state).toBe('failed')
    expect(calls).toHaveLength(3)
  })

  it('does not retry a 4xx, which is a verdict rather than a wobble', async () => {
    const { calls, fetch } = scriptedTransport([() => json(403, { code: 11140, msg: 'request illegal' })])
    const outcome = await checkIn(credential(), { fetch, ...noWait })
    expect(outcome).toMatchObject({ state: 'failed' })
    expect(calls).toHaveLength(1)
  })

  it('does not retry a business refusal', async () => {
    const { calls, fetch } = scriptedTransport([() => json(200, { code: 12345, msg: 'account restricted' })])
    const outcome = await checkIn(credential(), { fetch, ...noWait })
    expect(outcome).toMatchObject({ state: 'failed' })
    expect(calls).toHaveLength(1)
  })

  it('falls back to the prefixed path when the international gateway answers 404', async () => {
    const { calls, fetch } = scriptedTransport([
      () => json(404, { code: 404, msg: 'not found' }),
      () => json(200, { code: 0 }),
    ])
    const outcome = await checkIn(credential({ domain: 'www.workbuddy.ai' }), { fetch, ...noWait })
    expect(outcome).toEqual({ state: 'checked-in' })
    expect(calls).toEqual([
      'https://www.workbuddy.ai/billing/meter/daily-checkin',
      'https://www.workbuddy.ai/v2/billing/meter/daily-checkin',
    ])
  })

  it('reports a transport failure without claiming the account is bad', async () => {
    const fetch = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof globalThis.fetch
    const outcome = await checkIn(credential(), { fetch, ...noWait })
    expect(outcome.state).toBe('failed')
    if (outcome.state !== 'failed') return
    expect(outcome.reason).toContain('fetch failed')
  })

  it('reports an unreadable body rather than treating it as success', async () => {
    const { fetch } = scriptedTransport([() => new Response('<html>proxy</html>', { status: 200 })])
    const outcome = await checkIn(credential(), { fetch, ...noWait })
    expect(outcome.state).toBe('failed')
  })
})
