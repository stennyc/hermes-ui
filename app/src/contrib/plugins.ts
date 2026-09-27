/**
 * Plugin discovery — bundled delivery mode:
 *
 *  - BUNDLED: every `src/plugins/<name>/plugin.{js,ts,tsx}` default-exporting
 *    a `HermesPlugin` registers automatically (vite glob — drop a folder in).
 *    `hermes-bots` (Bot Mode) ships in-tree and is ON by default. `.js`
 *    entries are SDK-consumer plugins adopted from upstream — they keep the
 *    plain-ESM plugin.js form so future upstream syncs stay a file copy.
 *
 * Web port note: upstream also watches the on-disk runtime doors
 * (`<hermes home>/desktop-plugins/…`) via contrib/runtime-loader.ts. That
 * pipeline needs the desktop bridge's filesystem watchers and is inert in a
 * browser, so the web build omits it entirely.
 */

import { createPluginContext, type HermesPlugin } from './plugin'
import { pluginActive, publishPlugin } from './plugins-store'

const modules = import.meta.glob<{ default: HermesPlugin }>('../plugins/*/plugin.{js,ts,tsx}', { eager: true })

// One-shot init guard. Contributions themselves register by id (re-registering
// is idempotent), but discovery is guarded to a single pass, not re-run on HMR.
let loaded = false

export function discoverBundledPlugins(): void {
  if (loaded) {
    return
  }

  loaded = true

  for (const [path, mod] of Object.entries(modules)) {
    const plugin = mod.default

    if (!plugin?.id || typeof plugin.register !== 'function') {
      console.warn(`[plugins] ${path} has no valid default HermesPlugin export — skipped`)

      continue
    }

    // Same inventory + live-toggle contract as upstream: each bundled plugin
    // publishes a record with activate/deactivate handles, and a persisted
    // disable survives boots by skipping registration here.
    const record = {
      id: plugin.id,
      name: plugin.name ?? plugin.id,
      description: plugin.description,
      kind: 'bundled' as const
    }

    let disposers: (() => void)[] = []

    const activate = () => {
      disposers.forEach(dispose => dispose())
      disposers = []

      try {
        plugin.register(createPluginContext(plugin.id, dispose => disposers.push(dispose)))
        publishPlugin({ ...record, status: 'loaded' })
      } catch (error) {
        console.error(`[plugins] ${plugin.id} failed to register`, error)
        publishPlugin({ ...record, status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    }

    const deactivate = () => {
      disposers.forEach(dispose => dispose())
      disposers = []
    }

    publishPlugin({ ...record, status: 'disabled' }, { activate, deactivate })

    if (pluginActive(plugin.id, plugin.defaultEnabled ?? true)) {
      activate()
    }
  }
}
