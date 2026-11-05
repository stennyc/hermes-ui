import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SidebarSessionsResponse } from './sessions'
import type { ProfilesResponse } from '@/types/hermes'

vi.mock('@/lib/gateway-rpc', () => ({ isMissingRestEndpoint: () => false, isUnroutedRestPath: () => false }))
vi.mock('@/store/transcript-tail', () => ({ pageHonorsLatestOrder: () => true, recordTranscriptTail: vi.fn() }))
vi.mock('./client', () => ({
  ambientOwnerConnectionId: vi.fn(() => 'prometheus'),
  capabilityScoped: vi.fn(),
  connectionScoped: vi.fn(() => ({})),
  getApiRequestConnection: vi.fn(() => 'prometheus'),
  getApiRequestProfile: vi.fn(() => null),
  hermesApi: vi.fn(),
  profileScoped: vi.fn(() => ({})),
  sessionReadOwnerPin: vi.fn(() => ({}))
}))
vi.mock('./profiles', () => ({ getProfiles: vi.fn() }))

const client = await import('./client')
const profiles = await import('./profiles')
const connectionRegistry = await import('@/store/connection-registry-state')

const {
  deleteSession,
  fetchStoredTranscriptAcrossBackends,
  getSession,
  getLatestSessionMessages,
  renameSession,
  searchSessions,
  setSessionArchived,
  setSessionPinnedRemote,
  setSessionUnreadRemote,
  listSidebarSessions
} = await import('./sessions')

// The cross-backend sweep imports the connection registry lazily inside
// fetchStoredTranscriptAcrossBackends; steer it at the module boundary so the
// test can control which remote backends exist without a real registry.
vi.mock('@/store/connection-registry-state', () => ({
  $connectionsRegistry: { get: vi.fn() },
  hasRegistryTopology: vi.fn(() => false),
  registryConnectionKind: vi.fn()
}))

const hermesApi = vi.mocked(client.hermesApi)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(client.getApiRequestConnection).mockReturnValue('prometheus')
  vi.mocked(client.getApiRequestProfile).mockReturnValue(null)
  // Session writes scope through the same helper as reads: a named owner is
  // its own scope, an unnamed one is the ambient (empty) scope. Mirrors the
  // real capabilityScoped for object scopes (profile + connectionId pin) so
  // by-id probes that re-derive a scope by profile keep their profile tag.
  vi.mocked(client.capabilityScoped).mockImplementation(scope => {
    if (scope && typeof scope === 'object') {
      return {
        ...(scope.profile?.trim() ? { profile: scope.profile.trim() } : {}),
        ...(scope.connectionId?.trim() ? { connectionId: scope.connectionId.trim() } : {}),
        priority: 'foreground'
      }
    }

    return typeof scope === 'string' && scope.trim() ? { profile: scope.trim() } : {}
  })
})

