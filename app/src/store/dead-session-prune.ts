/**
 * Prune renderer-stored session references whose sessions no longer exist on
 * the backend.
 *
 * Pins (`hermes.desktop.pinnedSessions`), composer drafts
 * (`hermes:composer-drafts:v3`) and queued prompts
 * (`hermes.desktop.composerQueue.v1`) are keyed by session id and re-asserted
 * or probed at boot. When a session is removed from state.db (retention purge,
 * manual delete, another surface pruning it), those keys go stale: nothing
 * ever drops them, so every boot re-requests the dead ids and the gateway
 * answers `404 {"detail":"Session not found"}` once per stale reference,
 * forever.
 *
 * This module sweeps for dead ids after the sidebar list has spoken. A session
 * is declared dead ONLY when a by-id probe 404s on every known profile — a 404
 * is profile-scoped ("not on this profile's state.db"), so a single miss never
 * prunes anything (a session can legitimately live on a non-active profile).
 * Any non-404 probe failure (gateway mid-restart, network) is inconclusive:
 * the id is deferred to a later pass instead of being dropped.
 */

import { getSession } from '@/hermes'
import { mapPool } from '@/lib/pool'
import { clearSessionDraft, stashedDraftScopes } from '@/store/composer'
import { $queuedPromptsBySession, clearQueuedPrompts } from '@/store/composer-queue'
import { $pinnedSessionIds, unpinSession } from '@/store/layout'
import { $profiles, normalizeProfileKey } from '@/store/profile'
import { $sessions } from '@/store/session'

import { forgetPinSyncState } from './session-pin-sync'

const SWEEP_CONCURRENCY = 4
// After the first list payload, let boot settle (pin reconcile, resume probes)
// before probing; later list changes re-sweep debounced.
const FIRST_PASS_DELAY_MS = 2_000
const RERUN_DELAY_MS = 5_000
// How long an 'alive' verdict is trusted. Without expiry, a session deleted
// mid-session would stay cached alive until the next app restart — re-creating
// exactly the boot 404s this prune exists to remove. With expiry, a later
// sweep re-probes and heals it within one TTL.
const ALIVE_TTL_MS = 10 * 60_000

// Ids verified ALIVE this app session, id -> verdict expiry timestamp — later
// sweeps skip re-probing ids whose verdict is still fresh.
const alive = new Map<string, number>()
// Ids verified DEAD (404 on EVERY known profile) at drop time. Unlike the
// in-memory `alive` cache these survive an app restart: their stale local
// reference (a deep link, a persisted pane) is what keeps re-arming the full
// per-profile 404 sweep on every boot. Re-probed only after the profile
// inventory grows (a new profile could now own the id) or after a gateway
// switch (the measured backend is gone).
const dead = new Map<string, Set<string>>()
// Ids currently mid-probe, so overlapping sweeps don't double-probe.
const inFlight = new Set<string>()

let listLoaded = false
// Bumped by resetDeadSessionPrune: in-flight probes from a pre-reset sweep
// must not write verdicts (alive cache, drops) that belong to the OLD backend.
let epoch = 0
// Debounce deadline, clamped to the EARLIEST change since the last pass: a
// busy list that keeps changing must not starve the sweep indefinitely.
let sweepDueAt = 0
let sweepTimer: ReturnType<typeof setTimeout> | undefined

type Verdict = 'alive' | 'dead' | 'unknown'

function isNotFoundError(error: unknown): boolean {
  return /session not found/i.test(error instanceof Error ? error.message : String(error))
}

/**
 * A stored id is dead when a by-id lookup 404s on the CURRENTLY selected
 * profile (P9, owner ruling 2026-11-05/06). Liveness is judged on that
 * profile ONLY — never probed across other profiles: a sweep would use the
 * default profile to read every other profile, which the ruling forbids. A
 * non-404 failure (5xx / network) is `unknown`, never a dead verdict. A
 * session living on another profile is not kept alive here: its local
 * draft/pin is not this profile's to hold.
 */
async function sessionVerdict(id: string): Promise<Verdict> {
  try {
    await getSession(id)

    return 'alive'
  } catch (error) {
    return isNotFoundError(error) ? 'dead' : 'unknown'
  }
}

/** Stored ids no loaded sidebar row covers — the only ids that can be dead. */
function collectCandidates(): string[] {
  const rows = $sessions.get()
  const covered = new Set<string>()

  for (const row of rows) {
    if (row.id) {
      covered.add(row.id)
    }

    if (row._lineage_root_id) {
      covered.add(row._lineage_root_id)
    }
  }

  const candidates = new Set<string>()

  for (const id of $pinnedSessionIds.get()) {
    if (!covered.has(id)) {
      candidates.add(id)
    }
  }

  for (const scope of stashedDraftScopes()) {
    if (!covered.has(scope)) {
      candidates.add(scope)
    }
  }

  for (const key of Object.keys($queuedPromptsBySession.get())) {
    if (!covered.has(key)) {
      candidates.add(key)
    }
  }

  const knownProfiles = new Set($profiles.get().map(profile => normalizeProfileKey(profile.name)))

  return [...candidates].filter(id => {
    const expiresAt = alive.get(id)

    if (expiresAt !== undefined && Date.now() < expiresAt) {
      return false
    }

    if (inFlight.has(id)) {
      return false
    }

    // A remembered dead verdict is trusted only while the profile inventory
    // it was measured against is unchanged: a newly known profile could now
    // own the id, so re-probe once the set grows. (A gateway switch clears
    // `dead` wholesale in resetDeadSessionPrune.)
    const measuredOn = dead.get(id)

    return measuredOn === undefined || ![...measuredOn].every(key => knownProfiles.has(key))
  })
}

