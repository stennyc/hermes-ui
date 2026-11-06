import type { SessionInfo } from '@/types/hermes'

/**
 * Returns the session safe to remember/restore: a delegate child
 * (`source === 'subagent'`) is replaced by its parent, everything else keeps
 * its own id. Delegate children are deliberately omitted from the sidebar list
 * (`_LISTABLE_CHILD_SQL`), so remembering one leaves the next cold start split
 * between the highlighted parent and the invisible child the chat area shows
 * (#56983). `/branch` children also carry `parent_session_id` but ARE
 * user-facing — `source`, not parenthood, is the discriminator.
 *
 * Accepts metadata fetched directly by id (`getSession`): the by-id endpoint
 * serves delegate children even though the list does not, so this repairs a
 * stale child id without the sidebar list. `null` means "do not remember"
 * (an orphaned delegate child whose parent is gone).
 */
export async function resolveRememberedSessionId(
  id: string,
  getSession: (id: string) => Promise<SessionInfo>,
  /**
   * Distinguishes "this profile has no such session" (an authoritative 404) from
   * "the read itself failed" (network / RPC). When provided and it matches, a
   * missed by-id read RESOLVES to null — the caller clears the remembered value
   * — instead of rejecting and forcing it to survive for the next launch. The
   * discriminator is the caller's (it knows its getSession error contract); a
   * missing argument keeps the historical reject-on-any-failure behavior.
   */
  isSessionGone?: (error: unknown) => boolean
): Promise<null | string> {
  let session: SessionInfo

  try {
    session = await getSession(id)
  } catch (error) {
    if (isSessionGone?.(error)) {
      return null
    }

    throw error
  }

  return session.source === 'subagent' ? (session.parent_session_id ?? null) : session.id
}