describe('deleteSession profile scoping', () => {
  it('scopes the DELETE to the owning profile in the URL (object owner)', async () => {
    // Regression: the sidebar "All Profiles" delete sent the profile only via
    // request.profile, not in the URL. On a remote gateway with no remoteProfile
    // alias the main-process path rewrite left the URL unscoped, so the backend
    // opened its own default state.db, missed the row, and returned
    // {ok:true, already_absent:true} — the row vanished optimistically but was
    // never deleted and came back on refresh. The URL must carry ?profile=.
    hermesApi.mockResolvedValue({ ok: true, exists: true, runtime_revision: 5, runtime_generation: 2 } as never)
    // Mirrors the real capabilityScoped for an object owner (remote-stamped row).
    vi.mocked(client.capabilityScoped).mockReturnValue({ profile: 'tommy', connectionId: 'hermes-pi' })

    await deleteSession('sess-1', { connectionId: 'hermes-pi', profile: 'tommy' })

    expect(hermesApi.mock.calls.filter(([request]) => request.method)[0][0]).toMatchObject({
      method: 'DELETE',
      path: expect.stringContaining('/api/sessions/sess-1?profile=tommy'),
      connectionId: 'hermes-pi',
      profile: 'tommy'
    })
  })

  it('scopes the DELETE to the owning profile in the URL (bare string owner)', async () => {
    hermesApi.mockResolvedValue({ ok: true, exists: true, runtime_revision: 5, runtime_generation: 2 } as never)
    // Bare-string owner: capabilityScoped resolves it to a profile scope.
    vi.mocked(client.capabilityScoped).mockReturnValue({ profile: 'tommy' })

    await deleteSession('sess-2', 'tommy')

    expect(hermesApi.mock.calls.filter(([request]) => request.method)[0][0]).toMatchObject({
      method: 'DELETE',
      path: expect.stringContaining('/api/sessions/sess-2?profile=tommy')
    })
  })

  it('omits the profile query when no owner is known', async () => {
    hermesApi.mockResolvedValue({ ok: true, exists: true, runtime_revision: 5, runtime_generation: 2 } as never)

    await deleteSession('sess-3')

    expect(hermesApi.mock.calls.filter(([request]) => request.method)[0][0]).toMatchObject({
      method: 'DELETE',
      path: expect.stringContaining('/api/sessions/sess-3')
    })
    expect((hermesApi.mock.calls.filter(([request]) => request.method)[0][0] as { path: string }).path).not.toContain('profile=')
  })

  it('keeps an explicit local pin routed to the local pool', async () => {
    hermesApi.mockResolvedValue({ ok: true, exists: true, runtime_revision: 5, runtime_generation: 2 } as never)
    // capabilityScoped drops a 'local' connection id by design; sessionScoped
    // must re-add it so the request stays pinned to this device.
    vi.mocked(client.capabilityScoped).mockReturnValue({ profile: 'tommy' })

    await deleteSession('sess-4', { connectionId: 'local', profile: 'tommy' })

    expect(hermesApi.mock.calls.filter(([request]) => request.method)[0][0]).toMatchObject({
      method: 'DELETE',
      path: expect.stringContaining('/api/sessions/sess-4?profile=tommy'),
      connectionId: 'local',
      profile: 'tommy'
    })
  })
})

describe('getSession dial priority', () => {
  it('does not dial an explicitly scoped session read foreground', async () => {
    // The scope helper tags every explicit scope foreground (#111651); the
    // cross-profile probe loop in resolveStoredSession would otherwise cold-start
    // every other profile on the reserved slot during a boot-time resume.
    hermesApi.mockResolvedValue({ id: 'sess-5' } as never)
    vi.mocked(client.capabilityScoped).mockReturnValue({ priority: 'foreground', profile: 'tommy' })

    await getSession('sess-5', { connectionId: 'local', profile: 'tommy' })

    expect(hermesApi.mock.calls[0][0]).toMatchObject({ profile: 'tommy', connectionId: 'local' })
    expect(hermesApi.mock.calls[0][0]).not.toHaveProperty('priority')
  })
})

describe('getSession profile scoping (P6: caller pins the owning profile, no cross-profile sweep)', () => {
  const notFound = () => new Error('404: Session not found')

  beforeEach(() => {
    vi.mocked(client.profileScoped).mockImplementation(() => ({}))
    vi.mocked(client.sessionReadOwnerPin).mockImplementation(() => ({}))
    vi.mocked(client.getApiRequestProfile).mockReturnValue(null)
  })

  it('resolves an unpinned ambient read when the row is on the ambient profile', async () => {
    hermesApi.mockResolvedValue({ id: 'local-session' } as never)

    const resolved = await getSession('local-session')

    expect(hermesApi).toHaveBeenCalledTimes(1)
    expect(resolved).toMatchObject({ id: 'local-session' })
    expect(profiles.getProfiles).not.toHaveBeenCalled()
  })

  it('propagates an unpinned ambient 404 untouched — NO cross-profile sweep (P6)', async () => {
    // P6 (owner ruling 2026-11-05): an ambient read that 404s is NOT swept
    // across the listed profiles (default and any other profile are
    // independent — reading one through the other is how the 404s started).
    // The caller pins the owning profile instead (restore chain / B).
    vi.mocked(profiles.getProfiles).mockResolvedValue({ profiles: [{ name: 'default' }, { name: 'coder' }] } as unknown as ProfilesResponse)
    hermesApi.mockRejectedValue(notFound())

    await expect(getSession('owner-session')).rejects.toThrow('404: Session not found')

    expect(hermesApi).toHaveBeenCalledTimes(1)
    expect(profiles.getProfiles).not.toHaveBeenCalled()
  })

  it('sends a pinned read to the named profile (owner known up front)', async () => {
    hermesApi.mockResolvedValue({ id: 'owner-session', profile: 'coder' } as never)

    const resolved = await getSession('owner-session', 'coder')

    expect(hermesApi).toHaveBeenCalledTimes(1)
    expect(hermesApi.mock.calls[0][0].path).toContain('?profile=coder')
    expect(resolved).toMatchObject({ id: 'owner-session', profile: 'coder' })
  })

  it('an explicitly pinned read that 404s propagates (fail-closed)', async () => {
    hermesApi.mockRejectedValue(notFound())

    await expect(getSession('owner-session', 'tommy')).rejects.toThrow('404: Session not found')

    // Exactly one request: the pinned one. No inventory read, no sweep.
    expect(hermesApi).toHaveBeenCalledTimes(1)
    expect(profiles.getProfiles).not.toHaveBeenCalled()
  })

  it('an owner-pinned read that 404s propagates (fail-closed)', async () => {
    vi.mocked(client.sessionReadOwnerPin).mockImplementation((id: string) =>
      id === 'remote-owned' ? { connectionId: 'dale', profile: 'default' } : {}
    )
    hermesApi.mockRejectedValue(notFound())

    await expect(getSession('remote-owned')).rejects.toThrow('404: Session not found')

    expect(hermesApi).toHaveBeenCalledTimes(1)
    expect(profiles.getProfiles).not.toHaveBeenCalled()
  })

  it('does not sweep a non-404 failure (network / 5xx propagate untouched)', async () => {
    hermesApi.mockRejectedValue(new Error('503: Service Unavailable'))

    await expect(getSession('owner-session')).rejects.toThrow('503: Service Unavailable')

    expect(hermesApi).toHaveBeenCalledTimes(1)
    expect(profiles.getProfiles).not.toHaveBeenCalled()
  })
})

