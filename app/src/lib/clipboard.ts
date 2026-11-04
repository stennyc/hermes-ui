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

export function installClipboardShim() {
  const desktop = window.hermesDesktop

  if (!desktop?.writeClipboard || !navigator.clipboard) {
    return
  }

  const native = navigator.clipboard.writeText?.bind(navigator.clipboard)

  const writeText = async (text: string) => {
    try {
      await desktop.writeClipboard(text)
    } catch {
      await native?.(text)
    }
  }

  try {
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: writeText, writable: true })
  } catch {
    // Browser refused override; primitives keep using the native API.
  }
}
