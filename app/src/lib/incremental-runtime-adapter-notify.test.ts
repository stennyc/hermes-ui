/**
 * Regression tests for the bot-chat tile crash observed live on 2026-08-23:
 *
 *   [error-boundary:contrib:session-tile:20260823_213059_ed6222]
 *   Error: Maximum update depth exceeded. The result of getSnapshot should be
 *   cached to avoid an infinite loop.
 *     at UseTapEffects (assistant-ui internal)
 *     at AuiProvider
 *     at ChatRuntimeBoundary (src/app/chat/index.tsx)
 *     at TileChat / SessionTilePane (src/app/chat/session-tile.tsx)
 *
 * Mechanism under test: ChatRuntimeBoundary passes a FRESH adapter object
 * literal to useIncrementalExternalStoreRuntime on every render. The
 * [runtime, store] effect therefore re-runs each render, and
 * IncrementalExternalStoreThreadRuntimeCore.__internal_setAdapter's
 * "nothing changed" fast path (same isRunning + same messageRepository)
 * still calls _notifySubscribers() unconditionally. A subscriber whose
 * notification re-renders the boundary then produces:
 *   render -> new store literal -> effect -> setAdapter -> notify -> render
 * an unbounded feedback loop that trips React's update-depth guard and
 * takes the whole session tile down with the error boundary.
 *
 * The invariant pinned here: handing __internal_setAdapter an adapter that is
 * a NEW OBJECT but semantically identical (same messageRepository identity,
 * same isRunning, same capabilities) must NOT notify subscribers. Notify is
 * for observable state changes, not for object-identity churn of the adapter
 * literal — the render loop is impossible once no-op swaps are silent.
 */
import { fromThreadMessageLike, getAutoStatus } from '@assistant-ui/core/internal'
import type { ExportedMessageRepository, ExternalStoreAdapter, ThreadMessage } from '@assistant-ui/react'
import { describe, expect, it } from 'vitest'

import { IncrementalExternalStoreRuntimeCore } from './incremental-external-store-runtime'

const STATUS = getAutoStatus(false, false, false, false, undefined)

function message(id: string, text: string): ThreadMessage {
  return fromThreadMessageLike({ role: 'assistant', content: [{ type: 'text', text }] }, id, STATUS)
}

function userMessage(id: string, text: string): ThreadMessage {
  return fromThreadMessageLike({ role: 'user', content: [{ type: 'text', text }] }, id, STATUS)
}

function repositoryOf(messages: ThreadMessage[]): ExportedMessageRepository {
  return {
    headId: messages.at(-1)?.id ?? null,
    messages: messages.map((item, index) => ({
      message: item,
      parentId: index === 0 ? null : messages[index - 1].id
    }))
  }
}

function adapterWith(messageRepository: ExportedMessageRepository, extra: Partial<ExternalStoreAdapter> = {}) {
  // Deliberately a fresh object each call — mirrors the inline literal in
  // ChatRuntimeBoundary (src/app/chat/index.tsx) whose closures (onNew,
  // onCancel, ...) are re-created per render.
  return {
    messageRepository,
    isRunning: false,
    setMessages: () => {},
    onNew: async () => {},
    onCancel: async () => {},
    ...extra
  } as ExternalStoreAdapter
}

