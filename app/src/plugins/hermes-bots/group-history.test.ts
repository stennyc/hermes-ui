import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as groupChat from './group-chat'
import { createGroupGateway, runTimersInline, scriptedStorage } from './group-test-utils'
import type { GatewayOptions, ScriptedGateway } from './group-test-utils'
import type { GroupChat, GroupMessage } from './types'

// Group-room history backfill (t_9ef85962 P0). On a cold start (fresh browser /
// Android WebView, no localStorage) a room renders EMPTY even though the
// authoritative full history sits in each member profile's own state.db, in the
// hidden `Group: <roomId> · <thread>` sessions the room engine already uses for
// its turns. The 48KB ui_meta projection is a deliberately-bounded mirror for
// OTHER clients, not the source of truth. So when a room's log is empty we
// reconstruct the timeline the way "ordinary session" history loads:
// session.list (hidden, per-member profile) confirms the per-group session and
// its size, session.resume by that id reads the full transcript, we parse each
// member's transcript into room entries, and merge them into the room log.
//
// Transcript shape (grounded in real state.db dumps): a member's per-group
// session stores the room delta inside its role=user prompt lines —
// "New messages in the room since your last turn (oldest first):" followed by
// indented `Speaker: text` lines (`You (user): …`, `Devops: …`, …) — and its
// own reply as the following role=assistant line. `timestamp` is SECONDS.

const { host } = vi.hoisted(() => ({ host: {} as Record<string, unknown> }))

vi.mock('@hermes/plugin-sdk', async () => {
  const { pluginSdkMock } = await import('./group-test-utils')

  return pluginSdkMock(host)
})

interface Room {
  chat: typeof groupChat
  gateway: ScriptedGateway
  history: typeof import('./group-history')
}

async function loadRoom(options: GatewayOptions = {}): Promise<Room> {
  vi.resetModules()
  const gateway = createGroupGateway(options)

  for (const key of Object.keys(host)) {
    delete host[key]
  }

  Object.assign(host, gateway.host)

  const [chat, history, shared] = await Promise.all([
    import('./group-chat'),
    import('./group-history'),
    import('./shared')
  ])

  shared.setPluginCtx(scriptedStorage(gateway.storage))

  return { chat, gateway, history }
}

const deltaPrompt = (roomName: string, lines: string[]) =>
  `[Group chat: "${roomName}"] You are @coder, one participant.\n\nNew messages in the room since your last turn (oldest first):\n${lines.join(
    '\n'
  )}\n\nRules for this room:\n- reply short`

beforeEach(() => {
  runTimersInline()
})

// ── parseGroupHistoryTranscript (pure) ──────────────────────────────────────
describe('parseGroupHistoryTranscript', () => {
  it('extracts user + member delta lines and the member reply as room entries', async () => {
    const { history } = await loadRoom()

    const entries = history.parseGroupHistoryTranscript(
      'coder',
      'legacy',
      [
        {
          role: 'user',
          text: deltaPrompt('supercompress fix', [
            '  You (user): check why supercompress did not fire',
            '  Reviewer: looks like the trigger is off'
          ])
        },
        { role: 'assistant', text: 'Confirmed — the G pass is disabled.', timestamp: 1790000005 }
      ]
    )

    const lines = entries.map(entry => [entry.from.kind, entry.from.name, entry.text])

    expect(lines).toContainEqual(['user', 'You', 'check why supercompress did not fire'])
    expect(lines).toContainEqual(['member', 'Reviewer', 'looks like the trigger is off'])
    expect(lines).toContainEqual(['member', 'coder', 'Confirmed — the G pass is disabled.'])
    // Every entry is tagged with the thread it came from.
    for (const entry of entries) {
      expect(entry.thread).toBe('legacy')
    }
  })

  it('treats a bare user prompt (no delta header) as unattributed and keeps only the reply', async () => {
    const { history } = await loadRoom()

    const entries = history.parseGroupHistoryTranscript('coder', 'legacy', [
      { role: 'user', text: 'please fix the lint' },
      { role: 'assistant', text: 'Done.', timestamp: 5 }
    ])

    expect(entries.map(entry => entry.text)).toEqual(['Done.'])
  })

  it('drops a (pass) reply — an empty turn adds nothing', async () => {
    const { history } = await loadRoom()

    const entries = history.parseGroupHistoryTranscript('coder', 'legacy', [
      { role: 'assistant', text: '(pass)', timestamp: 9 }
    ])

    expect(entries).toEqual([])
  })

  it('stamps wire timestamps (seconds) as milliseconds', async () => {
    const { history } = await loadRoom()

    const entries = history.parseGroupHistoryTranscript('coder', 'legacy', [
      { role: 'assistant', text: 'hi', timestamp: 1790000005 }
    ])

    expect(entries[0].at).toBe(1790000005000)
  })

  it('folds the continuation lines into the current speaker', async () => {
    const { history } = await loadRoom()

    // Real per-group transcripts carry a speaker's multi-line text at COLUMN 0
    // (markdown headings, code fences, blank lines) — `formatGroupChatLine`
    // indents only the `Speaker: text` OPENING, not its continuations. The
    // parser appends every non-entry line to the current speaker verbatim.
    const entries = history.parseGroupHistoryTranscript('devops', 'legacy', [
      {
        role: 'user',
        text: deltaPrompt('room', [
          '  Devops: line one',
          'line two (continuation)',
          '  You (user): next user msg'
        ])
      }
    ])

    expect(entries.find(entry => entry.from.name === 'Devops')?.text).toBe('line one\nline two (continuation)')
    expect(entries.find(entry => entry.from.kind === 'user')?.text).toBe('next user msg')
  })

  it('reads content parts (string + {text}) when `text` is absent', async () => {
    const { history } = await loadRoom()

    const entries = history.parseGroupHistoryTranscript('coder', 'legacy', [
      { role: 'assistant', content: ['Confirmed', { text: ' fully.' }], timestamp: 7 }
    ])

    expect(entries[0].text).toBe('Confirmed fully.')
  })
})

