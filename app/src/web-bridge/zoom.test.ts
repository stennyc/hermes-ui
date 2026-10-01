// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { createWebBridge } from './bridge'

const ZOOM_KEY = 'hermes-web.zoom.v1'

/**
 * The web bridge owns the `zoom` surface in a browser/Capacitor WebView (no
 * Electron main process to drive `webContents.setZoom`). It scales the root
 * font size rather than CSS `zoom`, because the app shell is a fixed-viewport
 * `h-[100dvh]` + `overflow-hidden` layout where `zoom` would clip the bottom
 * composer. These tests pin the contract the Settings UI Scale row relies on:
 * preset clicks must land on the DOM + storage, `get` reports the live value,
 * `onChanged` fires, and out-of-range values clamp.
 */
describe('web bridge zoom surface', () => {
  afterEach(() => {
    localStorage.removeItem(ZOOM_KEY)
    document.documentElement.style.fontSize = ''
  })

  it('exposes a zoom surface instead of leaving it undefined', () => {
    const bridge = createWebBridge()

    expect(bridge.zoom).toBeDefined()
    expect(bridge.zoom?.factor?.()).toBeCloseTo(1)
  })

  it('scales the root font size (not CSS zoom) and persists it', async () => {
    const bridge = createWebBridge()

    bridge.zoom?.setPercent(125)

    // jsdom's default root font size is 16px, so 125% of the measured
    // stylesheet baseline lands on 20px.
    expect(document.documentElement.style.fontSize).toBe('20px')
    // CSS `zoom` must NOT be touched — that is what clipped the composer.
    expect(document.documentElement.style.zoom).toBe('')
    expect(localStorage.getItem(ZOOM_KEY)).toBe('125')
    await expect(bridge.zoom?.get()).resolves.toEqual({ level: expect.any(Number), percent: 125 })
  })

  it('returns to the stylesheet baseline at 100%', async () => {
    const bridge = createWebBridge()

    bridge.zoom?.setPercent(125)
    bridge.zoom?.setPercent(100)

    // Clearing the inline value hands the size back to the stylesheet rule.
    expect(document.documentElement.style.fontSize).toBe('')
    expect(localStorage.getItem(ZOOM_KEY)).toBe('100')
  })

  it('reports the persisted percent on get and matches it via factor', async () => {
    localStorage.setItem(ZOOM_KEY, '150')
    const bridge = createWebBridge()

    await expect(bridge.zoom?.get()).resolves.toMatchObject({ percent: 150 })
    expect(bridge.zoom?.factor?.()).toBeCloseTo(1.5)
  })

  it('fires onChanged exactly once per actual change and can unsubscribe', () => {
    const bridge = createWebBridge()
    const seen: number[] = []
    const off = bridge.zoom?.onChanged(payload => seen.push(payload.percent))

    bridge.zoom?.setPercent(110)
    bridge.zoom?.setPercent(110)
    bridge.zoom?.setPercent(90)

    off?.()
    bridge.zoom?.setPercent(125)

    expect(seen).toEqual([110, 90])
  })

  it('clamps out-of-range presets to the supported band', () => {
    const bridge = createWebBridge()

    bridge.zoom?.setPercent(30)
    bridge.zoom?.setPercent(500)

    expect(Number(localStorage.getItem(ZOOM_KEY))).toBe(200)
    bridge.zoom?.setPercent(30)

    expect(Number(localStorage.getItem(ZOOM_KEY))).toBe(50)
  })
})
