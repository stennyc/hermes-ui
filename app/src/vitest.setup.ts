import '@testing-library/jest-dom/vitest'
import { InertResizeObserver, stubDomStorage, stubMenuDomApis } from './test/jsdom'

// Browser-API floor for every jsdom suite: jsdom implements no layout, so
// Radix & co. call these unconditionally on mount and throw without stand-ins.
// Plain `??=` assignment (NOT vi.stubGlobal) on purpose: a test's
// unstubAllGlobals() can never drop the floor, and per-test vi.stubGlobal
// overrides still win where a test needs to assert on the stub itself.
// Guarded on Element (jsdom-only) so node-environment suites never see it.
if (typeof globalThis.ResizeObserver === 'undefined' && typeof Element !== 'undefined') {
  globalThis.ResizeObserver = InertResizeObserver
}

// jsdom has no IntersectionObserver; the thread list uses it for
// scroll-reveal. An inert class keeps mount paths that reference it from
// throwing without pretending to report intersections. Guarded on Element
// (jsdom-only) so node-environment suites never see the floor.
if (typeof globalThis.IntersectionObserver === 'undefined' && typeof Element !== 'undefined') {
  const InertIntersectionObserver = class {
    constructor() {}

    root: IntersectionObserverInit['root'] = null
    rootMargin = ''
    scrollMargin = ''
    thresholds: number[] = []

    observe() {}

    unobserve() {}

    disconnect() {}

    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  globalThis.IntersectionObserver = InertIntersectionObserver as unknown as typeof IntersectionObserver
}

if (typeof Element !== 'undefined') {
  stubMenuDomApis()
}

// Storage floor: vitest's jsdom leaves `window.localStorage`/`sessionStorage`
// UNDEFINED unless `--localstorage-file` is set, and the persistence layers
// read them unconditionally on boot. Install in-memory Storage on BOTH
// globalThis and window. Guarded on `window` so node-environment suites —
// which have no jsdom window and never need storage — are untouched.
if (typeof window !== 'undefined') {
  stubDomStorage()
}
