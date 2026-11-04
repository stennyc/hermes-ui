// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { writeClipboardText } from './copy-button'

describe('writeClipboardText', () => {
  afterEach(() => {
    delete (window as { hermesDesktop?: unknown }).hermesDesktop
  })

  it('throws when the bridge reports the system clipboard was not written', async () => {
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
      writeClipboard: async () => false
    }

    await expect(writeClipboardText('lost')).rejects.toThrow('Clipboard write failed')
  })

  it('resolves when the bridge wrote the clipboard', async () => {
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
      writeClipboard: async () => true
    }

    await expect(writeClipboardText('ok')).resolves.toBeUndefined()
  })

  it('ignores empty text without touching the clipboard', async () => {
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
      writeClipboard: async () => true
    }

    await expect(writeClipboardText('')).resolves.toBeUndefined()
  })
})
