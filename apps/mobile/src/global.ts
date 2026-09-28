/**
 * Mobile-specific global declarations.
 *
 * The desktop's global.d.ts lives in apps/desktop/src/ and is NOT visible to
 * the mobile TypeScript compiler (its tsconfig includes only apps/mobile/src).
 * Re-declare the symbols mobile bridge code actually uses so the typechecker
 * doesn't complain about missing exports from '@/global'.
 */

import type { GatewayWsUrlResult } from '@hermes/shared'

export interface HermesNotification {
  /** Dedupe discriminator for session-less notifications (e.g. plugin id). */
  id?: string
  title?: string
  body?: string
  kind?: string
  sessionId?: string
  silent?: boolean
  action?: string
}

declare global {
  interface Window {
    hermesDesktop: {
      getConnection: (profile?: string | null) => Promise<{ profile: string; wsUrl: string }>
      notify: (payload: HermesNotification) => Promise<boolean>
      requestMicrophoneAccess: () => Promise<boolean>
    }
  }
}

export {}
