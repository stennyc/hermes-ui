/**
 * Cross-surface event: toggle-reveal a collapsed pane. Dispatched by the
 * keybinds (⌘B / ⌘G / titlebar toggles on narrow viewports) with the pane id
 * in `detail`; the layout tree's narrow overlays (tree/renderer.tsx) listen
 * and slide the pane over the grid.
 */
export const PANE_TOGGLE_REVEAL_EVENT = 'hermes:pane-toggle-reveal'

// ── Web-only stubs for deleted PaneShell API ──
// In upstream, PaneShell is part of the tree-based layout engine. The web
// build uses a simpler approach via contrib/panes.tsx. These stubs prevent
// import errors while the feature remains deferred.

import type { ReactNode } from 'react'

export type PaneId = string
export function PaneShell({ children, className, style }: { id?: PaneId; children?: ReactNode; className?: string; style?: React.CSSProperties }): ReactNode {
  return children ?? null
}
export { Pane, PaneMain } from './pane-shell'
