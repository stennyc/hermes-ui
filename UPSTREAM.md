# Provenance

`app/` and `shared/` are extracted from the Hermes Agent monorepo (MIT licensed, Copyright (c) 2025 Nous Research; see `LICENSE`).
| 2026-09-24 | gateways | i18n | 支持 Gateway 配置国际化 |


- Upstream: `hermes-agent` repository, `apps/desktop` and `apps/shared`.
- Extracted at upstream commit: `56a8e81d33a524f0ba0d68b6d54c8786ed283fb8` (2026-07-08).
- Extraction date: 2026-07-11.

## What was changed from upstream

- Removed everything Electron: `electron/`, `scripts/`, `packaging/`, `tsconfig.electron.json`, electron/electron-builder deps and scripts, native deps (`node-pty`, `simple-git`).
- `package.json` rewritten for a plain Vite web app (renamed `hermes-ui`).
- `vite.config.ts`: removed monorepo-root react aliases and worktree fs.allow hack; added a dev proxy for `/api`, `/auth`, `/login` to a local gateway (`HERMES_GATEWAY_URL`, default `http://127.0.0.1:9119`).
- `tsconfig.json`: dropped the Electron project reference.
- Added a web implementation of the `window.hermesDesktop` preload bridge (see `app/src/web-bridge/`); web-capable methods are real, Electron-only methods are stubbed behind a capability flag.

## Re-syncing with upstream

Diff `hermes-agent/apps/desktop/src` against `app/src` (and `apps/shared/src` against `shared/src`) from the recorded commit forward, and re-apply upstream changes.
Keep local modifications minimal and centralized in `src/web-bridge/` so upstream diffs stay clean.

## Sync log

This is the running watermark for incremental upstream syncs.
When you sync, always diff upstream `apps/desktop/src` + `apps/shared/src` from the **Last synced commit** below forward, port the web-applicable changes, then bump the watermark.

- **Last synced upstream commit:** `f0aae14c684a84cd1eeca88339238406c30f3ed7` (2026-07-20).
- **Last sync date:** 2026-07-20.
- **Baseline before this sync:** `56a8e81` (the original extraction).

### 2026-07-20 - partial sync of the 2026-06-29 -> 2026-07-20 window (merged desktop PRs)

Full re-sync was staged. This sync landed the self-contained perf/fix/feature improvements that map onto files already in this repo, and deliberately deferred the large architectural changes to a follow-up.

**Ported (this repo now matches upstream `f0aae14` for these):** perf improvements to the thread/streaming/tool-render path, sidebar/session slices, layout-thrash fixes, markdown streaming, and many leaf stores, libs, hooks, and components; plus i18n string updates and the `shared/` changes.

**Deferred to a follow-up (PR2) - do NOT assume these are synced:**
- The `contrib`/plugin system that absorbed `desktop-controller`, `app-shell`, and `keybind-panel` (these files are kept in their pre-refactor web-adapted form here).
- The `components/pane-shell/tree/*` layout-engine rewrite (this repo still uses the pre-tree `pane-shell`).
- The `store/session-states` extraction and the expanded `store/session` API that depends on it.
- The expanded `types/hermes.ts` / `global.d.ts` surface: `cloud` gateway mode + custom endpoints, terminal-backend picker, worktree base-branch, per-job cron model. These require matching `web-bridge` work.
- The `@assistant-ui/react` 0.12 -> 0.14 (+ `react-streamdown` 0.1 -> 0.3) major upgrade, which the new markdown/runtime code needs.
- **Billing** (`app/settings/billing/*`, `shared/billing-*`, `charge-settlement`): intentionally excluded from the web build per project decision; skip on future syncs unless that decision changes.

When picking up PR2, start from the deferred list above rather than re-diffing from `56a8e81`.

### 2026-08-19 - Bot Mode port from upstream `v2026.8.18` (issue #34)

This port brings upstream's Bot Mode (the bundled `hermes-bots` plugin) plus the minimum plugin-system machinery it needs, WITHOUT the full PR2 architectural sync.
The general watermark above is unchanged - only the files below track `v2026.8.18` (`e624e9f`).

**Ported verbatim from upstream `apps/desktop/src` at `v2026.8.18`:**
- `contrib/` framework: `types.ts`, `registry.ts`, `events.ts`, `plugins-store.ts`, `index.ts`, `react/{boundary,contribute,slot,use-contributions}` (+ `slot.test.tsx`).
- `plugins/hermes-bots/plugin.js` (byte-identical) + its `tests/` (run via `npm run test:plugins` under `node --test`, excluded from vitest).
- `app/chat/composer/contrib.ts` (minus the `microActions` provider surface, which needs the unported `store/composer-actions`).
- `app/command-palette/contrib.ts`, `i18n/plugin-i18n.ts`, `lib/budgeted-loop.ts`, `lib/renderer-loop-pause.ts`.

