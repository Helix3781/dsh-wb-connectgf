import { describe, expect, it } from 'vitest'
import { WorkBuddyCheckinService } from '../src/checkin-service.ts'
import type { WorkBuddyCheckinStore, WorkBuddyCheckinRecord } from '../src/checkin-store.ts'
import { localDay } from '../src/checkin-store.ts'
import type { WorkBuddyAccount } from '../src/account-pool.ts'

/**
 * The check-in scheduler.
 *
 * The properties worth pinning are the ones that decide whether this is polite
 * to the upstream: it must ask once per account per day, never ask for an
 * account it cannot use, and never let a failed bonus affect whether the account
 * serves requests.
 */

/** A memory store, satisfying the real interface rather than cast to it. */
function memoryStore(): WorkBuddyCheckinStore & { rows: Map<string, WorkBuddyCheckinRecord> } {
  const rows = new Map<string, WorkBuddyCheckinRecord>()
  const key = (variant: string, id: string): string => variant + '/' + id
  return {
    rows,
    recordFor: (variant, id) => rows.get(key(variant, id)),
    remember: (variant, id, atMs) => { rows.set(key(variant, id), { day: localDay(atMs), atMs }) },
    forget: (variant, id) => { rows.delete(key(variant, id)) },
    doneToday: (variant, id, now = Date.now()) => rows.get(key(variant, id))?.day === localDay(now),
  }
}

/** A pool double exposing exactly what the service reads. */
function poolOf(accounts: WorkBuddyAccount[]): {
  list(): readonly WorkBuddyAccount[]
  get(id: string): WorkBuddyAccount | undefined
} {
  return {
    list: () => accounts,
    get: id => accounts.find(account => account.id === id),
  }
}

/** One account. */
function account(id: string, overrides: Partial<WorkBuddyAccount> = {}): WorkBuddyAccount {
  return {
    id,
    uid: id,
    domain: 'copilot.tencent.com',
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAtMs: 0,
    origin: 'desktop',
    enabled: true,
    lastUsedAtMs: 0,
    ...overrides,
  } as WorkBuddyAccount
}

/** A transport that always accepts the check-in. */
function acceptingFetch(calls: string[] = []): typeof globalThis.fetch {
  return (async (url: string | URL | Request) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ code: 0 }), { status: 200 })
  }) as unknown as typeof globalThis.fetch
}

/** Build a service over the given accounts. */
function makeService(options: {
  accounts: WorkBuddyAccount[]
  store?: ReturnType<typeof memoryStore>
  enabled?: boolean
  fetch?: typeof globalThis.fetch
  now?: () => number
}): { service: WorkBuddyCheckinService, store: ReturnType<typeof memoryStore>, calls: string[] } {
  const store = options.store ?? memoryStore()
  const calls: string[] = []
  const service = new WorkBuddyCheckinService({
    variantId: 'workbuddy',
    pool: poolOf(options.accounts) as never,
    store,
    enabled: () => options.enabled ?? true,
    checkin: {
      fetch: options.fetch ?? acceptingFetch(calls),
      sleep: async () => {},
      attempts: 1,
    },
    ...options.now === undefined ? {} : { now: options.now },
  })
  return { service, store, calls }
}

describe('WorkBuddyCheckinService', () => {
  it('checks every usable account in once', async () => {
    const { service, store, calls } = makeService({ accounts: [account('a'), account('b')] })
    const run = await service.sweep()
    expect(calls).toHaveLength(2)
    expect(run.accounts.map(row => row.state)).toEqual(['checked-in', 'checked-in'])
    expect(store.doneToday('workbuddy', 'a')).toBe(true)
    expect(store.doneToday('workbuddy', 'b')).toBe(true)
  })

  it('does not ask again on a second sweep the same day', async () => {
    const { service, calls } = makeService({ accounts: [account('a')] })
    await service.sweep()
    const second = await service.sweep()
    // One round trip total: the record is what keeps this quiet.
    expect(calls).toHaveLength(1)
    expect(second.accounts[0]?.state).toBe('skipped')
  })

  it('asks again once the local day turns', async () => {
    let now = Date.now()
    const { service, calls } = makeService({ accounts: [account('a')], now: () => now })
    await service.sweep()
    now += 24 * 3_600_000
    await service.sweep()
    expect(calls).toHaveLength(2)
  })

  it('skips a switched-off account and a dead session', async () => {
    const { service, calls } = makeService({
      accounts: [account('off', { enabled: false }), account('dead', { sessionDead: true })],
    })
    const run = await service.sweep()
    expect(calls).toHaveLength(0)
    expect(run.accounts.map(row => row.state)).toEqual(['skipped', 'skipped'])
  })

  it('does nothing at all while the preference is off', async () => {
    const { service, calls } = makeService({ accounts: [account('a')], enabled: false })
    const run = await service.sweep()
    expect(calls).toHaveLength(0)
    expect(run.accounts).toEqual([])
  })

  it('records a failure without blocking the rest of the pool', async () => {
    // The endpoint is the same for every account, so the failing account is
    // chosen by call order: the first sweep member is the one that is refused.
    let call = 0
    const fetch = (async () => {
      call += 1
      if (call === 1) return new Response('{"code":1,"msg":"nope"}', { status: 403 })
      return new Response('{"code":0}', { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const { service, store } = makeService({ accounts: [account('x'), account('a')], fetch })
    const run = await service.sweep()
    expect(run.accounts[0]?.state).toBe('failed')
    expect(run.accounts[1]?.state).toBe('checked-in')
    expect(store.doneToday('workbuddy', 'x')).toBe(false)
    expect(store.doneToday('workbuddy', 'a')).toBe(true)
  })

  it('treats "already" as a completed day rather than as a failure', async () => {
    const fetch = (async () => new Response('{"code":14001,"msg":"今日已签到"}', { status: 200 })) as unknown as typeof globalThis.fetch
    const { service, store } = makeService({ accounts: [account('a')], fetch })
    const run = await service.sweep()
    expect(run.accounts[0]?.state).toBe('already')
    expect(store.doneToday('workbuddy', 'a')).toBe(true)
  })

  it('shares one sweep between concurrent callers', async () => {
    const { service, calls } = makeService({ accounts: [account('a'), account('b')] })
    await Promise.all([service.sweep(), service.sweep(), service.sweep()])
    expect(calls).toHaveLength(2)
  })

  it('checks one account in on demand, even if the day is already recorded', async () => {
    const store = memoryStore()
    const now = Date.now()
    store.remember('workbuddy', 'a', now)
    const { service, calls } = makeService({ accounts: [account('a')], store, now: () => now })
    const result = await service.checkOne('a')
    expect(result.state).toBe('checked-in')
    expect(calls).toHaveLength(1)
  })

  it('reports an unknown account rather than throwing', async () => {
    const { service } = makeService({ accounts: [] })
    const result = await service.checkOne('ghost')
    expect(result.state).toBe('failed')
    expect(result.reason).toContain('not found')
  })

  it('stops on dispose', async () => {
    const { service } = makeService({ accounts: [account('a')] })
    const dispose = service.start()
    dispose()
    // A second dispose is a no-op rather than a throw.
    expect(() => { dispose() }).not.toThrow()
  })
})
