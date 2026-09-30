/**
 * Group-room history backfill (t_9ef85962, P0).
 *
 * On a cold start (fresh browser / Android WebView, localStorage cleared) a
 * group room renders EMPTY even though the authoritative full history already
 * lives, per member, in that member profile's own state.db — in the hidden
 * `Group: <roomId> · <thread>` sessions the room engine already uses for its
 * turns. The 48KB ui_meta projection is a deliberately-bounded mirror for
 * OTHER clients, not the source of truth. So when a room's log is empty we
 * reconstruct the timeline the same way "ordinary session" history loads:
 *
 *   1. `session.list` — hidden, scoped to the member's profile, exact title —
 *      confirms the per-group session and its stored id (tui_gateway/
 *      methods_session.py; the REST /api/sessions only reads the default
 *      profile, so this MUST go over the WS RPC path).
 *   2. `session.resume` — `lazy: true` (DB-only, no agent build across the 6
 *      members) — reads the full transcript back.
 *   3. parse each member's transcript into room entries and merge into the
 *      room log, persisting locally so the room survives the reload.
 *
 * Transcript shape (grounded in real state.db dumps): a member's per-group
 * session stores the room delta INSIDE its role=user prompt lines — the
 * `buildGroupChatTurnPrompt` output, "New messages in the room since your last
 * turn (oldest first):" followed by two-space-indented `Speaker: text` lines
 * (`You (user): …`, `Reviewer: …`, …) whose text can span many lines — and the
 * member's own reply as the following role=assistant row. `timestamp` is in
 * SECONDS on the wire.
 */

import { $groupChats, updateGroupChat } from './group-chat'
import { requestForBot } from './routing'
import type { GroupChat, GroupMember, GroupMessage, GroupMessageAuthor } from './types'

/** One transcript row as `session.resume` projects it — the gateway's own
 *  shape, not the plugin's GroupMessage. `text` is the rendered projection;
 *  `content` is the raw (string on most providers, part-array on the rest);
 *  `timestamp` is seconds. */
export interface GroupHistoryTranscriptMessage {
  content?: string | Array<string | { text?: string }>
  role?: string
  timestamp?: number
  text?: string
}

// ── wire shapes (the subset backfill consumes) ──────────────────────────────
interface SessionListRow {
  id: string
  resolved_id?: null | string
  title: string
}

interface SessionListResult {
  sessions?: SessionListRow[]
}

interface SessionResumeResult {
  inflight?: unknown
  messages?: GroupHistoryTranscriptMessage[]
  running?: boolean
  session_id?: string
}

const DELTA_HEADER = 'New messages in the room since your last turn'
const RULES_FOOTER = 'Rules for this room'
/** A delta entry: exactly two spaces, the speaker word, an optional "(user)"
 *  marker, a colon. Anything else — deeper indent, a column-0 continuation, a
 *  code fence, a blank line — is part of the current speaker's text. */
const DELTA_ENTRY_RE = /^  ([A-Za-z0-9_\-]+)(\s+\(user\))?:\s?(.*)$/

/** Main backfill thread. Pre-thread rooms store the whole room under the
 *  'legacy' thread (the `ensureGroupChatSession` title convention). */
export const GROUP_HISTORY_THREAD = 'legacy'

function messageText(message: GroupHistoryTranscriptMessage): string {
  if (typeof message.text === 'string') {
    return message.text
  }

  const content = message.content

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('')
  }

  return ''
}

function isPass(text: string): boolean {
  const trimmed = String(text || '').trim()

  return /^\(?pass\)?\.?$/i.test(trimmed)
}

function toMillis(timestamp?: number): number {
  return typeof timestamp === 'number' && timestamp > 0 ? timestamp * 1000 : 0
}

/** Reconstruct room entries from one member's per-group transcript.
 *
 *  role=user rows carry the room delta (every OTHER speaker's new lines,
 *  formatted by `formatGroupChatLine` — `You (user): …` / `Name: …`, indented
 *  two spaces, multi-line text folded in). role=assistant rows are THIS
 *  member's own reply. A `(pass)` reply is a settled turn and adds nothing.
 *  A bare user prompt with no delta header is unattributed — there is nothing
 *  to backfill from it. */
