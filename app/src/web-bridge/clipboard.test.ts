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
})
