/**
 * P10 — session-owner index: the id→profile lookup that replaces the P1–P5
 * cross-profile 404 fan-out.
 *
 *  - `recordSessionOwners` folds a native /api/profiles/sessions page into the
 *    index;
 *  - `ensureSessionOwnerIndexed(id, backfill)` resolves the owning profile for
 *    a cache-missed id: index hit → no network; miss → one silent backfill
 *    (deduped, gated by a fresh absent verdict) → re-check;
 *  - the backfill is injectable so tests drive the index with spies instead of
 *    racing the mocked @/hermes module graph.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetSessionOwnerIndexForTests,
  ensureSessionOwnerIndexed,
  lookupSessionOwnerProfile,
  recordSessionOwners
} from '@/store/session-owner-index'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  __resetSessionOwnerIndexForTests()
  vi.useRealTimers()
})

/** A backfill that records calls and returns the page it was told to serve. */
function makeBackfill(page: { id: string; profile: string }[], opts: { reject?: boolean; delayMs?: number } = {}) {
  const calls: Array<{ id: string }> = []
  let resolvePending: (() => void) | undefined

  const backfill = vi.fn(async (id: string) => {
    calls.push({ id })

    if (opts.reject) {
      throw new Error('list 503')
    }

    if (opts.delayMs && resolvePending) {
      await new Promise<void>(resolve => {
        resolvePending = resolve
      })
    }

    recordSessionOwners(page)
  })

  return { backfill, calls, release: () => resolvePending?.() }
}

describe('recordSessionOwners + lookupSessionOwnerProfile', () => {
  it('maps ids to profiles from a list page; untagged rows fall to default', () => {
    recordSessionOwners([{ id: 'a', profile: 'coder' }, { id: 'b' }])

    expect(lookupSessionOwnerProfile('a')).toBe('coder')
    expect(lookupSessionOwnerProfile('b')).toBe('default')
    expect(lookupSessionOwnerProfile('c')).toBeUndefined()
  })
})

describe('ensureSessionOwnerIndexed', () => {
  it('resolves an index hit without any backfill', async () => {
    recordSessionOwners([{ id: 'x', profile: 'coder' }])
    const { backfill } = makeBackfill([])

    const profile = await ensureSessionOwnerIndexed('x', backfill)

    expect(profile).toBe('coder')
    expect(backfill).not.toHaveBeenCalled()
  })

  it('backfills once on a miss, then pins the owner from the page', async () => {
    const { backfill } = makeBackfill([{ id: 'y', profile: 'work' }])

    const profile = await ensureSessionOwnerIndexed('y', backfill)

    expect(profile).toBe('work')
    expect(backfill).toHaveBeenCalledTimes(1)
    expect(backfill).toHaveBeenCalledWith('y')
  })

  it('stays fail-closed when the backfilled page does not contain the id', async () => {
    const { backfill } = makeBackfill([])

    const profile = await ensureSessionOwnerIndexed('ghost', backfill)

    expect(profile).toBeUndefined()
    expect(backfill).toHaveBeenCalledTimes(1)
  })

  it('skips the backfill while a confirmed-absent verdict is fresh', async () => {
    const { backfill } = makeBackfill([])

    await ensureSessionOwnerIndexed('ghost', backfill)
    backfill.mockClear()

    // Within the absent TTL: no second backfill.
    vi.advanceTimersByTime(5_000)

    const profile = await ensureSessionOwnerIndexed('ghost', backfill)

    expect(profile).toBeUndefined()
    expect(backfill).not.toHaveBeenCalled()
  })

  it('re-runs the backfill after the absent verdict lapses', async () => {
    const { backfill } = makeBackfill([])

    await ensureSessionOwnerIndexed('ghost', backfill)
    backfill.mockClear()

    vi.advanceTimersByTime(31_000)

    const profile = await ensureSessionOwnerIndexed('ghost', backfill)

    expect(profile).toBeUndefined()
    expect(backfill).toHaveBeenCalledTimes(1)
  })

  it('dedupes a burst of misses onto one backfill', async () => {
    const { backfill, release } = makeBackfill([], { delayMs: 1 })
    const p1 = ensureSessionOwnerIndexed('i1', backfill)
    const p2 = ensureSessionOwnerIndexed('i2', backfill)
    const p3 = ensureSessionOwnerIndexed('i3', backfill)

    vi.advanceTimersByTime(50)
    release()

    const results = await Promise.all([p1, p2, p3])

    expect(results).toEqual([undefined, undefined, undefined])
    expect(backfill).toHaveBeenCalledTimes(1)
  })

  it('degrades to P8 (no owner) when the backfill itself fails', async () => {
    const { backfill } = makeBackfill([], { reject: true })

    const profile = await ensureSessionOwnerIndexed('z', backfill)

    expect(profile).toBeUndefined()
  })
})
