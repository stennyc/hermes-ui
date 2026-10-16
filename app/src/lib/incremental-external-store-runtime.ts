import {
  AssistantRuntimeImpl,
  BaseAssistantRuntimeCore,
  ExternalStoreThreadListRuntimeCore,
  ExternalStoreThreadRuntimeCore
} from '@assistant-ui/core/internal'
import {
  type AssistantRuntime,
  type ExternalStoreAdapter,
  fromThreadMessageLike,
  generateId,
  type ThreadMessage,
  useRuntimeAdapters
} from '@assistant-ui/react'
import { useEffect, useMemo, useState } from 'react'

const EMPTY_ARRAY = Object.freeze([])

const shallowEqual = (a: object, b: object): boolean => {
  const aKeys = Object.keys(a)

  if (aKeys.length !== Object.keys(b).length) {
    return false
  }

  for (const key of aKeys) {
    if (a[key as keyof typeof a] !== b[key as keyof typeof b]) {
      return false
    }
  }

  return true
}

const getThreadListAdapter = (store: ExternalStoreAdapter) => store.adapters?.threadList ?? {}

/**
 * Write only the items whose (message, parentId) pair actually moved.
 *
 * `useRuntimeMessageRepository` caches normalized ThreadMessages by source
 * identity, so a settled turn keeps the SAME object across renders. That makes
 * an identity check a sound "did this change?" test: during streaming exactly
 * one item — the growing tail — differs, and the other N-1 writes were pure
 * overhead that grew with transcript length.
 *
 * Returns false when the export is stale (an id in `existing` is gone, or an
 * incoming message has no repository entry yet), so the caller falls back to
 * the full rebuild rather than guessing.
 */
function applyChangedMessages(
  repository: ExternalStoreThreadRuntimeCore['repository'],
  existing: readonly { message: ThreadMessage; parentId: string | null }[],
  incoming: readonly { message: ThreadMessage; parentId: string | null }[]
): boolean {
  if (existing.length !== incoming.length) {
    return false
  }

  const existingById = new Map(existing.map(item => [item.message.id, item]))

  for (const item of incoming) {
    const current = existingById.get(item.message.id)

    if (!current) {
      return false
    }

    // Reference identity, not deep equality: the conversion cache guarantees a
    // stable object for an unchanged turn, and a changed turn is a new object.
    if (current.message !== item.message || current.parentId !== item.parentId) {
      repository.addOrUpdateMessage(item.parentId, item.message)
    }
  }

  return true
}

export function syncRepositoryIncrementally(
  runtime: ExternalStoreThreadRuntimeCore,
  messageRepository: NonNullable<ExternalStoreAdapter['messageRepository']>
): readonly ThreadMessage[] {
  const repository = (runtime as unknown as { repository: ExternalStoreThreadRuntimeCore['repository'] }).repository
  const incoming = messageRepository.messages
  const existing = repository.export().messages
  const headId = messageRepository.headId ?? incoming.at(-1)?.message.id ?? null

  // A thread switch swaps in a fully-DISJOINT transcript (no id carries over).
  // Reconciling two unrelated trees in place — grafting the new chain onto the
  // old one, then pruning — can strand a stale head/branch, so there's nothing
  // to preserve: clear the tree first (leaves→root), then rebuild clean.
  const incomingIds = new Set(incoming.map(({ message }) => message.id))
  const disjoint = existing.length > 0 && !existing.some(({ message }) => incomingIds.has(message.id))

  // Steady-state streaming: same message set, one item changed. Skip the
  // whole-transcript rewrite, the prune scan, and the second export. resetHead
  // deletes the head's descendants, so it only runs when the head really moved.
  if (!disjoint && applyChangedMessages(repository, existing, incoming)) {
    // Compare the CANONICAL (non-optimistic) head against the export's head:
    // the live head may sit on the optimistic placeholder minted by the
    // caller, which `headId` reports as a different id even when the real
    // tail never moved. Resetting on that false difference every round
    // evicts the placeholder (lib evictOffBranchOptimisticMessages),
    // re-dirties the _messages cache, and reopens the render-loop that the
    // caller's content gate is supposed to close.
    if (repository.canonicalHeadId !== headId) {
      repository.resetHead(headId)
    }

    return repository.getMessages()
  }

  if (disjoint) {
    for (const { message } of [...existing].reverse()) {
      repository.deleteMessage(message.id)
    }
  }

  for (const { message, parentId } of incoming) {
    repository.addOrUpdateMessage(parentId, message)
  }

  for (const { message } of repository.export().messages) {
    if (!incomingIds.has(message.id)) {
      repository.deleteMessage(message.id)
    }
  }

  repository.resetHead(headId)

  return repository.getMessages()
}