describe('setSessionArchived profile scoping', () => {
  it('carries the owning profile in the PATCH body', async () => {
    // Same class as the unscoped DELETE: the PATCH handler reads its target DB
    // from body.profile, so archiving a foreign-profile session must send it in
    // the body, not only as request.profile (Electron routing), or on a remote
    // gateway the archive lands on the wrong state.db and silently no-ops.
    hermesApi.mockResolvedValue({ ok: true, exists: true, runtime_revision: 5, runtime_generation: 2 } as never)

    await setSessionArchived('sess-a', true, 'tommy')

    expect(hermesApi.mock.calls.filter(([request]) => request.method)[0][0]).toMatchObject({
      method: 'PATCH',
      path: '/api/sessions/sess-a',
      profile: 'tommy',
      body: { archived: true, profile: 'tommy' }
    })
  })

  it('falls back to the ACTIVE profile in the body when no owner is given', async () => {
    // Multiplex-only: the PATCH handler resolves its state.db from
    // `body.profile` and there is no per-profile backend whose HERMES_HOME
    // could stand in. An unnamed owner therefore has to mean "the profile I am
    // looking at" — otherwise the archive lands on the shared backend's own
    // state.db and silently no-ops.
    hermesApi.mockResolvedValue({ ok: true, exists: true, runtime_revision: 5, runtime_generation: 2 } as never)
    vi.mocked(client.getApiRequestProfile).mockReturnValue('beta')

    await setSessionArchived('sess-b', false)

    expect(hermesApi.mock.calls.filter(([request]) => request.method)[0][0]).toMatchObject({
      method: 'PATCH',
      profile: 'beta',
      body: { archived: false, profile: 'beta' }
    })
  })

  it('omits the profile from the body only when there is no active profile at all', async () => {
    hermesApi.mockResolvedValue({ ok: true, exists: true, runtime_revision: 5, runtime_generation: 2 } as never)

    await setSessionArchived('sess-b2', false)

    const req = hermesApi.mock.calls.filter(([request]) => request.method)[0][0] as { body: Record<string, unknown> }
    expect(req).toMatchObject({ method: 'PATCH', body: { archived: false } })
    expect(req.body).not.toHaveProperty('profile')
  })
})