function dropDeadId(id: string): void {
  // Cheap re-verification before destructive drops: if a row for this id
  // appeared while the probe was in flight (a session resurrected or a slow
  // page landed), the id is no longer dead — keep every entry.
  const covered = $sessions.get().some(row => row.id === id || row._lineage_root_id === id)

  if (covered) {
    return
  }

  // Forget the pin's sync bookkeeping BEFORE unpinning: the reconcile listener
  // fires synchronously on unpin, and with the id still tracked it would
  // re-PATCH the dead id (a fresh 404 on every boot — the noise we're removing).
  if ($pinnedSessionIds.get().includes(id)) {
    forgetPinSyncState(id)
    unpinSession(id)
  }

  // No-ops for surfaces that don't hold the id — the guards also skip the
  // localStorage write a no-op clear would still perform.
  if (stashedDraftScopes().includes(id)) {
    clearSessionDraft(id)
  }

  if ($queuedPromptsBySession.get()[id]?.length) {
    clearQueuedPrompts(id)
  }
}

async function sweepOnce(requireLoaded = true): Promise<void> {
  if (requireLoaded && !listLoaded) {
    return
  }

  if (typeof window === 'undefined' || !window.hermesDesktop) {
    return
  }

  const sweepEpoch = epoch
  const candidates = collectCandidates()

  if (candidates.length === 0) {
    return
  }

  for (const id of candidates) {
    inFlight.add(id)
  }

  try {
    await mapPool(candidates, SWEEP_CONCURRENCY, async id => {
      if (epoch !== sweepEpoch) {
        return
      }

      const verdict = await sessionVerdict(id)

      // A gateway switch (reset) while this probe was in flight invalidates
      // the verdict — it is about the backend we measured, not the live one.
      if (epoch !== sweepEpoch) {
        return
      }

      if (verdict === 'alive') {
        alive.set(id, Date.now() + ALIVE_TTL_MS)
      } else if (verdict === 'dead') {
        dead.set(id, new Set($profiles.get().map(profile => normalizeProfileKey(profile.name))))
        dropDeadId(id)
      }
      // 'unknown' — neither cached nor dropped; a later sweep retries it.
    })
  } finally {
    for (const id of candidates) {
      inFlight.delete(id)
    }
  }
}

/** Run one prune pass now. Test-only hook — production never calls it. */
export function __runDeadSessionPrunePass(): Promise<void> {
  // Bypass the list-loaded gate WITHOUT mutating `listLoaded` (a mutation
  // here would leak into the watcher's first-payload timing).
  return sweepOnce(false)
}

/**
 * Sweep after the first sidebar payload, then re-sweep (debounced) whenever
 * the list changes — a purge while the app is running heals within one pass.
 * Call once per app, next to `watchSessionPins`. Returns the store unsubscribe
 * (used by tests).
 */
export function watchDeadSessionPrune(): () => void {
  return $sessions.listen(() => {
    const firstPayload = !listLoaded
    listLoaded = true

    const delay = firstPayload ? FIRST_PASS_DELAY_MS : RERUN_DELAY_MS

    // Clamp to the EARLIEST change since the last pass: constant list churn
    // must delay the sweep, not starve it.
    const dueAt = Date.now() + delay
    const nextDueAt = sweepTimer ? Math.min(sweepDueAt, dueAt) : dueAt

    if (sweepTimer && nextDueAt !== sweepDueAt) {
      clearTimeout(sweepTimer)
      sweepTimer = undefined
    }

    sweepDueAt = nextDueAt

    // Exactly one timer at a time: a churn that doesn't move the deadline
    // keeps the existing timer instead of stacking a second one.
    if (!sweepTimer) {
      sweepTimer = setTimeout(
        () => {
          sweepDueAt = 0
          sweepTimer = undefined
          void sweepOnce()
        },
        Math.max(0, nextDueAt - Date.now())
      )
    }
  })
}

/**
 * Forget probe results, because the backend they were measured against is
 * gone. `alive` means "alive on the gateway we probed"; a switched gateway has
 * its own state.db and must be re-probed from scratch.
 */
export function resetDeadSessionPrune(): void {
  epoch += 1
  alive.clear()
  inFlight.clear()
  listLoaded = false

  if (sweepTimer) {
    clearTimeout(sweepTimer)
    sweepTimer = undefined
  }

  sweepDueAt = 0
}
