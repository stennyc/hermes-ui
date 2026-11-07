import * as React from 'react'

import { Button } from '@/components/ui/button'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { Check, Copy, X } from '@/lib/icons'
import { cn } from '@/lib/utils'

type CopyPayload = string | (() => Promise<string> | string)
type CopyButtonAppearance = 'button' | 'icon' | 'inline' | 'menu-item' | 'context-menu-item' | 'tool-row'
type CopyStatus = 'copied' | 'error' | 'idle'
const COPIED_RESET_MS = 1_500

export async function writeClipboardText(text: string) {
  if (!text) {
    return
  }

  if (window.hermesDesktop?.writeClipboard) {
    const ok = await window.hermesDesktop.writeClipboard(text)

    // The web bridge reports a failed system-clipboard write as `false`
    // instead of throwing — surface it so the button doesn't claim success
    // when the OS clipboard never changed.
    if (ok === false) {
      throw new Error('Clipboard write failed')
    }

    return
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)

    return
  }

  throw new Error('Clipboard API is unavailable')
}

export interface CopyButtonProps {
  appearance?: CopyButtonAppearance
  buttonSize?: React.ComponentProps<typeof Button>['size']
  buttonVariant?: React.ComponentProps<typeof Button>['variant']
  children?: React.ReactNode
  className?: string
  disabled?: boolean
  /**
   * When true, copy failure is reported through `onCopyError` without a
   * status flip: a button that claims "copied" while the system clipboard
   * never changed is a lie. The success flip still runs (a successful copy
   * is always reported), and callers that surface their own failure affordance
   * (a toast, a fallback input) opt in to this.
   */
  silentError?: boolean
  errorMessage?: string
  haptic?: boolean
  iconClassName?: string
  label?: string
  onCopied?: () => void
  onCopyError?: (error: unknown) => void
  preventDefault?: boolean
  showLabel?: boolean
  side?: React.ComponentProps<typeof Tip>['side']
  stopPropagation?: boolean
  text: CopyPayload
  title?: string
}

export function CopyButton({
  appearance = 'button',
  buttonSize,
  buttonVariant = 'ghost',
  children,
  className,
  disabled = false,
  errorMessage,
  haptic = true,
  iconClassName,
  label,
  onCopied,
  onCopyError,
  preventDefault = false,
  silentError = false,
  showLabel,
  side,
  stopPropagation = false,
  text,
  title
}: CopyButtonProps) {
  const { t } = useI18n()
  const resolvedErrorMessage = errorMessage ?? t.common.copyFailed
  const resolvedLabel = label ?? t.common.copy
  const [status, setStatus] = React.useState<CopyStatus>('idle')
  const resetRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    return () => {
      if (resetRef.current !== null) {
        window.clearTimeout(resetRef.current)
      }
    }
  }, [])

  const copy = React.useCallback(
    async (event?: Event | React.MouseEvent<HTMLElement>) => {
      if (preventDefault) {
        event?.preventDefault()
      }

      if (stopPropagation) {
        event?.stopPropagation()
      }

      try {
        const value = typeof text === 'function' ? await text() : text

        if (!value) {
          return
        }

        // In a non-secure context (plain http://IP) the scratch-textarea
        // execCommand path can genuinely write the system clipboard, so a
        // successful write is trusted here — no forced manual-copy dialog.
        // If it can't write (bridge reports false, or no clipboard channel
        // at all), writeClipboardText throws and the catch below routes to
        // onCopyError, which is when the caller's manual-copy affordance
        // opens. Success and failure are distinguished by the real result,
        // not by the security context.
        await writeClipboardText(value)

        if (haptic) {
          triggerHaptic('selection')
        }

        if (resetRef.current !== null) {
          window.clearTimeout(resetRef.current)
        }

        setStatus('copied')
        resetRef.current = window.setTimeout(() => {
          setStatus('idle')
          resetRef.current = null
        }, COPIED_RESET_MS)
        onCopied?.()
      } catch (error) {
        onCopyError?.(error)

        if (silentError) {
          // The caller owns the failure affordance; keep the button's own
          // label (don't flip to a red ✗ it would be repeating).
          return
        }

        if (resetRef.current !== null) {
          window.clearTimeout(resetRef.current)
        }

        setStatus('error')
        resetRef.current = window.setTimeout(() => {
          setStatus('idle')
          resetRef.current = null
        }, COPIED_RESET_MS)
      }
    },
    [haptic, onCopied, onCopyError, preventDefault, silentError, stopPropagation, text]
  )

  const Icon = status === 'copied' ? Check : status === 'error' ? X : Copy
  const icon = <Icon className={cn('size-3.5', iconClassName)} />

  const visibleChildren =
    (showLabel ?? (appearance !== 'icon' && appearance !== 'tool-row'))
      ? status === 'copied'
        ? t.common.copied
        : status === 'error'
          ? t.common.failed
          : (children ?? resolvedLabel)
      : null

  const content = (
    <>
      {icon}
      {visibleChildren}
    </>
  )

  const feedbackLabel =
    status === 'copied' ? t.common.copied : status === 'error' ? resolvedErrorMessage : (title ?? resolvedLabel)

  const ariaLabel = status === 'idle' ? resolvedLabel : feedbackLabel

  if (appearance === 'menu-item' || appearance === 'context-menu-item') {
    const MenuItem = appearance === 'menu-item' ? DropdownMenuItem : ContextMenuItem

    return (
      <MenuItem
        className={className}
        disabled={disabled}
        onSelect={event => {
          // In a non-secure context (plain http://IP) copy always routes
          // through onCopyError into a manual-copy dialog — keeping this menu
          // open underneath it stacks two Radix modal layers (the menu's
          // focus trap, inert overlay and body pointer-events:none survive
          // after the dialog closes and the whole UI is left unclickable).
          // Close the menu naturally there; in a secure context the dialog
          // never opens, so keep the item open for the "copied" flip.
          if (typeof window === 'undefined' || window.isSecureContext) {
            event.preventDefault()
          }
          void copy(event)
        }}
      >
        {content}
      </MenuItem>
    )
  }

  if (appearance === 'inline') {
    return (
      <Tip label={feedbackLabel} side={side}>
        <button
          aria-label={ariaLabel}
          className={cn(
            'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[0.75rem] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40',
            className
          )}
          disabled={disabled}
          onClick={event => void copy(event)}
          type="button"
        >
          {content}
        </button>
      </Tip>
    )
  }

  if (appearance === 'tool-row') {
    return (
      <Tip label={feedbackLabel}>
        <button
          aria-label={ariaLabel}
          className={cn(
            'grid size-6 place-items-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity hover:bg-accent/55 hover:text-foreground focus-visible:opacity-100 group-hover/tool-row:opacity-100 disabled:opacity-40',
            className
          )}
          disabled={disabled}
          onClick={event => void copy(event)}
          type="button"
        >
          {icon}
        </button>
      </Tip>
    )
  }

  const button = (
    <Button
      aria-label={ariaLabel}
      className={className}
      disabled={disabled}
      onClick={event => void copy(event)}
      size={buttonSize ?? (appearance === 'icon' ? 'icon' : 'default')}
      type="button"
      variant={buttonVariant}
    >
      {content}
    </Button>
  )

  // Only icon-only buttons need a tooltip; the text variant already shows its label.
  return appearance === 'icon' ? (
    <Tip label={feedbackLabel} side={side ?? 'bottom'}>
      {button}
    </Tip>
  ) : (
    button
  )
}