export function parseGroupHistoryTranscript(
  memberName: string,
  thread: string,
  messages: GroupHistoryTranscriptMessage[]
): GroupMessage[] {
  const threadName = thread || GROUP_HISTORY_THREAD
  const entries: GroupMessage[] = []
  let seq = 0

  const push = (from: GroupMessageAuthor, text: string, at: number) => {
    seq += 1

    entries.push({ at, from, id: `ghist-${seq}`, text, thread: threadName })
  }

  for (const message of messages || []) {
    if (message?.role === 'assistant') {
      const text = messageText(message).trim()

      if (!text || isPass(text)) {
        continue
      }

      push({ kind: 'member', name: memberName }, text, toMillis(message.timestamp))
      continue
    }

    if (message?.role !== 'user') {
      continue
    }

    const lines = messageText(message).split('\n')
    const header = lines.findIndex(line => line.includes(DELTA_HEADER))

    // No delta header → a bare user prompt, unattributed: nothing to backfill.
    if (header < 0) {
      continue
    }

    const footer = lines.findIndex((line, index) => index > header && line.includes(RULES_FOOTER))
    const delta = lines.slice(header + 1, footer < 0 ? lines.length : footer)
    const at = toMillis(message.timestamp)
    let current: null | { from: GroupMessageAuthor; text: string } = null
    let hasEntry = false

    const flush = () => {
      if (current && hasEntry) {
        // Drop trailing blank lines: the delta section ends in a blank line
        // before `Rules for this room:`, and a speaker's multi-line text can
        // otherwise inherit it. Internal newlines (code fences, paragraphs)
        // are preserved verbatim.
        const text = current.text.replace(/\n+$/, '')

        if (text.trim()) {
          push(current.from, text, at)
        }
      }

      current = null
    }

    for (const line of delta) {
      const match = line.match(DELTA_ENTRY_RE)

      if (match) {
        flush()

        const [, speaker, userMark, rest] = match

        current = {
          from: userMark ? { kind: 'user', name: 'You' } : { kind: 'member', name: speaker },
          text: rest || ''
        }
        hasEntry = true
      } else if (current && hasEntry) {
        // Continuation of the current speaker's (multi-line) text.
        current.text += '\n' + line
      }
    }

    flush()
  }

  return entries
}

/** Stable dedup key: the same room line reached from two members' transcripts
 *  must not double up. */
function dedupKey(entry: GroupMessage): string {
  return `${entry.thread || GROUP_HISTORY_THREAD}::${entry.from?.kind}::${entry.from?.name}::${entry.text}`
}

/** Merge backfilled entries into a room: dedup against the existing log by
 *  (thread, kind, speaker, text), order oldest-first, and point every
 *  backfilled member's watermark PAST the merged tail so the next live turn
 *  doesn't re-feed the reconstructed history. Pure — the caller commits it
 *  through `updateGroupChat`. */
export function mergeGroupHistoryAdditions(room: GroupChat, additions: GroupMessage[]): GroupChat {
  const existing = Array.isArray(room.log) ? room.log : []
  const known = new Set(existing.map(dedupKey))
  const fresh: GroupMessage[] = []

  for (const addition of additions || []) {
    const key = dedupKey(addition)

    if (known.has(key)) {
      continue
    }

    known.add(key)
    fresh.push(addition)
  }

  const log = [...existing, ...fresh].sort((a, b) => (a.at || 0) - (b.at || 0))
  const watermarks = { ...(room.watermarks || {}) }

  for (const addition of fresh) {
    if (addition.from?.kind !== 'member') {
      continue
    }

    const key = `${addition.thread || GROUP_HISTORY_THREAD}::${addition.from.name}`

    watermarks[key] = Math.max(watermarks[key] || 0, log.length)
  }

  return { ...room, log, watermarks }
}

// Cold-start rooms render empty until this reads each member's per-group
// session. A room can be mounted in two surfaces at once (a main-window tab
// and the in-pane fallback, or a retained pane re-opening) and each would
// otherwise race its member RPCs. Track the in-flight groups so the first
// call runs and a concurrent one rides the same promise.
const backfillInFlight = new Map<string, Promise<number>>()

