/**
 * P10 — session id → owning-profile index, backed by the native
 * `/api/profiles/sessions` endpoint (one request across every profile, each
 * row tagged with its owning `profile`).
 *
 * Why this exists: a by-id read (`GET /api/sessions/<id>?profile=<p>`) must
 * name the owning profile. Before P10 the resolver had two rungs for an
 * unknown id — a cached sidebar row (owner pinned) or a fan-out that tried
 * every profile until one answered (P1–P5 era). That fan-out is the
 * "N concurrent 404s" the owner rejected repeatedly (ruling 2026-11-04/05):
 * default and every other profile are independent stores, and probing them in
 * sequence is how a single 404 became a 10-request cascade.
 *
 * P10 replaces the fan-out with a LOOKUP: this index says "session X lives on
 * profile P" from data the native endpoint already returns. A cache-missed
 * by-id read therefore costs at most:
 *   1. one silent `/api/profiles/sessions` backfill (deduped, at most once per
 *      probe and once per ABSENT_TTL_MS after a confirmed miss), and
 *   2. one owner-pinned by-id read on the profile the lookup named.
 * No per-profile probing, ever. A miss that survives the backfill stays
 * `inconclusive` (P8 fail-closed posture): the session is opened by switching
 * profiles in the UI, not by re-sweeping.
 */

const ABSENT_TTL_MS = 30_000
const BACKFILL_LIMIT = 500 // native endpoint page cap; covers the recency window that matters for clicks

/** id → owning profile, from any successful `/api/profiles/sessions` page. */
const ownerIndex = new Map<string, string>()

/** id → timestamp of a backfill that did NOT contain the id (confirmed absent). */
const absentSince = new Map<string, number>()

/** One in-flight backfill (module-wide: every backfill asks the SAME native
 *  endpoint for the same unified page, so one dedupes the burst). */
const backfillInflight = new Map<string, Promise<void>>()

/**
 * Merge one list page into the index. Rows without a profile tag belong to
 * the ambient store of the scope that served them (single-profile install
 * tags every row "default"; the unified list always carries the tag, so this
 * branch is the legacy single-profile fallback only).
 *
 * A page that CONTAINS an id outranks any prior "confirmed absent" verdict for
 * it (the session may have been created since the last backfill).
 */
export function recordSessionOwners(rows: ReadonlyArray<{ id?: string; profile?: string }>): void {
  for (const row of rows) {
    const id = row.id?.trim()

    if (!id) {
      continue
    }

    const profile = row.profile?.trim()

    ownerIndex.set(id, profile || 'default')
    absentSince.delete(id)
  }
}

/** Remember that a backfill page just ran and did NOT contain this id. */
export function recordSessionAbsent(id: string): void {
  absentSince.set(id, Date.now())
}

/** The profile a backfill named for this id, or undefined when unknown. */
export function lookupSessionOwnerProfile(id: string): string | undefined {
  const normalized = id.trim()

  if (!normalized) {
    return undefined
  }

  return ownerIndex.get(normalized)
}

/** The production backfill: one unified /api/profiles/sessions page across
 *  every profile, folded into the index. Injectable so module callers with
 *  their own API surface (and tests with spies) can substitute. The lazy
 *  import keeps this module free of a static api/sessions dependency
 *  (api/sessions.ts imports this index — a cycle the static form would close). */
export const defaultOwnerIndexBackfill: (id: string) => Promise<void> = async id => {
  const { listAllProfileSessions } = await import('@/api/sessions')
  const page = await listAllProfileSessions(BACKFILL_LIMIT, 0, 'include', 'recent', 'all', {}, 0)

  recordSessionOwners(page.sessions)

  void id
}

function isAbsentFresh(id: string): boolean {
  const stamp = absentSince.get(id)

  return stamp !== undefined && Date.now() - stamp < ABSENT_TTL_MS
}

/**
 * Resolve the owning profile for a cache-missed id:
 *  - index hit → the profile, no network;
 *  - index miss → one silent `/api/profiles/sessions` backfill (deduped,
 *    skipped while a confirmed-absent verdict is fresh), then re-check;
 *  - still missing → undefined (the caller stays fail-closed).
 *
 * The backfill is injectable (a caller in a module that already imports the
 * API surface passes its own reference; tests pass a spy) — a lazy dynamic
 * import here would escape the API layer's module graph and break both the
 * mock seams and Electron's native-module externals.
 *
 * The backfill is silent by design: it is a recovery read, not user-visible
 * work, and it must never surface a toast or block the open action. A list
 * failure resolves undefined rather than rejecting — a broken list endpoint
 * degrades to P8 behavior, it does not turn a 404 cascade back on.
 */
export async function ensureSessionOwnerIndexed(
  id: string,
  backfill: (id: string) => Promise<void> = defaultOwnerIndexBackfill
): Promise<string | undefined> {
  const normalized = id.trim()

  if (!normalized) {
    return undefined
  }

  const known = lookupSessionOwnerProfile(normalized)

  if (known) {
    return known
  }

  if (isAbsentFresh(normalized)) {
    return undefined
  }

  const inflight = backfillInflight.get('all')

  if (inflight) {
    await inflight.catch(() => undefined)

    return lookupSessionOwnerProfile(normalized)
  }

  const task = (async () => {
    await backfill(normalized)

    if (lookupSessionOwnerProfile(normalized) === undefined) {
      recordSessionAbsent(normalized)
    }
  })()

  backfillInflight.set('all', task)

  try {
    await task.catch(() => undefined)
  } finally {
    if (backfillInflight.get('all') === task) {
      backfillInflight.delete('all')
    }
  }

  return lookupSessionOwnerProfile(normalized)
}

/** Drop every verdict for the outgoing connection (called from the gateway
 *  switch wipe so a re-dialed backend starts clean). */
export function resetSessionOwnerIndex(): void {
  ownerIndex.clear()
  absentSince.clear()
  backfillInflight.clear()
}

/** Test seam: clear index + absent + inflight without touching anything else. */
export function __resetSessionOwnerIndexForTests(): void {
  resetSessionOwnerIndex()
}
