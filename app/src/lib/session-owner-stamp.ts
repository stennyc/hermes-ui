import type { SessionInfo } from '@/types/hermes'

/**
 * THE canonical write path for tagging backend-returned session rows with the
 * registry connection that owns them (the read counterpart is
 * `sessionOwnerRouteFromRow` in store/session-request-router).
 *
 * Every other `connection_id` writer works from an EXACT captured owner route
 * (the optimistic row in upsertOptimisticSession, the cache patch in
 * use-session-actions/utils, the mergeSessionPage carry) — those are
 * authoritative and this helper must never clobber them, so a row that
 * already names an owner is returned untouched. Only untagged rows served by
 * an active NON-local source get stamped: the gateway's HTTP APIs correctly
 * know nothing about Desktop-local registry ids, and an untagged remote row
 * would let a later resume fall back to a same-named local profile
 * ("session not found" on turn two). `local` is never stamped here — a bare
 * local row already routes correctly while local is the primary, and a `local`
 * tag would only pin it against the fail-closed owner resolution. The one
 * exception, `local` serving as a registry SECONDARY, is stamped by its caller
 * (`stampProjectSessions` in store/projects), because there a bare row would
 * route to the remote primary.
 */
export function stampRowsWithOwningConnection(
  sessions: SessionInfo[],
  connectionId: null | string | undefined
): SessionInfo[] {
  const owner = String(connectionId ?? '').trim()

  if (!owner || owner === 'local') {
    return sessions
  }

  return sessions.map(session => (session.connection_id?.trim() ? session : { ...session, connection_id: owner }))
}


