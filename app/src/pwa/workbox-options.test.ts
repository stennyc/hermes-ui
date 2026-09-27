import { describe, expect, it } from 'vitest'

import { PWA_WORKBOX_OPTIONS } from './workbox-options'

const navigationRoute = PWA_WORKBOX_OPTIONS.runtimeCaching[0]

function matches(mode: RequestMode, pathname: string): boolean {
  return navigationRoute.urlPattern({
    request: { mode } as Request,
    url: new URL(pathname, 'http://127.0.0.1:9119')
  })
}

describe('PWA Workbox cache policy', () => {
  it('never precaches the token-injected HTML shell', () => {
    expect(PWA_WORKBOX_OPTIONS.globPatterns.some(pattern => pattern.includes('html'))).toBe(false)
    expect(PWA_WORKBOX_OPTIONS.globIgnores).toContain('**/index.html')
    expect(PWA_WORKBOX_OPTIONS.navigateFallback).toBeNull()
  })

  it('serves navigations NetworkFirst so online launches get a fresh token and offline launches still boot', () => {
    expect(navigationRoute.handler).toBe('NetworkFirst')
    expect(matches('navigate', '/')).toBe(true)
    expect(matches('navigate', '/index.html')).toBe(true)
  })

  it('never intercepts the gateway or non-navigation requests', () => {
    expect(matches('navigate', '/api/ws')).toBe(false)
    expect(matches('navigate', '/api')).toBe(false)
    expect(matches('navigate', '/auth/callback')).toBe(false)
    expect(matches('navigate', '/login')).toBe(false)
    expect(matches('navigate', '/login?next=%2F')).toBe(false)
    expect(matches('cors', '/')).toBe(false)
  })
})
