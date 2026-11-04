// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyTextWithSelection, createWebBridge } from './bridge'

describe('copyTextWithSelection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('copies through a temporary selected textarea', () => {
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    expect(copyTextWithSelection('HERMES-EXEC-COPY-9472')).toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea[data-hermes-clipboard-fallback]')).toBeNull()
  })

  it('reports an unavailable selection-copy command', () => {
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })

    expect(copyTextWithSelection('fallback')).toBe(false)
  })

  it('falls back cleanly when the selection-copy command throws', () => {
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => {
        throw new Error('copy command unavailable')
      }
    })

    expect(copyTextWithSelection('fallback')).toBe(false)
    expect(document.querySelector('textarea[data-hermes-clipboard-fallback]')).toBeNull()
  })

  it('restores the focused element and document selection it borrowed', () => {
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => true })

    const paragraph = document.createElement('p')
    paragraph.textContent = 'select me'
    const input = document.createElement('input')
    document.body.append(paragraph, input)
    input.focus()

    const selection = document.getSelection()
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    selection?.removeAllRanges()
    selection?.addRange(range)

    expect(copyTextWithSelection('borrowed')).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(document.getSelection()?.toString()).toBe('select me')
  })
})

describe('writeClipboard fallback', () => {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

  afterEach(() => {
    vi.restoreAllMocks()

    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    } else {
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  it('falls back to the pre-shim native writeText instead of re-entering itself', async () => {
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })

    const nativeWriteText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: nativeWriteText }
    })

    const bridge = createWebBridge()

    // installClipboardShim() rewrites navigator.clipboard.writeText to call the
    // bridge back. Before the captured-native fix, this made writeClipboard
    // recurse (writeClipboard -> shimmed writeText -> writeClipboard) whenever
    // execCommand reported failure.
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (text: string) => {
        await bridge.writeClipboard(text)
      }
    })

    await expect(bridge.writeClipboard('no-user-gesture')).resolves.toBe(true)
    expect(nativeWriteText).toHaveBeenCalledTimes(1)
    expect(nativeWriteText).toHaveBeenCalledWith('no-user-gesture')
  })

  it('reports a failed system-clipboard write as false, not a throw', async () => {
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })

    // No navigator.clipboard at all (plain http://IP — no secure context).
    delete (navigator as { clipboard?: unknown }).clipboard

    const bridge = createWebBridge()

    await expect(bridge.writeClipboard('lost')).resolves.toBe(false)
  })
})

describe('readClipboard', () => {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

  afterEach(() => {
    vi.restoreAllMocks()

    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    } else {
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  it('reads through the native Clipboard API', async () => {
    const nativeReadText = vi.fn(async () => 'from-system')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: nativeReadText } })

    const bridge = createWebBridge()

    await expect(bridge.readClipboard()).resolves.toBe('from-system')
    expect(nativeReadText).toHaveBeenCalledTimes(1)
  })

  it('reports empty when the Clipboard API is unavailable (non-secure context)', async () => {
    delete (navigator as { clipboard?: unknown }).clipboard

    const bridge = createWebBridge()

    await expect(bridge.readClipboard()).resolves.toBe('')
  })

  it('reports empty when the read is denied or throws', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: () => Promise.reject(new Error('denied')) }
    })

    const bridge = createWebBridge()

    await expect(bridge.readClipboard()).resolves.toBe('')
  })
})

