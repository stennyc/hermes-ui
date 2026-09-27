import type { Unstable_TriggerAdapter, Unstable_TriggerItem } from '@assistant-ui/core'
import { useCallback } from 'react'

import { useContributions } from '@/contrib/react/use-contributions'
import type { HermesGateway } from '@/hermes'
import { normalize } from '@/lib/text'

import type { ComposerAtCompletionSource } from '../contrib'
import { COMPOSER_AREAS } from '../contrib'

import type { CompletionEntry, CompletionPayload } from './use-live-completion-adapter'
import { useLiveCompletionAdapter } from './use-live-completion-adapter'

const KIND_RE = /^@(file|folder|url|image|tool|git):(.*)$/
const REF_STARTERS = new Set(['file', 'folder', 'url', 'image', 'tool', 'git'])

const STARTER_META: Record<string, string> = {
  file: 'Attach a file reference',
  folder: 'Attach a folder reference',
  url: 'Attach a URL reference',
  image: 'Attach an image reference',
  tool: 'Attach a tool reference',
  git: 'Attach git context'
}

function starterEntries(query: string): CompletionEntry[] {
  const q = normalize(query)
  const kinds = Array.from(REF_STARTERS)
  const filtered = q ? kinds.filter(kind => kind.startsWith(q)) : kinds

  return filtered.map(kind => ({
    text: `@${kind}:`,
    display: `@${kind}:`,
    meta: STARTER_META[kind] || ''
  }))
}

interface AtItemMetadata extends Record<string, string> {
  icon: string
  display: string
  meta: string
  /** Raw `text` field from the gateway, e.g. `@file:src/main.tsx` or `@diff`. */
  rawText: string
  /** Just the value portion (after `@kind:`), or empty for simple refs. */
  insertId: string
}

function textValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Parse the gateway's `text` field (`@file:src/foo.ts`, `@diff`, `@folder:`) into popover-ready data. */
function classify(entry: CompletionEntry): {
  type: string
  insertId: string
  display: string
  meta: string
} {
  const match = KIND_RE.exec(entry.text)

  if (match) {
    const [, kind, rest] = match

    return {
      type: kind,
      insertId: rest,
      display: textValue(entry.display, rest || `@${kind}:`),
      meta: textValue(entry.meta)
    }
  }

  return {
    type: 'simple',
    insertId: entry.text,
    display: textValue(entry.display, entry.text),
    meta: textValue(entry.meta)
  }
}

/** Live `@` completions backed by the gateway's `complete.path` RPC. */
export function useAtCompletions(options: {
  gateway: HermesGateway | null
  sessionId: string | null
  cwd: string | null
}): { adapter: Unstable_TriggerAdapter; loading: boolean } {
  const { gateway, sessionId, cwd } = options
  const enabled = Boolean(gateway)

  const contributed = useContributions(COMPOSER_AREAS.atCompletions)

  // Contributed rows for the query (composer.atCompletions — e.g. Bot Mode
  // agent handles), mapped into the gateway entry shape so one classify/toItem
  // path renders every row, merged ABOVE the path/reference results. Provider
  // errors are isolated: a throwing source drops ITS rows, never the popover.
  const contributedEntries = useCallback(
    (query: string): CompletionEntry[] => {
      const out: CompletionEntry[] = []

      for (const contribution of contributed) {
        const source = contribution.data as ComposerAtCompletionSource | undefined

        if (!source || typeof source.provide !== 'function') {
          continue
        }

        try {
          for (const item of source.provide(query) || []) {
            if (!item || typeof item.insert !== 'string' || !item.insert) {
              continue
            }

            out.push({
              text: item.insert,
              display: item.display || item.insert,
              meta: item.meta || ''
            })
          }
        } catch {
          /* a broken source must not take down @ completions */
        }
      }

      return out
    },
    [contributed]
  )

  const fetcher = useCallback(
    async (query: string): Promise<CompletionPayload> => {
      const starters = starterEntries(query)
      const extras = contributedEntries(query)

      if (!gateway) {
        return { items: [...extras, ...starters], query }
      }

      const word = REF_STARTERS.has(query) ? `@${query}:` : `@${query}`
      const params: Record<string, unknown> = { word }

      if (sessionId) {
        params.session_id = sessionId
      }

      if (cwd) {
        params.cwd = cwd
      }

      try {
        const result = await gateway.request<{ items?: CompletionEntry[] }>('complete.path', params)
        const items = result.items ?? []

        return { items: [...extras, ...(items.length > 0 ? items : starters)], query }
      } catch {
        return { items: [...extras, ...starters], query }
      }
    },
    [contributedEntries, gateway, sessionId, cwd]
  )

  const toItem = useCallback((entry: CompletionEntry, index: number): Unstable_TriggerItem => {
    const classified = classify(entry)

    const metadata: AtItemMetadata = {
      icon: classified.type,
      display: classified.display,
      meta: classified.meta,
      rawText: entry.text,
      insertId: classified.insertId
    }

    return {
      // Unique id keyed on the gateway's full `text` so two entries that share
      // a basename (e.g. multiple `index.ts`) don't collide in keyboard nav.
      id: `${entry.text}|${index}`,
      type: classified.type,
      label: classified.display,
      ...(classified.meta ? { description: classified.meta } : {}),
      metadata
    }
  }, [])

  return useLiveCompletionAdapter({ enabled, fetcher, toItem })
}

/** Re-export `classify` for use by the formatter (insertion side). */
export { classify }
