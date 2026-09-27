/**
 * Web pane host — a thin adapter that gives `area: 'panes'` contributions a
 * home without the upstream tree layout engine.
 *
 * Upstream (apps/desktop/src), contributed panes are adopted into a tiling
 * layout tree: a pane docked `{ pane: 'sessions', pos: 'center' }` stacks into
 * the sessions zone and the zone grows a SESSIONS | BOTS tab strip; a pane
 * docked `{ pane: 'workspace', pos: 'right' }` splits the workspace's right
 * edge. This web shell has no tree engine (deliberately deferred — see
 * UPSTREAM.md), so this module maps the SAME contribution contract onto the
 * existing fixed shell:
 *
 *  - sessions-docked panes  → tabs in the chat sidebar (strip appears only
 *    when at least one contributed pane exists, mirroring the upstream rule
 *    that a lone pane hides its zone header);
 *  - workspace/right panes  → fixed right-edge panes beside the chat.
 *
 * It also backs the SDK's `host.paneVisibility(paneId)` with the tab state,
 * matching the upstream semantics ("holding its zone's active tab slot").
 */

import { useStore } from '@nanostores/react'
import { atom, computed, type ReadableAtom } from 'nanostores'

import { ContribBoundary, ContribRender } from '@/contrib/react/boundary'
import { useContributions } from '@/contrib/react/use-contributions'
import { registry } from '@/contrib/registry'
import type { Contribution } from '@/contrib/types'
import { triggerHaptic } from '@/lib/haptics'
import { readKey, writeKey } from '@/lib/storage'
import { cn } from '@/lib/utils'

export const PANES_AREA = 'panes'

/** The sidebar's own tab id — always present, never a contribution. */
export const SESSIONS_TAB_ID = 'sessions'

/** Loose view of the `data` payload a pane contribution carries (the
 *  authoritative contract is upstream's PaneChrome; the web host reads only
 *  the placement/dock fields it can honor). */
interface PaneDock {
  pane?: string
  pos?: string
  enforce?: boolean
}

interface PaneChromeData {
  placement?: string
  width?: string
  minWidth?: string
  collapsible?: boolean
  dock?: PaneDock
}

const paneData = (c: Contribution): PaneChromeData => (c.data ?? {}) as PaneChromeData

const isSidebarPane = (c: Contribution): boolean => paneData(c).dock?.pane === SESSIONS_TAB_ID

const isWorkspaceRightPane = (c: Contribution): boolean => {
  const dock = paneData(c).dock

  return dock?.pane === 'workspace' && dock.pos === 'right'
}

/** Bumped whenever the 'panes' area mutates, so nanostores computeds can react
 *  to registry changes (React trees use `useContributions` instead). */
const $panesVersion = atom(0)

registry.subscribeArea(PANES_AREA, () => $panesVersion.set($panesVersion.get() + 1))

export function sidebarPaneContributions(): readonly Contribution[] {
  return registry.getArea(PANES_AREA).filter(isSidebarPane)
}

// ── Sidebar tab state ────────────────────────────────────────────────────────

const ACTIVE_TAB_STORAGE_KEY = 'hermes.web.sidebarPaneTab'

function initialSidebarTab(): string {
  return readKey(ACTIVE_TAB_STORAGE_KEY) ?? SESSIONS_TAB_ID
}

export const $activeSidebarTab = atom<string>(initialSidebarTab())

export function setActiveSidebarTab(id: string): void {
  $activeSidebarTab.set(id)
  writeKey(ACTIVE_TAB_STORAGE_KEY, id === SESSIONS_TAB_ID ? null : id)
}

// A persisted tab whose contribution never registers this boot (plugin
// disabled/removed) must not leave the sidebar stuck on a blank body. The tab
// is reconciled lazily rather than eagerly at module eval: plugins register
// during boot, after this module loads.
function reconcileActiveTab(): void {
  const active = $activeSidebarTab.get()

  if (active !== SESSIONS_TAB_ID && !sidebarPaneContributions().some(c => c.id === active)) {
    setActiveSidebarTab(SESSIONS_TAB_ID)
  }
}

registry.subscribeArea(PANES_AREA, reconcileActiveTab)

// ── host.paneVisibility backing ──────────────────────────────────────────────

const paneVisibleAtoms = new Map<string, ReadableAtom<boolean>>()

/** Reactive on-screen visibility of a contributed pane. Memoized per id —
 *  plugins call this in render. Sidebar-docked panes are visible while they
 *  hold the active tab; right-edge panes are visible while registered. */
export function $paneVisible(paneId: string): ReadableAtom<boolean> {
  const existing = paneVisibleAtoms.get(paneId)

  if (existing) {
    return existing
  }

  const $visible = computed([$activeSidebarTab, $panesVersion], (activeTab): boolean => {
    const pane = registry.getArea(PANES_AREA).find(c => c.id === paneId)

    if (!pane) {
      return false
    }

    return isSidebarPane(pane) ? activeTab === paneId : true
  })

  paneVisibleAtoms.set(paneId, $visible)

  return $visible
}