class IncrementalExternalStoreThreadRuntimeCore extends ExternalStoreThreadRuntimeCore {
  override __internal_setAdapter(store: ExternalStoreAdapter): void {
    if (!store.messageRepository) {
      super.__internal_setAdapter(store)

      return
    }

    const self = this as unknown as {
      _assistantOptimisticId: null | string
      _capabilities: object
      _messages: readonly ThreadMessage[]
      _notifyEventSubscribers: (event: string, payload: object) => void
      _notifySubscribers: () => void
      _store?: ExternalStoreAdapter
    }

    if (self._store === store) {
      return
    }

    const isRunning = store.isRunning ?? false
    const newDisabled = store.isDisabled ?? false
    const disabledChanged = this.isDisabled !== newDisabled
    this.isDisabled = newDisabled

    const oldStore = self._store
    self._store = store

    // Track whether anything OBSERVABLE changed. ChatRuntimeBoundary passes a
    // fresh adapter literal on every render, so identity churn of the adapter
    // object itself is NOT a change — notifying on it lets a subscriber whose
    // notification re-renders the boundary drive an unbounded feedback loop
    // (render -> new literal -> setAdapter -> notify -> render), which React
    // kills with "Maximum update depth exceeded" and takes the session tile
    // down with its error boundary.
    let changed = disabledChanged

    if (this.extras !== store.extras) {
      this.extras = store.extras
      changed = true
    }

    const newSuggestions = store.suggestions ?? EMPTY_ARRAY

    if (!shallowEqual(this.suggestions, newSuggestions)) {
      this.suggestions = newSuggestions
      changed = true
    }

    const newCapabilities = {
      switchToBranch: store.setMessages !== undefined,
      switchBranchDuringRun: false,
      edit: store.onEdit !== undefined,
      reload: store.onReload !== undefined,
      cancel: store.onCancel !== undefined,
      speech: store.adapters?.speech !== undefined,
      dictation: store.adapters?.dictation !== undefined,
      voice: store.adapters?.voice !== undefined,
      unstable_copy: store.unstable_capabilities?.copy !== false,
      attachments: !!store.adapters?.attachments,
      feedback: !!store.adapters?.feedback,
      queue: false
    }

    if (!shallowEqual(self._capabilities, newCapabilities)) {
      self._capabilities = newCapabilities
      changed = true
    }

    if (oldStore && oldStore.isRunning === store.isRunning && oldStore.messageRepository === store.messageRepository) {
      // Same transcript, same run state: notify only if extras/suggestions/
      // capabilities actually moved. A silent no-op swap here is what breaks
      // the render feedback loop — see the render-loop guard test.
      if (changed) {
        self._notifySubscribers()
      }

      return
    }

    // Capture before-state for the notify gate below. The full path is
    // entered when messageRepository REF changed (streaming republishes a
    // fresh array ~30x/s) even if the CONTENT is identical. Without a
    // content-aware gate, _notifySubscribers() fires on every republish,
    // re-triggers the subscriber → re-render → setAdapter → notify loop
    // that React kills with "Maximum update depth exceeded".
    const prevMessages = self._messages ?? EMPTY_ARRAY
    const isRunningFlipped = (oldStore?.isRunning ?? false) !== (store.isRunning ?? false)
    const isInitial = oldStore === undefined || oldStore === null

    // PLACEHOLDER REUSE, not delete+re-mint. The old code deleted the
    // placeholder and minted a fresh generateId() one on EVERY full-path
    // entry. During steady streaming the full path runs on every republish
    // (fresh messageRepository ref, identical content), so the delete
    // (lib _messages.dirty()) + re-mint (dirty) + resetHead eviction cycle
    // kept getMessages() returning a FRESH array every round and the
    // content gate below could never close the loop. The placeholder is
    // pure ephemeral state: keep the SAME id while it is still wanted,
    // delete only when it goes away, mint only when it was absent.
    const messages = syncRepositoryIncrementally(this, store.messageRepository)

    if (messages.length > 0) {
      this.ensureInitialized()
    }

    if (isRunningFlipped) {
      self._notifyEventSubscribers(store.isRunning ? 'runStart' : 'runEnd', {})
    }

    // PLACEHOLDER REUSE, not delete+re-mint. The old code deleted the
    // placeholder and minted a fresh generateId() one on EVERY full-path
    // entry. During steady streaming the full path runs on every republish
    // (fresh messageRepository ref, identical content), so the delete
    // (lib _messages.dirty()) + re-mint (dirty) + resetHead eviction cycle
    // kept getMessages() returning a FRESH array every round and the
    // content gate below could never close the loop. The placeholder is
    // pure ephemeral state: keep the SAME id while it is still wanted and
    // still parented correctly, delete only when it goes away, mint only
    // when absent or re-parented.
    const prevPlaceholderId = self._assistantOptimisticId ?? null
    // While the placeholder is ALIVE it sits at the head (end of the head
    // branch) of the snapshot syncRepositoryIncrementally returns, so the
    // last REAL message is at(-2). After a disjoint/thread-switch rebuild
    // the live sync evicts it and the stale id must not be re-queried:
    // detect liveness from the snapshot tail, not from the id alone.
    const last = messages.at(-1)
    const placeholderAlive = last?.id === prevPlaceholderId
    const tail = placeholderAlive ? messages.at(-2) : last
    const wantsPlaceholder = isRunning && tail?.role !== 'assistant'
    // `?.parentId`: the live snapshot and the repository's live messages can
    // diverge for one tick right after a disjoint rebuild evicted the
    // placeholder; the optional chain degrades to null (placeholder treated
    // as unparented → re-minted on the next branch) instead of throwing.
    const placeholderParent =
      placeholderAlive && prevPlaceholderId
        ? (this.repository.getMessage(prevPlaceholderId)?.parentId ?? null)
        : null
    if (prevPlaceholderId && placeholderAlive && !wantsPlaceholder) {
      // Turn ended or a settled assistant reply landed: drop the spinner.
      this.repository.deleteMessage(prevPlaceholderId)
      self._assistantOptimisticId = null
    } else if (wantsPlaceholder && !(placeholderAlive && placeholderParent === (tail?.id ?? null))) {
      // No live placeholder, or the real tail moved under it: re-parent
      // (delete + mint) so the placeholder always follows the live tail.
      if (prevPlaceholderId && placeholderAlive) {
        this.repository.deleteMessage(prevPlaceholderId)
      }
      const optimisticId = generateId()
      this.repository.addOrUpdateMessage(
        tail?.id ?? null,
        fromThreadMessageLike({ role: 'assistant', content: [], metadata: { isOptimistic: true } }, optimisticId, {
          type: 'running'
        })
      )
      self._assistantOptimisticId = optimisticId
    } else {
      // Keep-or-clear bookkeeping: a stale id whose placeholder the sync
      // already evicted must not survive into the targetHead computation.
      self._assistantOptimisticId = placeholderAlive ? prevPlaceholderId : null
    }

    // Only resetHead when the target actually differs from the current head.
    // The lib's resetHead() unconditionally calls _messages.dirty(), so an
    // idempotent reset (head already at target) would recompute getMessages()
    // into a FRESH array and defeat the content-aware gate below. A streaming
    // no-op (identical content, fresh repository ref, placeholder REUSED)
    // performs zero writes, keeps the cache clean, and getMessages() returns
    // the same ref. The target is the live placeholder when present, else
    // the last REAL tail — never the snapshot tail, which may be the
    // placeholder we just deleted.
    const targetHeadId = self._assistantOptimisticId ?? tail?.id ?? null
    if (targetHeadId !== this.repository.headId) {
      this.repository.resetHead(targetHeadId)
    }
    self._messages = this.repository.getMessages()

    // Gate: only notify when something OBSERVABLE actually changed.
    // - contentChanged: the message array ref moved (new tail written, head
    //   reset, or disjoint rebuild). The placeholder is internal state: a
    //   swap of the placeholder id itself is NOT observable, so only the
    //   PLACE-HOLDER-SLOT occupancy (present vs absent) counts, not the id.
    // - isRunningFlipped: turn start/stop must reach the thread UI.
    // - isInitial: first adapter set must notify to hydrate the thread.
    // A streaming delta that republishes identical content with a fresh
    // messageRepository ref produces a no-op repository sync — getMessages()
    // returns the SAME internal ref, so contentChanged is false and we skip
    // the notify that would start the unbounded feedback loop.
    // Ref-stable gate: getMessages() returns the SAME cached array whenever
    // nothing wrote since the last read. The placeholder is now REUSED (not
    // re-minted), so a no-op streaming round performs zero writes and the
    // ref comparison closes the loop. A real change (new tail, head move,
    // disjoint rebuild, placeholder mint/evict) dirties the cache and the
    // ref moves — notifying exactly then.
    const contentChanged = self._messages !== prevMessages
    // INVARIANT the ref-compare gate relies on: nothing between
    // `prevMessages` (captured above) and `getMessages()` below may write to
    // the repository when _messages is already non-empty. Today
    // ensureInitialized() is that no-op on the no-op path; if it ever starts
    // normalizing/dirtying, contentChanged goes true every round and the
    // loop re-opens — keep it read-only or move the write behind the gate.
    // `changed` (disabled/extras/suggestions/capabilities) is computed up top
    // and reused here: a flip of any of those is an observable change that
    // must reach subscribers even on a no-op repository sync.
    if (isInitial || contentChanged || isRunningFlipped || changed) {
      self._notifySubscribers()
    }
  }
}

