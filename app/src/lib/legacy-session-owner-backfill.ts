/**
 * One-shot durable owner backfill for legacy NULL-profile session rows
 * (#94724 legacy-session migration).
 *
 * The #95407 durable-ownership work made owner resolution fail closed under
 * registry topology, but shipped no migration for rows minted BEFORE
 * ownership existed (`profile_name = NULL` in state.db). On any install with
 * ≥2 registered connections every one of those rows became unresumable — the
 * reporter's install had 1,120 of 1,122 rows stranded with their transcripts
 * fully intact.
 *
 * This module is the desktop half of the migration: at enumeration time,
 * when a served page contains legacy unowned rows AND the owner is a single
 * match (see `resolveLegacyOwnerBackfillScope`), ask that backend — over the
 * existing session-update REST surface — to stamp its own legacy rows with
 * its own serving-profile identity. Ambiguous topologies are left alone
 * (fail closed); the read-only stored-transcript path keeps their history
 * reachable.
 *
 * The request is one-shot per (connection, profile) scope per renderer:
 * the server side is idempotent and never overwrites a non-NULL owner, so a
 * repeat is harmless but pointless. A transport failure re-arms the scope so
 * the next refresh retries; a backend without the endpoint (version skew) or a
 * backend that refuses offline maintenance because it owns the profile (409,
 * the steady state while that gateway runs) stays armed-off for this renderer
 * lifetime — retrying either every enumeration is a request storm the backend
 * will keep refusing.
 */
import { getApiRequestConnection, hermesApi } from '@/api/client'
import { isMissingRestEndpoint, isOfflineMaintenance } from '@/lib/gateway-rpc'
import { resolveLegacyOwnerBackfillScope } from '@/lib/session-owner-stamp'
import { $connectionsRegistry, hasRegistryTopology } from '@/store/connection-registry-state'

const attemptedScopes = new Set<string>()
// One transient-failure re-arm cycle per scope per window, not per
// enumeration. A wedged/mid-restart backend that keeps 5xxing this POST must
// not be re-probed on every reconnect backoff tick or turn-settle refresh —
// that churn republishes the session stores continuously and drives the
// tap-scheduler "Maximum update depth" loop. 30s is long enough to ride out
// a short restart without pinning a permanently-broken scope for the whole
// renderer lifetime.
const COOLDOWN_MS = 30_000
const failedScopes = new Set<string>()

/** Test seam: forget which scopes were already backfilled this renderer. */
export function resetLegacyOwnerBackfillAttempts(): void {
  attemptedScopes.clear()
  failedScopes.clear()
}

function scopeKey(connectionId: null | string, profile: null | string): string {
  return `${connectionId ?? 'local'}::${profile ?? ''}`
}

/**
 * Fire-and-forget: enumeration paths call this on every served page. It is
 * synchronous-cheap on the no-op paths (no registry topology, scope already
 * attempted) and never blocks or fails the list request that triggered it.
 */
export function maybeBackfillLegacySessionOwners(): void {
  const scope = resolveLegacyOwnerBackfillScope({
    hasRegistryTopology: hasRegistryTopology(),
    registryConnectionIds: ($connectionsRegistry.get()?.connections ?? []).map(
      (connection: { id: string }) => connection.id
    ),
    servingConnectionId: getApiRequestConnection()
  })

  if (!scope) {
    return
  }

  const key = scopeKey(scope.connectionId, scope.profile)

  if (attemptedScopes.has(key)) {
    return
  }

  attemptedScopes.add(key)

  void hermesApi<{ ok: boolean; profile: string; stamped: number }>({
    ...(scope.connectionId ? { connectionId: scope.connectionId } : {}),
    ...(scope.profile ? { profile: scope.profile } : {}),
    path: '/api/sessions/owner-backfill',
    method: 'POST',
    body: scope.profile ? { profile: scope.profile } : {}
  })
    .then(result => {
      if (result.stamped > 0) {
        console.info(
          `[legacy-session-owner-backfill] stamped ${result.stamped} legacy session row(s) ` +
            `with profile "${result.profile}" on ${scope.connectionId ?? 'the primary backend'}`
        )
      }
    })
    .catch(error => {
      // Terminal for this scope: version skew (no endpoint) or the owning
      // gateway's 409 maintenance refusal. Keep the scope marked so we don't
      // re-probe a route that will answer the same way every refresh.
      if (isMissingRestEndpoint(error) || isOfflineMaintenance(error)) {
        return
      }

      // A 401/403 means the serving session died — re-arming would rebuild a
      // request storm until the next enumeration (the boot loop re-enumerates
      // sessions on every reconnect backoff tick). Mark it terminal instead;
      // it re-arms automatically on the next renderer.
      const status = (error as { status?: number } | null)?.status

      if (status === 401 || status === 403) {
        return
      }

      // Transient failure: re-arm so the next enumeration retries — but with a
      // cooldown, not immediately. The enumerations that trigger this call
      // (refreshSessions on every reconnect backoff tick, turn-settle refreshes,
      // gateway-switch re-adoptions) run every few seconds while a backend is
      // wedged/mid-restart; re-arming with zero backoff turns one transient
      // 5xx/timeout into a request storm that republishes the session stores on
      // every tick, which in turn drives the tap-scheduler "Maximum update
      // depth" loop. Re-try only once per COOLDOWN_MS; a still-failing scope
      // keeps quiet (marked attempted) instead of re-firing every enumeration.
      if (failedScopes.has(key)) {
        return
      }

      failedScopes.add(key)

      setTimeout(() => {
        failedScopes.delete(key)
        attemptedScopes.delete(key)
      }, COOLDOWN_MS).unref?.()
    })
}