// ── mergeGroupHistoryAdditions (pure) ───────────────────────────────────────
describe('mergeGroupHistoryAdditions', () => {
  it('replaces an empty log with the backfilled entries, oldest first', async () => {
    const { history } = await loadRoom()
    const additions: GroupMessage[] = [
      { at: 2000, from: { kind: 'member', name: 'Reviewer' }, text: 'r', thread: 'legacy' },
      { at: 1000, from: { kind: 'user', name: 'You' }, text: 'u', thread: 'legacy' }
    ]

    const merged = history.mergeGroupHistoryAdditions(
      { log: [], watermarks: {} } as unknown as GroupChat,
      additions
    )

    expect(merged.log.map(entry => entry.text)).toEqual(['u', 'r'])
  })

  it('dedups against existing log entries by (thread, speaker, text)', async () => {
    const { history } = await loadRoom()
    const existing: GroupMessage[] = [
      { at: 1000, from: { kind: 'user', name: 'You' }, id: 'stable-1', text: 'u', thread: 'legacy' }
    ]

    const merged = history.mergeGroupHistoryAdditions(
      { log: existing, watermarks: {} } as unknown as GroupChat,
      [{ at: 1001, from: { kind: 'user', name: 'You' }, text: 'u', thread: 'legacy' }]
    )

    // The existing stable-id entry wins; the backfilled duplicate is dropped.
    expect(merged.log).toHaveLength(1)
    expect(merged.log[0].id).toBe('stable-1')
  })

  it('points every backfilled member watermark past the history (no re-feeding)', async () => {
    const { history } = await loadRoom()
    const additions: GroupMessage[] = [
      { at: 1000, from: { kind: 'user', name: 'You' }, text: 'u', thread: 'legacy' },
      { at: 2000, from: { kind: 'member', name: 'coder' }, text: 'r', thread: 'legacy' }
    ]

    const merged = history.mergeGroupHistoryAdditions(
      { log: [], watermarks: {} } as unknown as GroupChat,
      additions
    )

    // The engine's per-thread member watermark key is `${thread}::${memberKey}`
    // (group-round-members), consumed through the end of the merged log.
    expect(merged.watermarks['legacy::coder']).toBe(2)
  })
})

