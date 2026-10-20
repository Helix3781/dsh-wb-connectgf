/**
 * What the daily check-in has already done, per account.
 *
 * The check-in itself is idempotent upstream ("already checked in" is an
 * answer), so this store is not what makes it safe — it is what makes it QUIET.
 * Without it every sweep would re-ask the upstream for every account, spending
 * a round trip per account per tick to be told the same thing, and the page
 * could not say "checked in at 09:12" because nobody was keeping that fact.
 *
 * The record is deliberately dated rather than boolean: "checked in on
 * 2026-10-20" is what decides whether today's sweep has anything to do, and a
 * timestamp is the only shape that survives a timezone or a clock change
 * without re-asking the upstream.
 *
 * Persistence follows the plugin's one store policy (`store-file.ts`): a
 * version-tagged document, one atomic replace, "nothing saved" for anything
 * unreadable.
 *
 * @module dsh-workbuddy-connect/checkin-store
 */

import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { readStoreDocument, writeStoreDocument } from './store-file.ts'
import { isJsonObject, parseJsonObject } from './json-value.ts'

/** On-disk format this reader accepts; other versions are discarded. */
const CHECKIN_FORMAT_VERSION = 1

/** One account's last successful check-in. */
export interface WorkBuddyCheckinRecord {
  /** The upstream's own day, `YYYY-MM-DD` in the machine's local zone. */
  day: string
  /** Epoch ms of the check-in that produced this record. */
  atMs: number
}

/** The document this store keeps, keyed by variant then account id. */
type CheckinDocument = Record<string, Record<string, WorkBuddyCheckinRecord>>

/** The store's public surface. */
export interface WorkBuddyCheckinStore {
  /** The last recorded check-in for one account, when there is one. */
  recordFor(variant: string, accountId: string): WorkBuddyCheckinRecord | undefined
  /** Remember a successful check-in. */
  remember(variant: string, accountId: string, atMs: number): void
  /** Forget an account, e.g. when it is removed from the pool. */
  forget(variant: string, accountId: string): void
  /**
   * Whether today's check-in is already recorded for this account.
   *
   * @param now - the clock the day is read from; injectable for tests.
   */
  doneToday(variant: string, accountId: string, now?: number): boolean
}

/** `YYYY-MM-DD` in the machine's local zone. */
export function localDay(atMs: number): string {
  const date = new Date(atMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * The store's path under the plugin's home, for one variant.
 *
 * One file per variant, following the plugin's other stores: the two products'
 * accounts share an id namespace, so a shared document would let a CN account's
 * record answer for an international one with the same uid.
 *
 * @param filename - the variant's own filename (see variants.ts).
 */
export function workbuddyCheckinPath(filename = '.workbuddy-checkin.json'): string {
  return join(resolveDshHome(), filename)
}

/** Read the stored document, or an empty one when nothing usable is there. */
function load(path: string): CheckinDocument {
  const picked = readStoreDocument(path, CHECKIN_FORMAT_VERSION, document => {
    const records = document['records']
    return isJsonObject(records) ? records : undefined
  })
  if (picked === undefined) return {}
  const out: CheckinDocument = {}
  for (const [variant, rows] of Object.entries(picked)) {
    if (!isJsonObject(rows)) continue
    const row = rows
    if (row === undefined) continue
    const clean: Record<string, WorkBuddyCheckinRecord> = {}
    for (const [accountId, value] of Object.entries(row)) {
      if (!isJsonObject(value)) continue
      const record = value
      if (record === undefined) continue
      const day = record['day']
      const atMs = record['atMs']
      // A record missing either half is not a record: an undated one could not
      // answer "was this today", which is the only question this store serves.
      if (typeof day !== 'string' || typeof atMs !== 'number' || !Number.isFinite(atMs)) continue
      clean[accountId] = { day, atMs }
    }
    out[variant] = clean
  }
  return out
}

/**
 * Create the store.
 *
 * @param path - the document's path; defaults to the plugin's own file.
 */
export function createWorkBuddyCheckinStore(path: string = workbuddyCheckinPath()): WorkBuddyCheckinStore {
  const read = (): CheckinDocument => load(path)

  return {
    recordFor(variant, accountId) {
      return read()[variant]?.[accountId]
    },
    remember(variant, accountId, atMs) {
      const document = read()
      const rows = document[variant] ?? {}
      rows[accountId] = { day: localDay(atMs), atMs }
      document[variant] = rows
      writeStoreDocument(path, { version: CHECKIN_FORMAT_VERSION, records: document })
    },
    forget(variant, accountId) {
      const document = read()
      const rows = document[variant]
      if (rows === undefined || !(accountId in rows)) return
      delete rows[accountId]
      writeStoreDocument(path, { version: CHECKIN_FORMAT_VERSION, records: document })
    },
    doneToday(variant, accountId, now = Date.now()) {
      const record = read()[variant]?.[accountId]
      return record !== undefined && record.day === localDay(now)
    },
  }
}
