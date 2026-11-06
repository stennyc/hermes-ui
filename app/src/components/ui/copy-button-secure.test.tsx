// @vitest-environment jsdom
import * as React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyButton } from './copy-button'

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      common: {
        copy: 'Copy',
        copied: 'Copied',
        failed: 'Failed',
        copyFailed: 'Copy failed',
      },
    },
  }),
}))

vi.mock('@/lib/haptics', () => ({
  triggerHaptic: vi.fn(),
}))

function withSecureContext(secure: boolean) {
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: secure,
  })
}

describe('CopyButton non-secure-context manual copy', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete (window as { hermesDesktop?: unknown }).hermesDesktop
    document.body.replaceChildren()
  })

  it('routes through onCopyError (manual dialog) in a non-secure context even when the write reports success', async () => {
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
      writeClipboard: vi.fn(async () => true),
    }
    withSecureContext(false)

    const onCopyError = vi.fn()
    const onCopied = vi.fn()

    render(<CopyButton appearance="button" onCopyError={onCopyError} onCopied={onCopied} text="20261106_123456" />)

    const button = screen.getByRole('button', { name: 'Copy' })
    await act(() => {
      fireEvent.click(button)
    })

    // The bridge write still runs (genuine selected-text copies must keep
    // working) — the reported success is simply not trusted in a
    // non-secure context.
    expect((window as unknown as { hermesDesktop: { writeClipboard: ReturnType<typeof vi.fn> } }).hermesDesktop.writeClipboard).toHaveBeenCalledWith(
      '20261106_123456'
    )
    expect(onCopyError).toHaveBeenCalledTimes(1)
    expect(onCopied).not.toHaveBeenCalled()
  })

  it('does NOT route through onCopyError in a secure context when the write succeeds', async () => {
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
      writeClipboard: vi.fn(async () => true),
    }
    withSecureContext(true)

    const onCopyError = vi.fn()
    const onCopied = vi.fn()

    render(<CopyButton appearance="button" onCopyError={onCopyError} onCopied={onCopied} text="abc" />)

    const button = screen.getByRole('button', { name: 'Copy' })
    await act(() => {
      fireEvent.click(button)
    })

    expect(onCopyError).not.toHaveBeenCalled()
    expect(onCopied).toHaveBeenCalledTimes(1)
  })

  it('still reports a genuine write failure through onCopyError in a secure context', async () => {
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
      writeClipboard: vi.fn(async () => false),
    }
    withSecureContext(true)

    const onCopyError = vi.fn()
    const onCopied = vi.fn()

    render(<CopyButton appearance="button" onCopyError={onCopyError} onCopied={onCopied} text="abc" />)

    const button = screen.getByRole('button', { name: 'Copy' })
    await act(() => {
      fireEvent.click(button)
    })

    expect(onCopyError).toHaveBeenCalledTimes(1)
    expect(onCopied).not.toHaveBeenCalled()
  })
})