**Web-adapted (documented in-file):**
- `contrib/plugin.ts`: `ctx.socket` is a no-op disposer, `ctx.os.notify`/`revealPath` are inert, `ctx.rest` rides the web bridge `api` (no multipart `upload` yet).
- `contrib/plugins.ts`: bundled discovery only - the disk-door `runtime-loader` is omitted (needs desktop fs watchers).
- `sdk/index.ts` (`@hermes/plugin-sdk` alias): web host - single-connection (no `agents`/`connections`/`ensureAgent`/`requestProfile`/`openWorkspace`), no `SkillsView`/`McpTab`/`ToolsetConfigPanel` exports (the web versions lack `fixedProfile` scoping; plugins use their profile-correct staged fallbacks), `paneVisibility` backed by the pane host below.
- `app/contrib/pane-host.tsx` (new, web-only): maps `area: 'panes'` contributions onto the fixed shell instead of the tree engine - sessions-docked panes become a SESSIONS | BOTS sidebar tab strip, workspace/right panes become right-edge `<Pane>`s.
- `store/gateway.ts`: added `retireProfileGateway` (upstream `retireLocalProfileGateways` analog) so a profile delete can't be resurrected by its own socket (upstream #52279).

**Seams cut into existing files:** composer submit middleware (`runComposerMiddleware` in `app/chat/composer/index.tsx`), contributed `@` completion sources (`hooks/use-at-completions.ts`), contributed palette rows (`app/command-palette/index.tsx`), plugin boot + right panes (`app/desktop-controller.tsx`), sidebar tab strip (`app/chat/sidebar/index.tsx`), `pluginRest` (`hermes.ts`), plugin i18n re-exports (`i18n/index.ts`).

**Still deferred (on top of the PR2 list):** the tree layout engine, `Settings > Plugins` page (plugins can only be toggled via the persisted `hermes.desktop.pluginDecisions.v2` storage key for now), `contrib/runtime-loader.ts`, `store/composer-actions` + composer micro-actions, `blobatarSvg` avatars (not present upstream at this tag either - the plugin's classic-shapes fallback renders).

### 2026-10-01 - B0 prep for v2026.9.24 sync (task t_6d74d139)

Backup tag `backup/pre-sync-2026.9.24` created at `40a151e` (rollback point for the 9.24
incremental sync; named to avoid collision with the 0924-era tags `backup/pre-sync-20260924`
and `backup/pre-resync-20260924`).

Hub methodology loaded before B1 (sources: `hermes-ui-debug` hub + spec §7). Key points
for B1-B7 executors:

1. **getSnapshot audit** (hub `references/get-snapshot-audit-map.md`): any new store/selector
   whose `useSyncExternalStore` getSnapshot returns a fresh (uncached) reference causes
   `Maximum update depth exceeded` death loops (amplified by long sessions / streaming).
   Hot spots: the `useSessionSlice` / `useStoreSelector` / `useStoresSelector` series in
   `lib/use-session-slice.ts` and the incremental adapter runtime second loop path. Before
   touching any of these, check the audit map first; when adding multi-line selectors,
   verify the RETURN type is a primitive or a reference-stable (module-level cached) value.
2. **DCE side-effect trap** (hub `references/dce-sideeffects-trap.md`): `nanostores` ships
   `"sideEffects": false`, so vite/rolldown build will delete "apparently unused" side-effect
   store registrations (e.g. a bare `batch(fn)` statement with discarded return value) -
   dev works, prod silently empty, zero console errors. Any new store must have an import
   path referenced in the module tree (or a return value feeding a global sink like
   `globalThis.<MARKER> = ...`); it cannot rely on runtime-only registration.
3. **i18n types first** (spec §B1): in B1, define the `i18n/types.ts` schema before writing
   language files (`fr.ts` / `es.ts` / `de.ts`, `intro-*.tsx`); all language files copy the
   structure from the types. Skipping this order makes every language file fail schema
   checks. No key-parity test exists, so dropping keys is safe.
4. **served-bytes staleness verification** (hub "Served bundle is stale" triage + spec §B7;
   used at B7, recorded here up front): a bare check of `/` (or `/login`) can return 302
   redirects or a stale PWA/`HERMES_WEB_DIST` cache - do NOT trust it. After build+deploy,
   curl the NEW concrete chunk directly (`/assets/index-<newHash>.js`) and compare the
   served byte count against the local `dist` build; use minify-surviving markers / string
   literals (not symbol names) when grepping chunks; i18n copy lives in
   `assets/i18n-<hash>.js`, not the main chunk.
