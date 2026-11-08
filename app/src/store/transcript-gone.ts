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
 * P14 refinement (owner ruling 2026-11-08, "修 verdict 生命周期"):
 * - A gone verdict stamped with P10 index evidence (the by-id read 404'd
 *   while the owner index named ANOTHER profile) is cross-profile by
 *   construction: a list page that surfaces the id on that OTHER profile is
 *   the very proof the session is NOT on the read profile, so such a verdict
 *   survives `recordTranscriptAlive` — the plain P12 rule would retire it
 *   on the same refresh that keeps re-arming it, the per-turn 404 observed
 *   on 9200.
 * - A verdict with no owner evidence (index miss at read time) keeps the
 *   plain P12 rule: any list page that still lists the id retires it.
 * - `resetTranscriptGone` clears both sets (gateway switch wipes everything).
 *
 * Deliberate limit (documented, not a leak): the 404 is profile-scoped —
 * "not on the ACTIVE profile" — while the reset signal is list-scoped. If
 * the list refresh does not surface the id (e.g. beyond the 500-row
 * window) the verdict survives until the next gateway switch. That is the
 * accepted conservative posture: no re-reading, no N-way cascade.
 */
import { getApiRequestProfile, type ProfileScope } from '@/api/client'
import { lookupSessionOwnerProfile } from '@/store/session-owner-index'

const goneIds = new Set<string>()

/**
 * id → owning profile stamped when a by-id read 404'd while the P10 index
 * named a DIFFERENT profile (cross-profile verdict, survives list pages).
 */
const goneOwnerProfile = new Map<string, string>()

/** Record that a by-id transcript read 404'd (the id is absent on the read profile). */
export function markTranscriptGone(id: string, evidence?: { ownerProfile?: string }): void {
  const normalized = id.trim()

  if (!normalized) {
    return
  }

  goneIds.add(normalized)

  if (evidence?.ownerProfile) {
    goneOwnerProfile.set(normalized, evidence.ownerProfile)
  }
}

/** The re-reads skip ids with a live gone verdict. */
export function isTranscriptGone(id: string): boolean {
  return goneIds.has(id.trim())
}

/**
 * P12: a by-id transcript read's ERROR is a gone claim (404 / not-found /
 * the P14 gate's synthetic SESSION_NOT_FOUND). Callers of this module's
 * public arm points already parse their own error text (use-background-sync
 * keeps its P12 discriminator local); this helper serves the store-internal
 * stamp path below.
 */
function isGoneError(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null | undefined)?.message ?? error)

  return /\b404\b|not[ -]?found|session not found/i.test(message)
}

/**
 * Stamp one verdict for a failed by-id read: when the P10 index names the
 * id's owning profile AT THE MOMENT the read 404'd and it differs from the
 * effective read profile, the verdict carries owner evidence (survives list
 * pages); otherwise it stays plain P12 (retire-on-page-sighted).
 * Non-404 errors (network, RPC, backend down) arm nothing — only a gone
 * claim is a verdict.
 */
export function armTranscriptGone(id: string, profile: ProfileScope | undefined, error: unknown): void {
  if (!isGoneError(error)) {
    return
  }

  const normalized = id.trim()

  if (!normalized) {
    return
  }

  const effectiveProfile =
    profile != null && typeof profile === 'object' ? profile.profile : typeof profile === 'string' ? profile : getApiRequestProfile()

  const ownerProfile = lookupSessionOwnerProfile(normalized)

  if (ownerProfile && effectiveProfile && ownerProfile !== effectiveProfile) {
    markTranscriptGone(normalized, { ownerProfile })
  } else {
    markTranscriptGone(normalized)
  }
}

/**
 * Retire verdicts for ids a fresh list page still lists (the session came
 * back on some profile — re-reads resume on the next tick). Ids absent from
 * the page keep their verdict (A: no blanket clear on every tick).
 *
 * P14 refinement: a verdict carrying owner evidence (cross-profile by
 * construction — the list page is the proof, not the counter-evidence) is
 * NOT retired here. Only plain index-miss 404 verdicts are.
 */
export function recordTranscriptAlive(ids: Iterable<string>): void {
  for (const id of ids) {
    const normalized = id.trim()

    if (!normalized) {
      continue
    }

    if (goneOwnerProfile.has(normalized)) {
      continue
    }

    goneIds.delete(normalized)
  }
}

/** Drop every verdict (gateway switch: the outgoing backend's state.db is gone). */
export function resetTranscriptGone(): void {
  goneIds.clear()
  goneOwnerProfile.clear()
}

/** Test seam. */
export function __resetTranscriptGoneForTests(): void {
  resetTranscriptGone()
}