export class IncrementalExternalStoreRuntimeCore extends BaseAssistantRuntimeCore {
  threads: ExternalStoreThreadListRuntimeCore

  constructor(adapter: ExternalStoreAdapter) {
    super()

    this.threads = new ExternalStoreThreadListRuntimeCore(
      getThreadListAdapter(adapter),
      () => new IncrementalExternalStoreThreadRuntimeCore(this._contextProvider, adapter)
    )
  }

  setAdapter(adapter: ExternalStoreAdapter): void {
    this.threads.__internal_setAdapter(getThreadListAdapter(adapter))
    this.threads.getMainThreadRuntimeCore().__internal_setAdapter(adapter)
  }
}

export function useIncrementalExternalStoreRuntime<T extends ThreadMessage>(
  store: ExternalStoreAdapter<T>
): AssistantRuntime {
  const [runtime] = useState(() => new IncrementalExternalStoreRuntimeCore(store as ExternalStoreAdapter))

  // Re-sync the adapter only when it actually changes — a dep-less effect ran
  // on EVERY render of the chat surface. `__internal_setAdapter` early-exits
  // when the store is unchanged, so gating on [runtime, store] is behavior-
  // preserving while skipping the per-render call entirely.
  useEffect(() => {
    runtime.setAdapter(store as ExternalStoreAdapter)
  }, [runtime, store])

  const { modelContext } = useRuntimeAdapters() ?? {}

  useEffect(() => {
    if (!modelContext) {
      return undefined
    }

    return runtime.registerModelContextProvider(modelContext)
  }, [modelContext, runtime])

  return useMemo(() => new AssistantRuntimeImpl(runtime), [runtime])
}