describe('IncrementalExternalStoreThreadRuntimeCore adapter swap notifications', () => {
  it('does NOT notify subscribers when a new adapter object carries identical state (render-loop guard)', () => {
    const repo = repositoryOf([message('a', 'one'), message('b', 'two')])
    const core = new IncrementalExternalStoreRuntimeCore(adapterWith(repo))
    const thread = core.threads.getMainThreadRuntimeCore()

    let notifications = 0
    thread.subscribe(() => {
      notifications += 1
    })

    // Simulate 5 renders of ChatRuntimeBoundary: each passes a NEW adapter
    // literal with the SAME messageRepository identity and same isRunning.
    for (let render = 0; render < 5; render += 1) {
      core.setAdapter(adapterWith(repo))
    }

    // The live bug: this was 5 — one notify per render, each notify able to
    // schedule the next render. Silent no-op swaps break the feedback loop.
    expect(notifications).toBe(0)
  })

  it('still notifies when the message repository actually changes', () => {
    const repo = repositoryOf([message('a', 'one')])
    const core = new IncrementalExternalStoreRuntimeCore(adapterWith(repo))
    const thread = core.threads.getMainThreadRuntimeCore()

    let notifications = 0
    thread.subscribe(() => {
      notifications += 1
    })

    const grown = repositoryOf([message('a', 'one'), message('b', 'two')])
    core.setAdapter(adapterWith(grown))

    expect(notifications).toBeGreaterThan(0)
  })

  it('still notifies on an isRunning flip (turn start/stop must reach the thread UI)', () => {
    const repo = repositoryOf([message('a', 'one')])
    const core = new IncrementalExternalStoreRuntimeCore(adapterWith(repo))
    const thread = core.threads.getMainThreadRuntimeCore()

    let notifications = 0
    thread.subscribe(() => {
      notifications += 1
    })

    core.setAdapter(adapterWith(repo, { isRunning: true }))

    expect(notifications).toBeGreaterThan(0)
  })

  it('still notifies on an isDisabled flip even when transcript and run state are unchanged', () => {
    const repo = repositoryOf([message('a', 'one')])
    const core = new IncrementalExternalStoreRuntimeCore(adapterWith(repo))
    const thread = core.threads.getMainThreadRuntimeCore()

    let notifications = 0
    thread.subscribe(() => {
      notifications += 1
    })

    core.setAdapter(adapterWith(repo, { isDisabled: true }))

    expect(notifications).toBeGreaterThan(0)

    // And flipping back also notifies — but an unchanged repeat stays silent.
    const beforeFlipBack = notifications
    core.setAdapter(adapterWith(repo, { isDisabled: false }))

    expect(notifications).toBeGreaterThan(beforeFlipBack)

    const afterFlipBack = notifications

    core.setAdapter(adapterWith(repo, { isDisabled: false }))

    expect(notifications).toBe(afterFlipBack)
  })

  it('a subscriber that swaps a fresh-but-identical adapter on every notify must not recurse unboundedly', () => {
    // Direct simulation of the feedback loop: the subscriber plays the role of
    // React re-rendering ChatRuntimeBoundary (new literal -> setAdapter). With
    // the bug, every setAdapter notifies, the subscriber re-enters setAdapter,
    // and only the depth guard stops it. Fixed behavior: the first no-op swap
    // is silent, so the subscriber never fires and depth stays 0.
    const repo = repositoryOf([message('a', 'one')])
    const core = new IncrementalExternalStoreRuntimeCore(adapterWith(repo))
    const thread = core.threads.getMainThreadRuntimeCore()

    let depth = 0
    thread.subscribe(() => {
      depth += 1

      if (depth > 25) {
        throw new Error('Maximum update depth exceeded (simulated): adapter no-op swaps are notifying subscribers')
      }

      core.setAdapter(adapterWith(repo))
    })

    core.setAdapter(adapterWith(repo))

    expect(depth).toBe(0)
  })

  it('does NOT notify when a streaming delta republishes identical content under a fresh repository ref (full-path no-op)', () => {
    // Distinct from the render-loop guard above: here the guard at the same
    // isRunning + same repo identity does NOT fire (repo1 !== repo2), so the
    // FULL path runs. But the content is referentially identical, so the sync
    // is a no-op and getMessages() returns the same internal ref — the new
    // content-aware gate must suppress the notify that used to start the
    // unbounded streaming feedback loop.
    const a = message('a', 'one')
    const b = message('b', 'two')
    const repo1 = repositoryOf([a, b])
    const repo2 = repositoryOf([a, b]) // fresh object, same underlying message refs

    const core = new IncrementalExternalStoreRuntimeCore(adapterWith(repo1))
    const thread = core.threads.getMainThreadRuntimeCore()

    let notifications = 0
    thread.subscribe(() => {
      notifications += 1
    })

    // repo1 !== repo2 forces the full path; identical content must stay silent.
    core.setAdapter(adapterWith(repo2))

    expect(notifications).toBe(0)
  })

  it('still notifies when a fresh repository ref carries new content (streaming tail growth)', () => {
    const a = message('a', 'one')
    const b = message('b', 'two')
    const repo1 = repositoryOf([a, b])

    const core = new IncrementalExternalStoreRuntimeCore(adapterWith(repo1))
    const thread = core.threads.getMainThreadRuntimeCore()

    let notifications = 0
    thread.subscribe(() => {
      notifications += 1
    })

    const c = message('c', 'three')
    const repo2 = repositoryOf([a, b, c]) // fresh ref, NEW tail

    core.setAdapter(adapterWith(repo2))

    expect(notifications).toBeGreaterThan(0)
  })

  it('streaming no-op (isRunning + user tail + placeholder) notifies once, then stays silent across fresh-adapter repeats', () => {
    // The live crash path: a running turn whose external transcript ends on a
    // USER message. The core mints an optimistic placeholder under the tail
    // and, on every full-path re-entry (fresh adapter literal per render,
    // fresh messageRepository ref, IDENTICAL content) the old code deleted
    // the placeholder and minted a fresh-id one, dirtying getMessages() each
    // round so the content gate never closed. With placeholder REUSE the
    // steady-state round performs zero writes: the first entry (placeholder
    // mint) must notify, every subsequent no-op repeat must NOT.
    const user = userMessage('u', 'ask')
    const repo1 = repositoryOf([user])

    const core = new IncrementalExternalStoreRuntimeCore(adapterWith(repo1))
    const thread = core.threads.getMainThreadRuntimeCore()

    let notifications = 0
    thread.subscribe(() => {
      notifications += 1
    })

    // Entry 1: placeholder minted (new observable state) -> exactly 1.
    const repo2 = repositoryOf([user]) // fresh object, same content
    core.setAdapter(adapterWith(repo2, { isRunning: true }))
    expect(notifications).toBe(1)

    // Entries 2-12: identical content, fresh refs each time, placeholder
    // still wanted. Zero notifies on top of entry 1.
    for (let round = 2; round <= 12; round += 1) {
      core.setAdapter(adapterWith(repositoryOf([user]), { isRunning: true }))
    }
    expect(notifications).toBe(1)

    // A REAL delta (settled assistant reply appended, tail becomes assistant
    // -> placeholder evicted) must notify again.
    const reply = message('r', 'answer')
    core.setAdapter(adapterWith(repositoryOf([user, reply]), { isRunning: true }))
    expect(notifications).toBe(2)

    // isRunning clears with no content change: the placeholder-drop already
    // notified; the flip itself is a further observable change.
    core.setAdapter(adapterWith(repositoryOf([user, reply]), { isRunning: false }))
    expect(notifications).toBe(3)
  })
})