// ── backfillGroupRoomHistory (integrated, driven through the scripted gw) ───
describe('backfillGroupRoomHistory', () => {
  const member = (name: string) => ({ name, handle: name } as never)

  it('reads each member’s per-group session and fills the empty room log', async () => {
    const options: GatewayOptions = {
      seedSessions: [
        {
          profile: 'coder',
          title: 'Group: room-1 · legacy',
          startedAt: 1790000000,
          messages: [
            {
              role: 'user',
              timestamp: 1790000001,
              content: deltaPrompt('supercompress fix', ['  You (user): check why supercompress did not fire'])
            },
            { role: 'assistant', timestamp: 1790000005, content: 'Confirmed — the G pass is disabled.' }
          ]
        }
      ]
    }
    const { chat, gateway, history } = await loadRoom(options)

    chat.$groupChats.set({
      'supercompress fix': {
        log: [],
        members: [member('coder')],
        roomId: 'room-1',
        sessions: {},
        watermarks: {}
      } as unknown as GroupChat
    })

    const added = await history.backfillGroupRoomHistory('supercompress fix')

    expect(added).toBeGreaterThan(0)
    const log = chat.$groupChats.get()['supercompress fix'].log

    expect(log.map(entry => entry.from.name)).toEqual(['You', 'coder'])
    expect(log.find(entry => entry.from.kind === 'user')?.text).toBe('check why supercompress did not fire')
    expect(log.find(entry => entry.from.name === 'coder')?.text).toBe('Confirmed — the G pass is disabled.')

    // The room was persisted (localStorage is no longer NULL after a backfill).
    expect((gateway.storage.get('group-chats') || {})['supercompress fix'].log).toHaveLength(2)

    // It asked the server for the hidden per-group listing (per-member profile)
    // + the transcripts. The title filter rides the client (the contract has no
    // prefix field), so `session.list` is called hidden with that profile.
    expect(
      gateway.rpcFor('session.list').some(
        call => call.params.include_hidden === true && call.params.profile === 'coder'
      )
    ).toBe(true)
    expect(gateway.rpcFor('session.resume').length).toBeGreaterThan(0)
  })

  it('is idempotent — a second backfill adds nothing and does not duplicate', async () => {
    const options: GatewayOptions = {
      seedSessions: [
        {
          profile: 'coder',
          title: 'Group: room-1 · legacy',
          startedAt: 1790000000,
          messages: [
            { role: 'user', timestamp: 1790000001, content: deltaPrompt('room', ['  You (user): hi']) },
            { role: 'assistant', timestamp: 1790000005, content: 'on it' }
          ]
        }
      ]
    }
    const { chat, history } = await loadRoom(options)

    chat.$groupChats.set({
      room: { log: [], members: [member('coder')], roomId: 'room-1', sessions: {}, watermarks: {} } as unknown as GroupChat
    })

    const first = await history.backfillGroupRoomHistory('room')
    const second = await history.backfillGroupRoomHistory('room')

    expect(first).toBeGreaterThan(0)
    expect(second).toBe(0)
    expect(chat.$groupChats.get().room.log).toHaveLength(2)
  })

  it('leaves a room untouched when a member has no per-group session yet', async () => {
    const { chat, history } = await loadRoom({
      seedSessions: [{ profile: 'coder', title: 'Bot Chat', startedAt: 1790000000, messages: [] }]
    })

    chat.$groupChats.set({
      room: { log: [], members: [member('coder')], roomId: 'room-9', sessions: {}, watermarks: {} } as unknown as GroupChat
    })

    const added = await history.backfillGroupRoomHistory('room')

    expect(added).toBe(0)
    expect(chat.$groupChats.get().room.log).toHaveLength(0)
  })

  it('skips a member whose session is currently running (do not read a live turn)', async () => {
    const options: GatewayOptions = {
      seedSessions: [
        {
          profile: 'coder',
          title: 'Group: room-1 · legacy',
          startedAt: 1790000000,
          messages: [{ role: 'assistant', timestamp: 1790000005, content: 'live' }]
        }
      ],
      // Report the session as running on its first N resumes so the backfill
      // must skip it instead of reading a live turn.
      runningResumes: { coder: 5 }
    }
    const { chat, history } = await loadRoom(options)

    chat.$groupChats.set({
      'room-1': { log: [], members: [member('coder')], roomId: 'room-1', sessions: {}, watermarks: {} } as unknown as GroupChat
    })

    const added = await history.backfillGroupRoomHistory('room-1')

    expect(added).toBe(0)
  })

  it('returns 0 and writes nothing for a room with no members', async () => {
    const { chat, history } = await loadRoom()

    chat.$groupChats.set({ room: { log: [], members: [], watermarks: {} } as unknown as GroupChat })

    expect(await history.backfillGroupRoomHistory('room')).toBe(0)
  })
})