describe('setSessionPinnedRemote / setSessionUnreadRemote profile scoping', () => {
  it('carries the owning profile in the pin PATCH body', async () => {
    hermesApi.mockResolvedValue({ ok: true, exists: true, runtime_revision: 5, runtime_generation: 2 } as never)

    await setSessionPinnedRemote('sess-p', true, 'tommy')

    expect(hermesApi.mock.calls.filter(([request]) => request.method)[0][0]).toMatchObject({
      method: 'PATCH',
      path: '/api/sessions/sess-p',
      profile: 'tommy',
      body: { pinned: true, profile: 'tommy' }
    })
  })

  it('carries the owning profile in the unread PATCH body', async () => {
    hermesApi.mockResolvedValue({ ok: true, exists: true, runtime_revision: 5, runtime_generation: 2 } as never)

    await setSessionUnreadRemote('sess-u', true, 'tommy')

    expect(hermesApi.mock.calls.filter(([request]) => request.method)[0][0]).toMatchObject({
      method: 'PATCH',
      path: '/api/sessions/sess-u',
      profile: 'tommy',
      body: { unread: true, profile: 'tommy' }
    })
  })

  it('omits the profile from the body when none is given', async () => {
    hermesApi.mockResolvedValue({ ok: true, exists: true, runtime_revision: 5, runtime_generation: 2 } as never)

    await setSessionPinnedRemote('sess-p2', false)

    const req = hermesApi.mock.calls.filter(([request]) => request.method)[0][0] as { body: Record<string, unknown> }
    expect(req).toMatchObject({ method: 'PATCH', body: { pinned: false } })
    expect(req.body).not.toHaveProperty('profile')
  })

  it('falls back to the ACTIVE profile in the body when no owner is given', async () => {
    hermesApi.mockResolvedValue({ ok: true, exists: true, runtime_revision: 5, runtime_generation: 2 } as never)
    vi.mocked(client.getApiRequestProfile).mockReturnValue('beta')

    await setSessionPinnedRemote('sess-p2', false)

    expect(hermesApi.mock.calls.filter(([request]) => request.method)[0][0]).toMatchObject({
      method: 'PATCH',
      profile: 'beta',
      body: { pinned: false, profile: 'beta' }
    })
  })
})

describe('renameSession profile scoping', () => {
  it('carries the owning profile in the PATCH body and request', async () => {
    hermesApi.mockResolvedValue({ ok: true, title: 'Prep Butler', exists: true, runtime_revision: 5, runtime_generation: 2 } as never)

    await renameSession('sess-r', 'Prep Butler', 'personal')

    expect(hermesApi.mock.calls.filter(([request]) => request.method)[0][0]).toMatchObject({
      method: 'PATCH',
      path: '/api/sessions/sess-r',
      profile: 'personal',
      body: { title: 'Prep Butler', profile: 'personal' }
    })
  })

  it('falls back to the active request profile when the argument is omitted', async () => {
    hermesApi.mockResolvedValue({ ok: true, title: 'Prep Butler', exists: true, runtime_revision: 5, runtime_generation: 2 } as never)
    vi.mocked(client.getApiRequestProfile).mockReturnValue('personal')

    await renameSession('sess-r2', 'Prep Butler')

    expect(hermesApi.mock.calls.filter(([request]) => request.method)[0][0]).toMatchObject({
      method: 'PATCH',
      path: '/api/sessions/sess-r2',
      profile: 'personal',
      body: { title: 'Prep Butler', profile: 'personal' }
    })
    vi.mocked(client.getApiRequestProfile).mockReturnValue(null)
  })
})

describe('listSidebarSessions remote ownership', () => {
  it('stamps active remote rows so a later resume stays on their gateway', async () => {
    hermesApi.mockResolvedValue({
      cron: { sessions: [] },
      messaging: { sessions: [] },
      recents: {
        sessions: [{ id: 'remote-session', profile: 'default', source: 'desktop', title: 'Remote chat' }]
      }
    } as never)

    const result = await listSidebarSessions({
      recentsProfile: 'default',
      recentsLimit: 40,
      recentsExclude: [],
      cronLimit: 20,
      messagingLimit: 40,
      messagingExclude: []
    })

    expect(result.recents.sessions[0]).toMatchObject({ connection_id: 'prometheus', id: 'remote-session' })
  })
})

describe('listSidebarSessions storage health', () => {
  it('passes the backend corrupt-store map through so the sidebar can say why it is empty', async () => {
    const response = {
      cron: { sessions: [] },
      errors: [{ error: 'database disk image is malformed', profile: 'default' }],
      messaging: { sessions: [] },
      recents: { sessions: [] },
      storage: { default: 'corrupt' }
    } satisfies SidebarSessionsResponse

    // SAFETY: vi cannot infer a concrete return from the generic hermesApi signature;
    // `satisfies` above checks the exact endpoint contract before it crosses the mock boundary.
    hermesApi.mockResolvedValue(response as never)

    const result = await listSidebarSessions({
      recentsProfile: 'all',
      recentsLimit: 40,
      recentsExclude: [],
      cronLimit: 20,
      messagingLimit: 40,
      messagingExclude: []
    })

    expect(result.storage).toEqual({ default: 'corrupt' })
  })
})

