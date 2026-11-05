import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesModule from '@/hermes'
import { getSession } from '@/hermes'
import type { ProfileScope } from '@/hermes'
import { $activeGatewayProfile, $profiles } from '@/store/profile'
import { $projectTree } from '@/store/projects'
import { $cronSessions, $messagingSessions, $sessions, $unlistedSessionOwnerRows } from '@/store/session'
import { $removedSessionIds, tombstoneSessions, untombstoneSessions } from '@/store/session-removal'
import type { SessionInfo } from '@/types/hermes'

import { cachedSessionRow, probeStoredSession, resolveStoredSession } from './utils'

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<typeof HermesModule>()),
  getSession: vi.fn()
}))

const mockGetSession = vi.mocked(getSession)

const session = (over: Partial<SessionInfo>): SessionInfo => over as SessionInfo

const profiles = (...names: string[]) => names.map(name => ({ name }) as never)

const ownerRoute = { connectionId: 'remote-1', profile: 'meta', targetProfile: 'meta' }

describe('resolveStoredSession profile ownership (P8: no cross-profile sweep)', () => {
  beforeEach(() => {
    $cronSessions.set([])
    $messagingSessions.set([])
    $sessions.set([])
    $projectTree.set([])
    $removedSessionIds.set(new Set())
    $profiles.set(profiles('default', 'meta'))
    $activeGatewayProfile.set('meta')
    $unlistedSessionOwnerRows.set([])
    mockGetSession.mockReset()
  })

  afterEach(() => {
    $cronSessions.set([])
    $messagingSessions.set([])
    $sessions.set([])
    $projectTree.set([])
    $removedSessionIds.set(new Set())
    $profiles.set([])
    $activeGatewayProfile.set('default')
    $unlistedSessionOwnerRows.set([])
  })

  it('returns a cached row that carries an owning profile', async () => {
    $sessions.set([session({ id: 's1', profile: 'default' })])

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('default')
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it.each([
    ['cron', $cronSessions],
    ['messaging', $messagingSessions]
  ])('resolves a %s sidebar row without duplicating it into regular sessions', async (_source, store) => {
    store.set([session({ id: 's1', profile: 'default' })])

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('default')
    expect(mockGetSession).not.toHaveBeenCalled()
    expect($sessions.get()).toEqual([])
  })

  it('returns a profile-less cached row as-is without any by-id read', async () => {
    // P8: the cached row is what the caller actually has; there is no longer an
    // active-profile by-id rung or cross-profile probe to "upgrade" it.
    $sessions.set([session({ id: 's1' })])

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.id).toBe('s1')
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('returns a cached row even when multiple profiles exist and the row has no profile', async () => {
    $profiles.set(profiles('default', 'meta'))
    $sessions.set([session({ id: 's1' })])

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.id).toBe('s1')
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('returns undefined (inconclusive) when there is no cache row and no owner', async () => {
    const resolved = await resolveStoredSession('s1')

    expect(resolved).toBeUndefined()
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('never fans out to every profile when the owner is unknown', async () => {
    $activeGatewayProfile.set('default')
    $profiles.set(profiles('default', 'a', 'b', 'c'))
    mockGetSession.mockRejectedValue(new Error('404: Session not found'))

    const result = await resolveStoredSession('s1')

    expect(result).toBeUndefined()
    // No cross-profile sweep: at most the owner-routed call (none here) — zero calls.
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('stamps the active profile on a bare by-id hit from an older backend when an owner is pinned', async () => {
    mockGetSession.mockResolvedValueOnce(session({ id: 's1' }))

    const resolved = await resolveStoredSession('s1', ownerRoute as never)

    expect(resolved?.profile).toBe('meta')
    expect(mockGetSession).toHaveBeenCalledWith('s1', { connectionId: 'remote-1', profile: 'meta' })
  })

  it('parks a hidden owner-routed by-id hit off-list — canonical Bot Chats never get a sidebar row (#113273)', async () => {
    mockGetSession.mockResolvedValueOnce(session({ hidden: true, id: 's1' }))

    const resolved = await resolveStoredSession('s1', ownerRoute as never)

    expect(resolved?.hidden).toBe(true)
    expect($sessions.get()).toEqual([])
    expect($unlistedSessionOwnerRows.get().find(s => s.id === 's1')?.hidden).toBe(true)
  })

  it('returns an owner-routed internal delegate child without promoting it into regular sessions', async () => {
    mockGetSession.mockResolvedValueOnce(session({ id: 'child', is_internal_child: true }))

    const resolved = await resolveStoredSession('child', ownerRoute as never)

    expect(resolved).toMatchObject({ connection_id: 'remote-1', id: 'child', is_internal_child: true, profile: 'meta' })
    expect($sessions.get()).toEqual([])
  })

  it('does not recache an owner-routed by-id row while its session is tombstoned (#85163)', async () => {
    let resolveRequest!: (value: SessionInfo) => void
    mockGetSession.mockReturnValueOnce(
      new Promise<SessionInfo>(resolve => {
        resolveRequest = resolve
      })
    )

    const pending = resolveStoredSession('s1', ownerRoute as never)
    tombstoneSessions(['s1'])
    resolveRequest(session({ archived: false, id: 's1' }))

    await expect(pending).resolves.toMatchObject({ connection_id: 'remote-1', id: 's1' })
    expect($sessions.get()).toEqual([])
    untombstoneSessions(['s1'])
  })

  it('does not recache an owner-routed archived by-id row', async () => {
    mockGetSession.mockResolvedValueOnce(session({ archived: true, id: 's1' }))

    const resolved = await resolveStoredSession('s1', ownerRoute as never)

    expect(resolved?.archived).toBe(true)
    expect($sessions.get()).toEqual([])
  })

  it('does not recache a stale owner-routed by-id row when its tombstone clears before the response', async () => {
    let resolveRequest!: (value: SessionInfo) => void
    mockGetSession.mockReturnValueOnce(
      new Promise<SessionInfo>(resolve => {
        resolveRequest = resolve
      })
    )
    tombstoneSessions(['s1'])

    const pending = resolveStoredSession('s1', ownerRoute as never)
    untombstoneSessions(['s1'])
    resolveRequest(session({ archived: false, id: 's1' }))

    await expect(pending).resolves.toMatchObject({ id: 's1' })
    expect($sessions.get()).toEqual([])
  })

  it('does not recache a stale owner-routed by-id row after an in-flight tombstone ABA cycle', async () => {
    let resolveRequest!: (value: SessionInfo) => void
    mockGetSession.mockReturnValueOnce(
      new Promise<SessionInfo>(resolve => {
        resolveRequest = resolve
      })
    )

    const pending = resolveStoredSession('s1', ownerRoute as never)
    tombstoneSessions(['s1'])
    untombstoneSessions(['s1'])
    expect($removedSessionIds.get()).toEqual(new Set())
    resolveRequest(session({ archived: false, id: 's1' }))

    await expect(pending).resolves.toMatchObject({ id: 's1' })
    expect($sessions.get()).toEqual([])
  })

  it('verdicts an owner-routed 404 as gone when the cache is empty', async () => {
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))

    const probe = await probeStoredSession('s1', ownerRoute as never)

    expect(probe).toEqual({ status: 'gone' })
  })

  it('verdicts an owner-routed non-404 failure as inconclusive', async () => {
    mockGetSession.mockRejectedValueOnce(new Error('503: gateway unavailable'))

    const probe = await probeStoredSession('s1', ownerRoute as never)

    expect(probe).toEqual({ status: 'inconclusive' })
  })

  it('short-circuits to a cached owner-routed row without calling getSession', async () => {
    $sessions.set([session({ connection_id: 'remote-1', id: 's1', profile: 'meta' })])

    const probe = await probeStoredSession('s1', ownerRoute as never)

    expect(probe).toEqual({ status: 'found', session: expect.objectContaining({ id: 's1' }) })
    expect(mockGetSession).not.toHaveBeenCalled()
  })
})

describe('cachedSessionRow owner preference', () => {
  const projectNode = (sessions: SessionInfo[], preview: SessionInfo[] = []) =>
    ({
      previewSessions: preview,
      repos: [{ groups: [{ sessions }] }]
    }) as never

  beforeEach(() => {
    $cronSessions.set([])
    $messagingSessions.set([])
    $sessions.set([])
    $projectTree.set([])
    mockGetSession.mockReset()
  })

  afterEach(() => {
    $cronSessions.set([])
    $messagingSessions.set([])
    $sessions.set([])
    $projectTree.set([])
  })

  it('prefers a self-describing project-tree row over an ownerless Recents duplicate', () => {
    $sessions.set([session({ cwd: '/wrong', id: 's1' })])
    $projectTree.set([projectNode([session({ connection_id: 'pandora', cwd: '/right', id: 's1', profile: 'work' })])])

    expect(cachedSessionRow('s1')).toMatchObject({ connection_id: 'pandora', cwd: '/right', profile: 'work' })
  })

  it('finds a project-tree preview row when the session is in no other list', () => {
    $projectTree.set([projectNode([], [session({ connection_id: 'rigremote', id: 's1', profile: 'default' })])])

    expect(cachedSessionRow('s1')).toMatchObject({ connection_id: 'rigremote' })
  })

  it('keeps the plain Recents row when nothing carries an owner', () => {
    $sessions.set([session({ cwd: '/only', id: 's1' })])

    expect(cachedSessionRow('s1')).toMatchObject({ cwd: '/only' })
    expect(cachedSessionRow('missing')).toBeUndefined()
  })
})
