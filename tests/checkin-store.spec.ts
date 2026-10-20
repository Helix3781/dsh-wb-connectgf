import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkBuddyCheckinStore, localDay } from '../src/checkin-store.ts'

/**
 * The check-in record store.
 *
 * Its whole job is to answer "has today been claimed for this account", so the
 * cases that matter are the day boundary, a corrupt document, and an account
 * that is not there — each of which must answer \"no\" rather than throwing or
 * claiming a check-in that never happened.
 */

const DIRS: string[] = []

afterEach(async () => {
  await Promise.all(DIRS.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A store over a throwaway directory. */
async function makeStore(): Promise<{ path: string, store: ReturnType<typeof createWorkBuddyCheckinStore> }> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-checkin-'))
  DIRS.push(dir)
  const path = join(dir, 'checkin.json')
  return { path, store: createWorkBuddyCheckinStore(path) }
}

describe('localDay', () => {
  it('reads the machine\'s own day, zero-padded', async () => {
    // Midday UTC, so the assertion is about formatting and not about which side
    // of midnight a timezone happens to fall on.
    const day = localDay(Date.UTC(2026, 9, 20, 12, 0, 0))
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
    expect(day).toBe(localDay(Date.UTC(2026, 9, 20, 12, 0, 0)))
  })
})

describe('WorkBuddyCheckinStore', () => {
  it('answers "not today" for an account it has never seen', async () => {
    const { store } = await makeStore()
    expect(store.doneToday('workbuddy', 'uid-a')).toBe(false)
    expect(store.recordFor('workbuddy', 'uid-a')).toBeUndefined()
  })

  it('remembers a check-in and reads it back as today', async () => {
    const { store } = await makeStore()
    const now = Date.now()
    store.remember('workbuddy', 'uid-a', now)
    expect(store.doneToday('workbuddy', 'uid-a', now)).toBe(true)
    expect(store.recordFor('workbuddy', 'uid-a')).toEqual({ day: localDay(now), atMs: now })
  })

  it('keeps yesterday\'s record as a record but not as today', async () => {
    const { store } = await makeStore()
    const yesterday = Date.now() - 30 * 3_600_000
    store.remember('workbuddy', 'uid-a', yesterday)
    // Yesterday is still a fact worth showing; it is just not today's answer.
    expect(store.recordFor('workbuddy', 'uid-a')?.atMs).toBe(yesterday)
    expect(store.doneToday('workbuddy', 'uid-a', Date.now())).toBe(false)
  })

  it('scopes records per variant, so one product cannot answer for the other', async () => {
    const { store } = await makeStore()
    store.remember('workbuddy', 'same-id', Date.now())
    expect(store.doneToday('workbuddy-ai', 'same-id')).toBe(false)
  })

  it('forgets one account without touching its neighbours', async () => {
    const { store } = await makeStore()
    const now = Date.now()
    store.remember('workbuddy', 'uid-a', now)
    store.remember('workbuddy', 'uid-b', now)
    store.forget('workbuddy', 'uid-a')
    expect(store.doneToday('workbuddy', 'uid-a', now)).toBe(false)
    expect(store.doneToday('workbuddy', 'uid-b', now)).toBe(true)
  })

  it('treats an unreadable document as nothing saved', async () => {
    const { path, store } = await makeStore()
    await writeFile(path, '{ not json', { encoding: 'utf8' })
    expect(store.doneToday('workbuddy', 'uid-a')).toBe(false)
    // ...and still writes a usable document afterwards.
    store.remember('workbuddy', 'uid-a', Date.now())
    expect(store.doneToday('workbuddy', 'uid-a')).toBe(true)
  })

  it('drops records with a malformed shape instead of trusting half of one', async () => {
    const { path, store } = await makeStore()
    await writeFile(path, JSON.stringify({
      version: 1,
      records: {
        workbuddy: {
          'uid-a': { day: '2026-10-20' },            // no atMs
          'uid-b': { atMs: Date.now() },              // no day
          'uid-c': { day: '2026-10-20', atMs: 1 },   // complete
        },
      },
    }), { encoding: 'utf8' })
    expect(store.recordFor('workbuddy', 'uid-a')).toBeUndefined()
    expect(store.recordFor('workbuddy', 'uid-b')).toBeUndefined()
    expect(store.recordFor('workbuddy', 'uid-c')).toEqual({ day: '2026-10-20', atMs: 1 })
  })

  it('writes a versioned document', async () => {
    const { path, store } = await makeStore()
    store.remember('workbuddy', 'uid-a', 1)
    const document = JSON.parse(await readFile(path, 'utf8')) as { version: number }
    expect(document.version).toBe(1)
  })

  it('rewrites one account without dropping the others', async () => {
    const { store } = await makeStore()
    const first = Date.now()
    store.remember('workbuddy', 'uid-a', first)
    store.remember('workbuddy', 'uid-b', first)
    store.remember('workbuddy', 'uid-a', first + 1000)
    expect(store.recordFor('workbuddy', 'uid-a')?.atMs).toBe(first + 1000)
    expect(store.recordFor('workbuddy', 'uid-b')?.atMs).toBe(first)
  })
})