describe('session reads pin the owner connection (#125372)', () => {
  beforeEach(() => {
    // Ambient default: no explicit pin, no owner stamp.
    vi.mocked(client.capabilityScoped).mockReturnValue({})
    vi.mocked(client.sessionReadOwnerPin).mockReturnValue({})
  })

  it('pins getSession to the session owner when the ambient scope differs', async () => {
    // Regression: a session-scoped read dispatched on the WINDOW's ambient
    // connection scope. With a registered remote exposing a same-named
    // profile, the wrong backend answered 404 "Session not found" in both
    // directions. The read must carry the owner's connectionId (+ backend
    // profile when the caller named none) so Electron routes to the owner.
    vi.mocked(client.sessionReadOwnerPin).mockImplementation((id: string) =>
      id === 'remote-owned' ? { connectionId: 'dale-home-lan-9119', profile: 'default' } : {}
    )

    await getSession('remote-owned')

    expect(hermesApi.mock.calls[0][0]).toMatchObject({
      path: '/api/sessions/remote-owned?profile=default',
      connectionId: 'dale-home-lan-9119'
    })
  })

  it('keeps an explicit (connection, profile) pin authoritative in getLatestSessionMessages', async () => {
    // Explicit caller pin: the real capabilityScoped resolves it; the owner
    // lookup must not override it.
    vi.mocked(client.capabilityScoped).mockReturnValue({ profile: 'tommy', connectionId: 'other-conn' })

    await getLatestSessionMessages('sess-y', { connectionId: 'other-conn', profile: 'tommy' })

    expect(hermesApi.mock.calls[0][0]).toMatchObject({
      connectionId: 'other-conn',
      profile: 'tommy'
    })
  })
})

describe('searchSessions profile scope', () => {
  it('searches the given profile instead of the primary backend', async () => {
    // Unscoped, the primary searched its launch profile while the sidebar showed another.
    hermesApi.mockResolvedValue({ results: [] } as never)
    vi.mocked(client.profileScoped).mockImplementation(profile => (profile ? { priority: 'foreground', profile } : {}))

    await searchSessions('zebra', 'research')

    expect(hermesApi.mock.calls[0][0]).toMatchObject({
      path: '/api/sessions/search?q=zebra&profile=research',
      profile: 'research'
    })
  })
})

describe('fetchStoredTranscriptAcrossBackends profile sweep (9200 unlisted-profile 404)', () => {
  const remoteBackend = { connections: [{ id: 'remote-b' }] }
  const transcript = (profileName: string) => ({ id: 'owner-session', messages: [], profile: profileName })

  it('sweeps every profile on a remote backend when the row is on a non-default profile', async () => {
    // Ambient read misses; the row lives on the remote backend's `coder` DB.
    vi.mocked(connectionRegistry.$connectionsRegistry.get).mockReturnValue({ connections: remoteBackend.connections } as never)
    vi.mocked(profiles.getProfiles).mockImplementation(async (scope: unknown) => {
      const inventory = scope && typeof scope === 'object' && 'connectionId' in (scope as object) ? { profiles: [{ name: 'default' }, { name: 'coder' }] } : { profiles: [{ name: 'default' }] }

      return inventory as unknown as ProfilesResponse
    })
    hermesApi.mockImplementation(async (request: { path: string; profile?: string }) => {
      if (request.profile === 'coder' && request.path.includes('/messages')) {
        return transcript('coder') as never
      }

      throw new Error('404: Session not found')
    })

    const resolved = await fetchStoredTranscriptAcrossBackends('owner-session')

    expect(resolved).toMatchObject({ id: 'owner-session', profile: 'coder' })
  })

  it('falls back to the default profile list when the inventory read fails', async () => {
  vi.mocked(connectionRegistry.$connectionsRegistry.get).mockReturnValue({ connections: remoteBackend.connections } as never)
  vi.mocked(profiles.getProfiles).mockRejectedValue(new Error('503: Service Unavailable'))
  // The inventory read fails → profileCandidatesFor falls back to
  // ['default']; the default-profile probe hits.
  hermesApi.mockImplementation(async (request: { path: string }) => {
    if (request.path.includes('profile=default')) {
      return transcript('default') as never
    }

    throw new Error('404: Session not found')
  })

  const resolved = await fetchStoredTranscriptAcrossBackends('owner-session')

  expect(resolved).toMatchObject({ id: 'owner-session' })
  })

  it('returns null when every profile on every backend also misses', async () => {
    vi.mocked(connectionRegistry.$connectionsRegistry.get).mockReturnValue({ connections: remoteBackend.connections } as never)
    vi.mocked(profiles.getProfiles).mockResolvedValue({ profiles: [{ name: 'default' }, { name: 'coder' }] } as unknown as ProfilesResponse)
    hermesApi.mockRejectedValue(new Error('404: Session not found'))

    const resolved = await fetchStoredTranscriptAcrossBackends('missing')

    expect(resolved).toBeNull()
  })
})