describe('contextMenuEdit', () => {
  const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand')
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
    ;(document.activeElement as HTMLElement | null)?.blur?.()

    if (execCommandDescriptor) {
      Object.defineProperty(document, 'execCommand', execCommandDescriptor)
    } else {
      delete (document as { execCommand?: unknown }).execCommand
    }

    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    } else {
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  // Selection-copy (execCommand('copy')) works in jsdom tests when stubbed;
  // mock it so writes never need a real user gesture.
  const mockExecCopy = () => {
    const execCommand = vi.fn((command: string) => {
      if (command === 'copy' || command === 'insertText' || command === 'delete') {
        return true
      }

      return false
    })

    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    return execCommand
  }

  const focusedInput = (value: string) => {
    const input = document.createElement('input')

    document.body.append(input)
    input.focus()
    input.value = value

    return input
  }

  const focusedContentEditable = (text: string) => {
    const host = document.createElement('div')

    host.contentEditable = 'true'
    host.textContent = text
    document.body.append(host)
    host.focus()

    return host
  }

  it('selects all of a contenteditable via a scoped range', () => {
    const host = focusedContentEditable('whole field')

    const bridge = createWebBridge()

    bridge.contextMenuEdit?.('selectAll')

    const selection = window.getSelection()
    const range = selection?.getRangeAt(0) ?? null

    expect(selection?.toString()).toBe('whole field')
    // The range must stay inside the field, not the whole transcript: the
    // range's boundary nodes are the field's own contents.
    expect(range?.intersectsNode(host)).toBe(true)
    expect(range?.toString()).toBe('whole field')
  })

  it('selects all of a form field with select()', () => {
    const input = focusedInput('typed text')

    const bridge = createWebBridge()

    bridge.contextMenuEdit?.('selectAll')

    expect(input.selectionStart ?? 0).toBe(0)
    expect(input.selectionEnd ?? 0).toBe('typed text'.length)
  })

  it('copies a form field selection through the system-clipboard path', async () => {
    const execCommand = mockExecCopy()
    const input = focusedInput('hello world')

    input.setSelectionRange(0, 5)

    const bridge = createWebBridge()

    await bridge.contextMenuEdit?.('copy')

    // The selection text reaches execCommand('copy') via the textarea trick.
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('copies a contenteditable selection from the document selection', async () => {
    const execCommand = mockExecCopy()
    const host = focusedContentEditable('editable text')

    const selection = window.getSelection()
    const range = document.createRange()

    range.setStart(host.firstChild as Node, 0)
    range.setEnd(host.firstChild as Node, 3)
    selection?.removeAllRanges()
    selection?.addRange(range)

    const bridge = createWebBridge()

    await bridge.contextMenuEdit?.('copy')

    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('cuts a form field selection: clipboard written, value shortened', async () => {
    const execCommand = mockExecCopy()
    const input = focusedInput('hello world')

    input.setSelectionRange(0, 6)

    const bridge = createWebBridge()

    await bridge.contextMenuEdit?.('cut')

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(input.value).toBe('world')
    expect(input.selectionStart ?? 0).toBe(0)
    expect(input.selectionEnd ?? 0).toBe(0)
  })

  it('refuses to delete a cut when the clipboard write failed', async () => {
    // execCommand copy fails AND no Clipboard API → writeClipboardToSystem
    // returns false → the value must stay intact.
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
    delete (navigator as { clipboard?: unknown }).clipboard

    const input = focusedInput('keep me')

    input.setSelectionRange(0, 5)

    const bridge = createWebBridge()

    await bridge.contextMenuEdit?.('cut')

    expect(input.value).toBe('keep me')
  })

  it('pastes into a contenteditable through execCommand insertText', async () => {
    const execCommand = mockExecCopy()
    const readText = vi.fn(async () => 'pasted')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } })

    const host = focusedContentEditable('')

    const bridge = createWebBridge()

    await bridge.contextMenuEdit?.('paste')

    expect(readText).toHaveBeenCalledTimes(1)
    expect(execCommand).toHaveBeenCalledWith('insertText', false, 'pasted')
  })

  it('pastes into a form field via the prototype value setter + input event', async () => {
    const readText = vi.fn(async () => 'mid')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } })
    mockExecCopy()

    const input = focusedInput('ab')
    const inputEvents: string[] = []

    input.addEventListener('input', event => inputEvents.push((event as InputEvent).inputType ?? ''))
    input.setSelectionRange(1, 1)

    const bridge = createWebBridge()

    await bridge.contextMenuEdit?.('paste')

    expect(input.value).toBe('amidb')
    expect(input.selectionStart ?? 0).toBe(4)
    expect(inputEvents).toContain('insertText')
  })

  it('warns and does nothing when the clipboard read is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    delete (navigator as { clipboard?: unknown }).clipboard

    const host = focusedContentEditable('')

    const bridge = createWebBridge()

    await bridge.contextMenuEdit?.('paste')

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ctrl/Cmd+V'))
    expect(host.textContent).toBe('')
    warn.mockRestore()
  })

  it('leaves the field untouched when the clipboard is empty', async () => {
    const readText = vi.fn(async () => '')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } })

    const input = focusedInput('ab')

    const bridge = createWebBridge()

    await bridge.contextMenuEdit?.('paste')

    expect(input.value).toBe('ab')
  })
})
