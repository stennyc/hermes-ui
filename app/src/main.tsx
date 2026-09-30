// Global fix: guard against `addRange()` on detached or cross-document ranges
// from third-party editors (e.g., @assistant-ui/react). These throw when a
// range's container has been removed from the DOM between renders.
//
// The catch below only swallows the JS-side DOMException — Chromium's console
// still PRINTS the native "The given range isn't in document." HierarchyRequest
// line even when the call is caught. So the real fix is PRE-VALIDATION: skip
// the native call entirely when the range's containers are not connected to
// this document. The one-shot __ADDRANGE_GUARD__ capture records WHO kept
// handing us stale ranges, so the residual source can be pinned down if the
// prints ever persist (dev-only; self-clears on first hit).
if (typeof Selection !== 'undefined' && Selection.prototype) {
  const _orig = Selection.prototype.addRange
  Selection.prototype.addRange = function (range: Range) {
    try {
      const start = range?.startContainer as (Node & { ownerDocument?: Document }) | null
      const end = range?.endContainer as (Node & { ownerDocument?: Document }) | null

      if (!start || !end || !start.isConnected || !end.isConnected || start.ownerDocument !== document || end.ownerDocument !== document) {
        // Stale / detached / cross-document range: skip the native call so no
        // HierarchyRequest is raised (and nothing printed). Capture the caller
        // once, for the record.
        const w = window as { __ADDRANGE_GUARD__?: { stacks: string[] } }
        if (!w.__ADDRANGE_GUARD__) {
          w.__ADDRANGE_GUARD__ = { stacks: [] }
        }

        if (w.__ADDRANGE_GUARD__.stacks.length < 5) {
          w.__ADDRANGE_GUARD__.stacks.push(String(new Error('addRange skipped').stack ?? '').slice(0, 2000))
        }

        return
      }

      _orig.call(this, range)
    } catch {
      // Range is detached from the document; ignore silently.
    }
  }
}

import './styles.css'
// Side-effect: installs the web bridge as `window.hermesDesktop`. MUST be the
// first import — several stores touch the bridge at module-evaluation time.
import './web-bridge/install'
// Side-effect: reports in-flight turns to the main process for the quit guard.
import './store/active-work'
// Side-effect: mirrors the machine's AC/battery state for poll demotion.
import './store/power'
// Side-effect: applies the persisted window translucency on load.
import './store/translucency'
// Side-effect: applies the persisted user-bubble transparency on load.
import './store/user-bubble-transparency'
// Dev-only render/state churn counters. MUST precede the `react-dom` import
// below: react-dom captures the devtools hook at module init, so bippy has to
// install during THIS import's evaluation or every commit goes unseen
// (verified — a late install reports renderers=0, commits=0). `vite.config.ts`
// aliases this specifier to a no-op module for non-dev builds, so neither the
// counters nor bippy reach a shipped renderer.
import '@/debug/dev-only'

import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'

import App from './app'
import { RootErrorBoundary } from './components/error-boundary'
import { HapticsProvider } from './components/haptics-provider'
import { RootTooltipProvider } from './components/ui/tooltip'
import { ProfileI18nProvider as I18nProvider } from './i18n/profile-provider'
import { installClipboardShim } from './lib/clipboard'
import { queryClient } from './lib/query-client'
import { installRendererAnimationPauseState } from './lib/renderer-loop-pause'
import { installSelectionCopyColorGuard } from './lib/selection-copy-colors'
import { ThemeProvider } from './themes/context'

installClipboardShim()
// Chromium serializes selection copies (Cmd+C, right-click Copy) with the
// theme's computed colors inlined; without this guard a dark-theme selection
// pastes as near-white text into light-background targets.
installSelectionCopyColorGuard()

// The perf probe ships in dev, and in a production build ONLY when explicitly
// opted in (VITE_PERF_PROBE=1) — this lets the perf harness measure a real,
// minified production renderer for representative absolute numbers. Normal
// `npm run build` leaves the flag unset, so the probe never reaches users.
if (import.meta.env.MODE !== 'production' || import.meta.env.VITE_PERF_PROBE === '1') {
  import('./app/chat/perf-probe')
}

const winParam = new URLSearchParams(window.location.search).get('win')

if (winParam === 'hud') {
  document.title = 'Hermes HUD'
}

// The `?win=` kinds whose Electron window is `transparent: true` and so paints
// nothing but its own surface over the user's desktop. `secondary` (a session
// window) and `browser` are ordinary opaque windows and are deliberately not
// in here. index.html's pre-paint script skips exactly this list — keep the
// two in step.
const TRANSPARENT_WINDOWS = new Set(['hud', 'overlay', 'quick', 'wake', 'intro'])

// Each transparent root used to force its host layers see-through when it
// MOUNTED. That is far too late: `styles.css` above paints the theme's opaque
// `--background` as soon as it lands, and the root behind it is a dynamic
// import — a couple of seconds of module fetches under the dev server. The gap
// rendered as a full-screen near-white rectangle. Claim it here instead, in the
// same task as the stylesheet, so no window ever paints a background it does
// not want.
if (winParam && TRANSPARENT_WINDOWS.has(winParam)) {
  const transparent = document.createElement('style')

  transparent.textContent = 'html,body,#root{background:transparent !important;}'
  document.head.appendChild(transparent)
}

if (winParam === 'overlay') {
  void import('./app/pet-overlay/overlay-root').then(({ mountPetOverlay }) => mountPetOverlay())
} else if (winParam === 'quick') {
  void import('./app/quick-entry/quick-entry-root').then(({ mountQuickEntry }) => mountQuickEntry())
} else if (winParam === 'wake') {
  void import('./app/wake-indicator/wake-indicator-root').then(({ mountWakeIndicator }) => mountWakeIndicator())
} else if (winParam === 'intro') {
  void import('./components/intro-reveal/intro-root').then(({ mountIntroReveal }) => mountIntroReveal())
} else {
  // CSS animations do not inherit Chromium's JS-loop pause policy. Mirror the
  // main window's visibility state to :root so decorative infinite
  // animations stop producing frames when nobody can see them.
  installRendererAnimationPauseState()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <RootErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <ThemeProvider>
              <HapticsProvider>
                {/* ONE tooltip provider for the whole app. Every `Tip` used to
                    carry its own, and with ~107 call sites those subtrees
                    dominated unrelated interactions (52,784 TooltipProvider
                    renders in a single sash drag). Radix's provider holds only
                    refs and stable callbacks, so hoisting is what it's for. */}
                <RootTooltipProvider>
                  {/* useTransitions={false}: react-router v7's HashRouter wraps every
                    route state update in React.startTransition() by default. In
                    React 19's concurrent renderer, transitions are non-urgent — React
                    can yield mid-render and resume later. When the app is under load
                    (streaming token deltas, gateway events, store updates), those
                    higher-priority updates keep interrupting the transition, starving
                    the route change commit. The session sidebar highlight + main pane
                    both freeze for seconds despite the main thread being free.
                    Disabling transitions makes navigate() commit at default priority. */}
                  <HashRouter useTransitions={false}>
                    <App />
                  </HashRouter>
                </RootTooltipProvider>
              </HapticsProvider>
            </ThemeProvider>
          </I18nProvider>
        </QueryClientProvider>
      </RootErrorBoundary>
    </StrictMode>
  )
}
