/**
 * P12 — per-session "transcript confirmed gone" set, for the live-sync
 * tick-driven transcript re-reads (`reconcileActiveTranscript` /
 * `reconcileTileTranscripts`).
 *
 * Why this exists: when the ACTIVE stored session id is absent from the
 * profile the UI is standing on (a coder session opened from a remembered
 * value while default is active), every `sessions.changed` tick re-fires a
 * by-id `/messages?limit=120` read that 404s — P11 already cleared the
 * remembered-id cold-start path, but the tick path had no verdict, so the
 * 404 kept re-reading on every tick. A confirmed 404 ("this id is not on
 * this profile right now") is recorded here and the re-reads skip it.
 *
 * Reset policy (owner ruling "A", 2026-11-06):
 *  - the verdict is per-backend: `resetTranscriptGone()` runs in the
 *    gateway-switch wipe, exactly like the P10 owner index — a re-dialed
 *    backend has a different state.db and the old verdict must not gate it;
 *  - a verdict is retired per-id only when the list page that feeds it
 *    says the id is back: `recordTranscriptAlive(ids)` is called from the
 *    same P10 owner-index feeders (`recordSessionOwners` callers already
 *    stamp every row, the session list is re-pulled on every
 *    sessions.changed tick), so a session that reappears on any profile's
 *    list resumes re-reading on the next tick.
 *
 * Deliberate limit (documented, not a leak): the 404 is profile-scoped —
 * "not on the ACTIVE profile" — while the reset signal is list-scoped. If
 * the list refresh does not surface the id (e.g. beyond the 500-row
 * window) the verdict survives until the next gateway switch. That is the
 * accepted conservative posture: no re-reading, no N-way cascade.
 */

const goneIds = new Set<string>()

/** Record that a by-id transcript read 404'd (the id is absent on the read profile). */
export function markTranscriptGone(id: string): void {
  const normalized = id.trim()

  if (normalized) {
    goneIds.add(normalized)
  }
}

/** The re-reads skip ids with a live gone verdict. */
export function isTranscriptGone(id: string): boolean {
  return goneIds.has(id.trim())
}

/**
 * Retire verdicts for ids a fresh list page still lists (the session came
 * back on some profile — re-reads resume on the next tick). Ids absent
 * from the page keep their verdict (A: no blanket clear on every tick).
 */
export function recordTranscriptAlive(ids: Iterable<string>): void {
  for (const id of ids) {
    const normalized = id.trim()

    if (normalized) {
      goneIds.delete(normalized)
    }
  }
}

/** Drop every verdict (gateway switch: the outgoing backend's state.db is gone). */
export function resetTranscriptGone(): void {
  goneIds.clear()
}

/** Test seam. */
export function __resetTranscriptGoneForTests(): void {
  resetTranscriptGone()
}
