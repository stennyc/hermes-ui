// Rasterise an SVG string to PNG and copy it to the clipboard. Self-contained
// SVGs only (inline styles): Pele output with its palette written onto the
// root qualifies. Falls back to copying the SVG markup as text where image
// clipboard writes aren't permitted.

import { writeClipboardText } from '@/lib/clipboard'

// A percentage width or height is not an intrinsic size (parseFloat("100%")
// would make a 100px PNG); fall back to the viewBox for those.
function isPercentLength(raw: string | null): boolean {
  return Boolean(raw?.trim().endsWith('%'))
}

function viewBoxSize(el: Element): { height: number; width: number } | null {
  const [, , vbW, vbH] = (el.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number)

  return vbW > 0 && vbH > 0 ? { height: vbH, width: vbW } : null
}

function parseSvgLength(raw: string | null): number | null {
  if (!raw || isPercentLength(raw)) {
    return null
  }

  const value = Number.parseFloat(raw)

  return Number.isFinite(value) ? value : null
}

export function xmlWellFormedSvg(svg: string): string {
  const el = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg')

  if (!el) {
    return svg
  }

  // The HTML parser keeps a label's `xmlns="…/xhtml"` as a plain attribute. The
  // serializer declares that namespace itself, and a spec-conformant one (jsdom)
  // also writes the plain attribute — a duplicate `xmlns`, malformed again.
  for (const node of el.querySelectorAll('[xmlns]')) {
    node.removeAttribute('xmlns')
  }

  return new XMLSerializer().serializeToString(el)
}


export function normalizeSvgSize(svg: string): string {
  const el = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement

  if (el.tagName !== 'svg') {
    return svg
  }

  const width = el.getAttribute('width')
  const height = el.getAttribute('height')
  const widthPct = isPercentLength(width)
  const heightPct = isPercentLength(height)

  if (!widthPct && !heightPct) {
    return svg
  }

  // Mermaid pins the intrinsic width with an inline max-width in pixels. An
  // inline style beats the container's width caps (max-w-full and friends),
  // so a wide diagram renders at full intrinsic width in the inline preview
  // instead of shrinking to the pane. Relative values stay untouched.
  const maxWidth = el.style.getPropertyValue('max-width')

  if (maxWidth && !isPercentLength(maxWidth) && !maxWidth.trim().endsWith('vw')) {
    el.style.setProperty('max-width', '100%')
  }

  const box = viewBoxSize(el)

  if (!box) {
    return svg
  }

  if (widthPct) {
    el.setAttribute('width', String(box.width))
  }

  // Mermaid usually omits height. Fill it from the viewBox so the overlay has
  // both intrinsic dimensions; don't overwrite an explicit pixel height.
  if (heightPct || (widthPct && !height)) {
    el.setAttribute('height', String(box.height))
  }

  return new XMLSerializer().serializeToString(el)
}


export function svgSize(svg: string): { height: number; width: number } {
  const el = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  const width = parseSvgLength(el.getAttribute('width'))
  const height = parseSvgLength(el.getAttribute('height'))

  if (width && height) {
    return { height, width }
  }

  return viewBoxSize(el) ?? { height: 600, width: 800 }
}

export function svgToPngBlob(svg: string, scale = 2): Promise<Blob> {
  const { height, width } = svgSize(svg)

  return new Promise((resolve, reject) => {
    const image = new Image()

    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))

      const ctx = canvas.getContext('2d')

      if (!ctx) {
        reject(new Error('no 2d context'))

        return
      }

      ctx.scale(scale, scale)
      ctx.drawImage(image, 0, 0, width, height)
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png')
    }

    image.onerror = () => reject(new Error('svg load failed'))
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })
}

export async function copySvgAsPng(svg: string): Promise<void> {
  // An insecure origin has no image clipboard: copy the markup while the click still counts.
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    return writeClipboardText(svg)
  }

  try {
    const blob = await svgToPngBlob(svg)

    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  } catch {
    await writeClipboardText(svg)
  }
}
