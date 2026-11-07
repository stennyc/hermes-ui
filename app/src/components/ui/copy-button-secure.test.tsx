// @vitest-environment jsdom
import * as React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyButton } from './copy-button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './dropdown-menu'

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

// The menu-item appearance is the only one that intercepts Radix's
// on-select close behavior: the item's onSelect calls
// event.preventDefault() to keep the menu open while the "copied" flip
// is visible. That keep-open is only safe when the copy succeeds in
// place; in a non-secure context the copy always escalates to
// onCopyError (manual dialog), and a menu left open under a second
// modal layer is what froze the UI. The ground-truth observable of the
// fix: Radix's handleSelect calls rootContext.onClose() (which surfaces
// as onOpenChange(false)) ONLY when the item's onSelect did NOT
// preventDefault (react-menu handleSelect: itemSelectEvent
// defaultPrevented -> skip close; else onClose()). So:
//   - secure context: preventDefault called, onOpenChange(false) NOT
//     called, in-place copy succeeds (onCopied).
//   - non-secure context: no preventDefault, onOpenChange(false) called
//     (menu closes), escalation routes to onCopyError.
describe('CopyButton menu-item close behavior', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete (window as { hermesDesktop?: unknown }).hermesDesktop
    document.body.replaceChildren()
  })

  function selectCopyRow(): void {
    // The menu is controlled open, so the content is rendered. Select the
    // copy row the way Radix's real flow does: a pointer click on the
    // item (Radix's onClick fires handleSelect, which dispatches
    // menu.itemSelect carrying our onSelect callback).
    const row = screen.getByRole('menuitem')
    const click = new PointerEvent('click', { bubbles: true, cancelable: true })
    act(() => {
      row.dispatchEvent(click)
    })
    const itemSelectEvent = new CustomEvent('menu.itemSelect', { bubbles: true, cancelable: true })
    act(() => {
      row.dispatchEvent(itemSelectEvent)
    })
  }

  it('keeps the menu open on select in a secure context (in-place copy)', async () => {
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
      writeClipboard: vi.fn(async () => true),
    }
    withSecureContext(true)

    const onCopied = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <DropdownMenu onOpenChange={onOpenChange} open>
        <DropdownMenuTrigger>
          <button type="button">open</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <CopyButton appearance="menu-item" onCopied={onCopied} text="abc" />
        </DropdownMenuContent>
      </DropdownMenu>
    )

    selectCopyRow()

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // preventDefault was called, so Radix did NOT request a close.
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    // The in-place copy succeeded in a secure context.
    expect(onCopied).toHaveBeenCalledTimes(1)
  })

  it('lets the menu close naturally on select in a non-secure context', async () => {
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
      writeClipboard: vi.fn(async () => true),
    }
    withSecureContext(false)

    const onCopyError = vi.fn()
    const onCopied = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <DropdownMenu onOpenChange={onOpenChange} open>
        <DropdownMenuTrigger>
          <button type="button">open</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <CopyButton appearance="menu-item" onCopyError={onCopyError} onCopied={onCopied} text="abc" />
        </DropdownMenuContent>
      </DropdownMenu>
    )

    selectCopyRow()

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // No preventDefault, so Radix requested a close — no stacked modal layer.
    expect(onOpenChange).toHaveBeenCalledWith(false)
    // B: in a non-secure context a successful write is trusted, so the
    // in-place copy succeeds and no manual-copy dialog is forced.
    expect(onCopied).toHaveBeenCalledTimes(1)
    expect(onCopyError).not.toHaveBeenCalled()
  })

  it('in a non-secure context a failed write still opens the dialog and closes the menu', async () => {
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
      writeClipboard: vi.fn(async () => false),
    }
    withSecureContext(false)

    const onCopyError = vi.fn()
    const onCopied = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <DropdownMenu onOpenChange={onOpenChange} open>
        <DropdownMenuTrigger>
          <button type="button">open</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <CopyButton appearance="menu-item" onCopyError={onCopyError} onCopied={onCopied} text="abc" />
        </DropdownMenuContent>
      </DropdownMenu>
    )

    selectCopyRow()

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // The menu still closes naturally (no preventDefault), and the failed
    // write escalates to the caller's manual-copy affordance.
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onCopyError).toHaveBeenCalledTimes(1)
    expect(onCopied).not.toHaveBeenCalled()
  })
})

describe('CopyButton non-secure-context manual copy', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete (window as { hermesDesktop?: unknown }).hermesDesktop
    document.body.replaceChildren()
  })

  it('in a non-secure context a genuine write success is trusted (no forced dialog)', async () => {
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
    // working). In a non-secure context a reported success is now trusted
    // (the scratch-textarea execCommand path genuinely writes the system
    // clipboard), so no manual-copy dialog is forced.
    expect((window as unknown as { hermesDesktop: { writeClipboard: ReturnType<typeof vi.fn> } }).hermesDesktop.writeClipboard).toHaveBeenCalledWith(
      '20261106_123456'
    )
    expect(onCopyError).not.toHaveBeenCalled()
    expect(onCopied).toHaveBeenCalledTimes(1)
  })

  it('in a non-secure context a genuine write failure still routes through onCopyError (manual dialog)', async () => {
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
      writeClipboard: vi.fn(async () => false),
    }
    withSecureContext(false)

    const onCopyError = vi.fn()
    const onCopied = vi.fn()

    render(<CopyButton appearance="button" onCopyError={onCopyError} onCopied={onCopied} text="20261106_123456" />)

    const button = screen.getByRole('button', { name: 'Copy' })
    await act(() => {
      fireEvent.click(button)
    })

    // The bridge reports the system clipboard was NOT written -> the caller's
    // manual-copy affordance opens. This is the regression guard: B trusts the
    // result, not the security context, so a real failure still escalates.
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
