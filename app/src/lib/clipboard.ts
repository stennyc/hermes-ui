// Routes `navigator.clipboard.writeText` through the desktop bridge, since
// the renderer's clipboard API throws "Write permission denied" whenever the
// document loses focus (e.g. clicking a portaled Radix dropdown). The bridge
// path is unconditional.
//
// Only the WRITER is shimmed. The reader is deliberately left alone: in the
// web build the bridge's readClipboard is the same navigator.clipboard
// underneath, so a shim would only add recursion risk. The web bridge's own
// contextMenuEdit paste path owns its fallback (armPasteFallback: the focused
// target field receives a native Ctrl/Cmd+V; the bridge only shows a hint bar).

// Web/Capacitor-only. Electron installs a real preload bridge instead.

export function installClipboardShim() {
  const desktop = window.hermesDesktop

  // No bridge (Electron preload path) or no Clipboard API at all (plain
  // http://IP — non-secure context): nothing to shim.
  if (!desktop?.writeClipboard || !navigator.clipboard) {
    return
  }

  // Capture the platform writeText BEFORE we replace it: the shim must never
  // fall back through a method that points back at this bridge (recursion
  // to stack exhaustion).
  const native = navigator.clipboard.writeText?.bind(navigator.clipboard)

  const writeText = async (text: string) => {
    try {
      const ok = await desktop.writeClipboard(text)

      // The web bridge reports a failed system-clipboard write as `false`
      // instead of throwing (e.g. a non-secure context where every write
      // channel is dead). Propagate that as a rejection so callers awaiting
      // `navigator.clipboard.writeText` — and any fallback they chain off it,
      // such as the session menu's copy-ID fallback input — observe the
      // failure instead of a silent no-op.
      if (ok === false) {
        throw new Error('Clipboard write failed')
      }
    } catch (error) {
      try {
        await native?.(text)
      } catch {
        throw error instanceof Error ? error : new Error('Clipboard write failed')
      }
    }
  }

  try {
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: writeText, writable: true })
  } catch {
    // Browser refused override; primitives keep using the native API.
  }
}