/** Backfill one room's log from its members' server-side per-group sessions.
 *
 *  Cold-start path: a room whose log is empty (fresh client, cleared
 *  localStorage, or a room populated only on another client) reassembles its
 *  timeline by reading each member's own state.db through the WS RPC path:
 *
 *   1. `session.list` — hidden, scoped to the member's profile — returns that
 *      profile's hidden sessions. (The REST `/api/sessions` reads ONLY the
 *      default profile, so this MUST ride the WS RPC path.)
 *   2. filter the rows to this room's title prefix `Group: <roomId> · `
 *      (the engine's own session-title convention — new rooms title by their
 *      immutable roomId, legacy rooms by the display name), across every
 *      thread,
 *   3. `session.resume` — `lazy: true` (DB-only, no agent build across the 6
 *      members) — pulls each thread's full transcript,
 *   4. parse each member's transcript into room entries and merge into the
 *      room log, persisting locally so the room survives the reload.
 *
 *  Idempotent: a non-empty log is left alone, and a second backfill adds
 *  nothing. A member whose session is mid-turn is skipped (never read a live
 *  transcript); a member with no per-group session yet contributes nothing.
 *  Returns how many room entries the room gained.
 *
 *  `members` is the VIEW's seated roster — on a true cold start the room
 *  record may not exist yet, so the room log and its `members` are not the
 *  reliable source for which profiles to read. The merge is committed with
 *  `sync: false`: the backfill is a LOCAL reconstruction of each member's own
 *  state.db (the source of truth); the bounded 48KB ui_meta mirror is carried
 *  forward by the engine's normal syncs, not a heavy backfill write. */
export async function backfillGroupRoomHistory(group: string, members?: GroupMember[]): Promise<number> {
  const inFlight = backfillInFlight.get(group)

  if (inFlight) {
    return inFlight
  }

  const run = runBackfill(group, members).finally(() => {
    backfillInFlight.delete(group)
  })

  backfillInFlight.set(group, run)

  return run
}

/** The one-shot backfill for one room. Split out so a concurrent open rides
 *  the in-flight promise instead of re-issuing every member's RPCs. */
async function runBackfill(group: string, members?: GroupMember[]): Promise<number> {
  const current = $groupChats.get()[group]
  const roomMembers = members?.length ? members : (current?.members || [])

  // No members to read, or the log is already populated — nothing to backfill.
  if (!roomMembers.length || (current?.log?.length || 0) > 0) {
    return 0
  }

  // The room's own session-title prefix, exactly as the engine mints it:
  // `Group: ${roomId || group} · ${thread}`. Legacy rooms (no roomId) title by
  // the display name, so the prefix resolves the room in both generations.
  const titlePrefix = `Group: ${current?.roomId || group} · `
  const additions: GroupMessage[] = []

  for (const member of roomMembers) {
    const profile = String(member.name || '').trim()

    if (!profile) {
      continue
    }

    let list: SessionListResult

    try {
      // Hidden, per-profile: no exact title — list the profile's hidden
      // sessions and filter to this room client-side (the steer's
      // `title_prefix: 'Group: '` semantics; the contract has no prefix
      // field, so the filter rides the client).
      list = await requestForBot<SessionListResult>(member, 'session.list', {
        include_hidden: true,
        profile
      })
    } catch {
      // A transient lookup failure is not "no session" — skip this member;
      // the next open / retry will read it.
      continue
    }

    const rows = (Array.isArray(list?.sessions) ? list.sessions : []).filter(
      row => typeof row?.title === 'string' && row.title.startsWith(titlePrefix)
    )

    for (const row of rows) {
      const thread = row.title.slice(titlePrefix.length) || GROUP_HISTORY_THREAD

      let snapshot: SessionResumeResult

      try {
        snapshot = await requestForBot<SessionResumeResult>(member, 'session.resume', {
          lazy: true,
          profile,
          // A compression lineage resolves to its tip; resume the tip.
          session_id: row.resolved_id || row.id
        })
      } catch {
        continue
      }

      // Never read a live, mid-turn transcript: it is moving under us.
      if (snapshot?.running) {
        continue
      }

      additions.push(...parseGroupHistoryTranscript(profile, thread, Array.isArray(snapshot?.messages) ? snapshot.messages : []))
    }
  }

  if (!additions.length) {
    return 0
  }

  const before = current?.log?.length || 0
  updateGroupChat(
    group,
    room => {
      const merged = mergeGroupHistoryAdditions(room, additions)

      room.log = merged.log
      room.watermarks = merged.watermarks

      return room
    },
    { sync: false }
  )

  const after = ($groupChats.get()[group]?.log?.length) || 0

  return after - before
}