// ── Sidebar strip + body (rendered by ChatSidebar) ───────────────────────────

export function useSidebarPanes(): readonly Contribution[] {
  return useContributions(PANES_AREA).filter(isSidebarPane)
}

// Tab styling ported from upstream components/ui/pane-tab.tsx so the strip
// reads identically to the desktop zone header (9px uppercase labels, 2px
// theme-primary inset underline on the active tab, no strip bottom rule).
const TAB =
  'group/tab relative flex h-full min-w-0 max-w-48 shrink-0 cursor-default items-center border-transparent bg-(--tab-bg) text-[0.6875rem] font-medium not-first:border-l not-first:border-l-(--ui-stroke-quaternary)'

const TAB_ACTIVE =
  'text-foreground [--tab-bg:var(--pane-tab-active-bg,var(--ui-editor-surface-background))] shadow-[inset_0_-2px_0_var(--pane-tab-active-accent,var(--theme-primary))]'

const TAB_IDLE =
  'text-(--ui-text-tertiary) [--tab-bg:var(--pane-tab-strip-bg,var(--ui-sidebar-surface-background))] hover:shadow-[inset_0_0_0_100vmax_color-mix(in_srgb,#000_var(--ui-tab-hover-darken,6%),transparent)] hover:text-(--ui-text-secondary)'

function PaneTab({ active, label, onSelect }: { active: boolean; label: string; onSelect: () => void }) {
  return (
    <div
      aria-selected={active}
      className={cn(TAB, active ? TAB_ACTIVE : TAB_IDLE)}
      data-active={active || undefined}
      onClick={() => {
        if (!active) {
          triggerHaptic('selection')
          onSelect()
        }
      }}
      role="tab"
    >
      <span className="flex h-full min-w-0 max-w-full items-center overflow-hidden px-2 text-left outline-none">
        <span className="block min-w-0 truncate text-[9px] font-medium tracking-wide uppercase">{label}</span>
      </span>
    </div>
  )
}

/** The SESSIONS | <contributed…> strip. Rendered only when at least one
 *  contributed sidebar pane exists — a lone sessions pane keeps the upstream
 *  "lone pane hides its header" behavior. */
export function SidebarPaneStrip({ sessionsLabel }: { sessionsLabel: string }) {
  const panes = useSidebarPanes()
  const activeTab = useStore($activeSidebarTab)

  if (!panes.length) {
    return null
  }

  return (
    <div
      className="group/pane-header relative flex h-7 shrink-0 select-none bg-(--ui-sidebar-surface-background)"
      role="tablist"
    >
      <PaneTab
        active={activeTab === SESSIONS_TAB_ID}
        label={sessionsLabel}
        onSelect={() => setActiveSidebarTab(SESSIONS_TAB_ID)}
      />
      {panes.map(pane => (
        <PaneTab
          active={activeTab === pane.id}
          key={pane.id}
          label={pane.title ?? pane.id}
          onSelect={() => setActiveSidebarTab(pane.id)}
        />
      ))}
    </div>
  )
}

/** The active contributed sidebar pane, or null while SESSIONS is selected. */
export function useActiveSidebarPane(): Contribution | null {
  const panes = useSidebarPanes()
  const activeTab = useStore($activeSidebarTab)

  return panes.find(pane => pane.id === activeTab) ?? null
}

/** Body of a contributed sidebar pane (fills the sidebar below the strip). */
export function SidebarContributedPane({ pane }: { pane: Contribution }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ContribBoundary id={pane.id} variant="pane">
        {pane.render ? <ContribRender render={pane.render} /> : null}
      </ContribBoundary>
    </div>
  )
}

// ── Right-edge contributed panes (rendered by desktop-controller) ────────────

export function useWorkspaceRightPanes(): readonly Contribution[] {
  return useContributions(PANES_AREA).filter(isWorkspaceRightPane)
}

/** Declared width of a pane contribution ('250px' fallback — the upstream
 *  Routines pane's own declared width). */
export function contributedPaneWidth(pane: Contribution): string {
  return paneData(pane).width ?? '250px'
}

/** Body of a right-edge contributed pane: the upstream zone-header chip
 *  (e.g. CRONJOBS) above the contribution's rendered content. The `<Pane>`
 *  wrapper stays in desktop-controller's JSX — the pane shell resolves panes
 *  from its DIRECT children, so the wrapper cannot live behind a component
 *  boundary. */
export function ContributedRightPaneBody({ pane }: { pane: Contribution }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-(--ui-sidebar-surface-background)" data-contributed-pane={pane.id}>
      <div className="group/pane-header relative flex h-7 shrink-0 select-none bg-(--ui-sidebar-surface-background)" role="tablist">
        <PaneTab active label={pane.title ?? pane.id} onSelect={() => undefined} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ContribBoundary id={pane.id} variant="pane">
          {pane.render ? <ContribRender render={pane.render} /> : null}
        </ContribBoundary>
      </div>
    </div>
  )
}
