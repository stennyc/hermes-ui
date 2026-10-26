import { host } from '@hermes/plugin-sdk'

import type { GroupMember } from './types'

import { clientRandomUUID } from '@/lib/client-id'

export interface CanonicalGroupRoute {
  connectionId: string
  profile: string
}

export interface CanonicalGroupBinding extends CanonicalGroupRoute {
  roomId: string
}

export interface CanonicalRoomMember {
  member_id: string
  profile: string
  handle: string
  display_name?: string
  target?: Record<string, unknown>
}

export interface CanonicalRoom {
  room_id: string
  name: string
  members: CanonicalRoomMember[]
  disbanded_at?: number | null
}

export interface CanonicalPendingAction {
  kind: string
  member_id: string
  task_id: string
  execution_generation: number
  request_id?: string
}

function requireRoute(route: CanonicalGroupRoute): void {
  // An empty connectionId is legitimate: the active socket is the window's
  // primary source with no registry-scoped id, and canonicalGroupRequest
  // routes it through host.request. Only a missing profile is fatal.
  if (!route.profile?.trim()) {
    throw new Error('Canonical groups require an explicit connection and profile')
  }
}

/**
 * The active gateway socket's connection identity, when it is a registry-scoped
 * source. Null when the window's live socket is a bare local or non-registry
 * remote — in which case the canonical-group RPCs must ride `host.request`
 * (the active socket) instead of a `host.requestProfile` descriptor with a
 * fabricated connectionId (which would try to dial a registry source that
 * does not exist in this window, e.g. the local host backend of a window
 * that is itself pointed at a remote dashboard).
 */
function activeConnectionIdentity(): string | null {
  const fromState = host.state.connectionId?.get?.() ?? null
  const fromActive = typeof host.activeConnectionId === 'function' ? host.activeConnectionId() : null

  return fromState ?? fromActive ?? null
}

export function captureCanonicalGroupRoute(): CanonicalGroupRoute {
  const connectionId = activeConnectionIdentity()
  const profile = host.state.profile.get()

  if (!profile?.trim()) {throw new Error('Canonical groups require an explicit profile')}

  // A null connectionId means the active socket is the window's primary source
  // with no registry-scoped id: route through the active socket (host.request),
  // never fabricate one.
  return { connectionId: connectionId ?? '', profile }
}

export async function canonicalGroupRequest<T>(
  route: CanonicalGroupRoute,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  requireRoute(route)

  if (params.profile !== undefined && params.profile !== route.profile) {
    throw new Error('Canonical group profile does not match its authority')
  }

  // An empty connectionId means the active socket is the window's primary source
  // with no registry-scoped id (bare local, or a remote window that has no
  // registry connection). Route through the active socket (host.request)
  // rather than a host.requestProfile descriptor — a fabricated connectionId
  // would try to dial a registry source that does not exist in this window.
  if (!route.connectionId) {
    return host.request<T>(method, { ...params, profile: route.profile })
  }

  // The descriptor overload never falls back to the foreground gateway.
  return host.requestProfile<T>({
    connectionId: route.connectionId,
    profile: route.profile,
    targetProfile: route.profile,
    mode: route.connectionId === 'local' ? 'local' : 'remote'
  }, method, { ...params, profile: route.profile })
}

export async function discoverCanonicalGroups(
  route: CanonicalGroupRoute
): Promise<{ driver: boolean; rooms: CanonicalRoom[] }> {
  const capabilities = await canonicalGroupRequest<{ driver: boolean }>(route, 'groups.capabilities')
  const rooms: CanonicalRoom[] = []
  let offset = 0

  for (;;) {
    const page = await canonicalGroupRequest<{ rooms: CanonicalRoom[]; next_offset: number | null }>(
      route, 'groups.list', { limit: 100, offset }
    )

    rooms.push(...page.rooms)

    if (page.next_offset === null) {break}

    if (!Number.isSafeInteger(page.next_offset) || page.next_offset <= offset) {
      throw new Error('Invalid canonical group pagination cursor')
    }

    offset = page.next_offset
  }

  return { driver: capabilities.driver === true, rooms }
}

export async function createCanonicalGroup(
  route: CanonicalGroupRoute,
  name: string,
  members: GroupMember[]
): Promise<{ binding: CanonicalGroupBinding; room: CanonicalRoom }> {
  requireRoute(route)

  if (!name.trim() || members.length < 2 || members.length > 6) {
    throw new Error('A canonical group needs a name and two to six members')
  }

  const profiles = new Set<string>()
  const handles = new Set(['all', 'everyone'])

  const roster = members.map(member => {
    const connectionId = member.route?.connectionId ?? member.connectionId

    // An empty route.connectionId means "the active socket's authority"
    // (host.request path): a member is same-authority when it carries no
    // registry connectionId of its own. A member that DOES carry a
    // connectionId must match the route's (non-empty) id.
    const memberMismatch =
      connectionId !== undefined && connectionId !== route.connectionId &&
      (route.connectionId !== '' || connectionId !== '')
    const ownIdMismatch =
      member.connectionId !== undefined && member.connectionId !== route.connectionId &&
      (route.connectionId !== '' || member.connectionId !== '')

    if (memberMismatch || ownIdMismatch ||
      (connectionId === undefined && member.remoteSource && route.connectionId !== '')) {
      throw new Error('Group members must belong to the same authority connection')
    }

    const profile = member.route?.targetProfile ?? member.targetProfile ?? member.name
    const handle = member.handle ?? profile

    if (!profile.trim() || !handle.trim() || profiles.has(profile.toLowerCase()) || handles.has(handle.toLowerCase())) {
      throw new Error('Group members need unique profiles and non-reserved handles')
    }

    profiles.add(profile.toLowerCase())
    handles.add(handle.toLowerCase())

    return {
      member_id: profile, profile, handle,
      target: { kind: 'local', profile },
      ...(member.display_name ? { display_name: member.display_name } : {})
    }
  })

  const { room } = await canonicalGroupRequest<{ room: CanonicalRoom }>(route, 'groups.create', {
    room_id: clientRandomUUID(), name, members: roster
  })

  return { binding: { ...route, roomId: room.room_id }, room }
}

export async function actCanonicalGroup(
  binding: CanonicalGroupBinding,
  action: CanonicalPendingAction,
  choice?: 'once' | 'deny'
): Promise<Record<string, unknown>> {
  const methods: Record<string, string> = { retry: 'groups.retry', discard: 'groups.discard', approval: 'groups.approve' }
  const method = Object.hasOwn(methods, action.kind) ? methods[action.kind] : undefined

  if (!method || !binding.roomId || !action.member_id || !action.task_id ||
    !Number.isSafeInteger(action.execution_generation) || action.execution_generation < 1) {
    throw new Error('Invalid canonical group pending action')
  }

  const params: Record<string, unknown> = {
    room_id: binding.roomId,
    member_id: action.member_id,
    task_id: action.task_id,
    execution_generation: action.execution_generation
  }

  if (action.kind === 'approval') {
    if (!action.request_id || (choice !== 'once' && choice !== 'deny')) {
      throw new Error('Approval requires its exact request ID and an explicit choice')
    }

    params.request_id = action.request_id
    params.choice = choice
  }

  return canonicalGroupRequest(binding, method, params)
}
