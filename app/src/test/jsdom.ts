// jsdom implements no layout and no animation, so component libraries that
// call those APIs unconditionally throw on mount. These install inert
// stand-ins: enough for the component to render, never enough to assert on. A
// test that needs one of them to actually report should install its own.

import { vi } from 'vitest'

export class InertResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

/** A ResizeObserver that accepts observers and never calls them back. */
export function stubResizeObserver() {
  vi.stubGlobal('ResizeObserver', InertResizeObserver)
}

/** The pointer-capture and scroll calls Radix and cmdk make while opening a
 *  popover, menu, or combobox — and again on the item they focus. */
export function stubMenuDomApis() {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => undefined
  Element.prototype.releasePointerCapture ??= () => undefined
  Element.prototype.scrollIntoView ??= () => undefined
}

/** Minimal in-memory Storage: setItem/getItem/removeItem/clear/key/length.
 *  Vitest's jsdom environment ships `window.localStorage` /
 *  `sessionStorage` UNDEFINED unless `--localstorage-file` is passed, and the
 *  persistence layers read them unconditionally on boot. In-memory on
 *  purpose — this is a floor so the code paths execute, not a real storage;
 *  a test that asserts on persistence writes its own stub (vi.stubGlobal
 *  still wins over the floor, and unstubAllGlobals restores TO the floor,
 *  which is what keeps later tests alive). */
export class MemoryStorage implements Storage {
  // Data is stored as the instance's OWN enumerable properties (not in a
  // side Map), exactly like jsdom's native Storage: this is what lets
  // `Object.keys(localStorage)` enumerate the stored keys — the real
  // behaviour that suites like query-persist assert against. Methods and
  // `length` live on the prototype, so they stay out of `Object.keys`.

  get length() {
    return Object.keys(this).length
  }

  clear() {
    for (const key of Object.keys(this)) {
      delete (this as unknown as Record<string, string>)[key]
    }
  }

  getItem(key: string) {
    const value = (this as unknown as Record<string, string>)[key]

    return value === undefined ? null : value
  }

  key(index: number) {
    return Object.keys(this)[index] ?? null
  }

  removeItem(key: string) {
    delete (this as unknown as Record<string, string>)[key]
  }

  setItem(key: string, value: string) {
    ;(this as unknown as Record<string, string>)[key] = String(value)
  }
}

/** Install the storage floor on globalThis AND window: vitest's jsdom is a
 *  per-file window, but tests that stub-replace `window` detach it from the
 *  global the floor was installed on. Skips targets that already have
 *  working storage (real jsdom-with-file, or a test's own stub). */
export function stubDomStorage() {
  const targets: unknown[] = [globalThis, (globalThis as { window?: unknown }).window]

  for (const target of targets) {
    const record = target as { localStorage?: Storage; sessionStorage?: Storage } | null

    if (!record) {
      continue
    }

    if (!record.localStorage) {
      record.localStorage = new MemoryStorage()
    }

    if (!record.sessionStorage) {
      record.sessionStorage = new MemoryStorage()
    }
  }
}