describe('session writes profile scoping (P6: caller pins the owning profile, no cross-profile sweep)', () => {
  const notFound = () => new Error('404: Session not found')
  const snapshot = { exists: true, runtime_revision: 5, runtime_generation: 2 }

  // Snapshot reads resolve; the write call itself answers per test.
  const routeWrite = (writeResult: () => unknown | Promise<unknown>) => {
    hermesApi.mockImplementation(async (request: { path: string; profile?: string }) => {
      if (request.path.includes('/mutation-snapshot')) {
        return snapshot as never
      }

      return writeResult() as Promise<unknown>
    })
  }

  it('an unpinned ambient DELETE that 404s propagates — NO cross-profile sweep (P6)', async () => {
    // P6 (owner ruling 2026-11-05): a write with no known owner is not swept
    // across the listed profiles — default and any other profile are
    // independent. The caller passes the owning profile (the row carries it)
    // or the 404 surfaces as a plain "row not found".
    routeWrite(() => Promise.reject(notFound()))
    vi.mocked(profiles.getProfiles).mockResolvedValue({ profiles: [{ name: 'default' }, { name: 'coder' }] } as unknown as ProfilesResponse)

    await expect(deleteSession('owner-session')).rejects.toThrow('404: Session not found')

    const deletes = hermesApi.mock.calls.filter(([request]) => request.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0][0]).not.toHaveProperty('profile')
    expect(profiles.getProfiles).not.toHaveBeenCalled()
  })

  it('an unpinned ambient PATCH that 404s propagates — NO cross-profile sweep (P6)', async () => {
    routeWrite(() => Promise.reject(notFound()))
    vi.mocked(profiles.getProfiles).mockResolvedValue({ profiles: [{ name: 'default' }, { name: 'coder' }] } as unknown as ProfilesResponse)

    await expect(setSessionArchived('owner-session', true)).rejects.toThrow('404: Session not found')

    const patches = hermesApi.mock.calls.filter(([request]) => request.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0][0]).not.toHaveProperty('profile')
    expect(profiles.getProfiles).not.toHaveBeenCalled()
  })

  it('a pinned caller-named profile write that 404s propagates fail-closed', async () => {
    vi.mocked(client.getApiRequestProfile).mockReturnValue(null)
    hermesApi.mockRejectedValue(notFound())

    await expect(deleteSession('owner-session', 'tommy')).rejects.toThrow('404: Session not found')

    // Exactly one request: the pinned one. No inventory read, no sweep.
    expect(hermesApi).toHaveBeenCalledTimes(1)
    expect(profiles.getProfiles).not.toHaveBeenCalled()
  })

  it('an ambient request profile write that 404s propagates fail-closed', async () => {
    vi.mocked(client.getApiRequestProfile).mockReturnValue('beta')
    hermesApi.mockRejectedValue(notFound())

    await expect(deleteSession('owner-session')).rejects.toThrow('404: Session not found')

    expect(hermesApi).toHaveBeenCalledTimes(1)
    expect(profiles.getProfiles).not.toHaveBeenCalled()
  })

  it('a non-404 write failure propagates untouched', async () => {
    vi.mocked(client.getApiRequestProfile).mockReturnValue(null)
    hermesApi.mockRejectedValue(new Error('503: Service Unavailable'))

    await expect(renameSession('owner-session', 'New title')).rejects.toThrow('503: Service Unavailable')

    expect(hermesApi).toHaveBeenCalledTimes(1)
    expect(profiles.getProfiles).not.toHaveBeenCalled()
  })
})
