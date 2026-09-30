import { describe, expect, it } from 'vitest'

import {
  groupCatalogPlugins,
  PLUGIN_CATEGORIES,
  PLUGIN_CATEGORY_ORDER,
  sortCatalogPlugins
} from './catalog-browse'

describe('catalog-browse', () => {
  it('exposes the category order as the documented taxonomy keys', () => {
    expect(PLUGIN_CATEGORY_ORDER).toEqual(Object.keys(PLUGIN_CATEGORIES))
    // every key in the order is a real taxonomy entry
    for (const key of PLUGIN_CATEGORY_ORDER) {
      expect(PLUGIN_CATEGORIES[key].label).toBeTruthy()
    }
  })

  it('sorts newest/updated by the date field descending, falling back to name', () => {
    const entries = [
      { name: 'aaa', addedAt: '2024-01-01T00:00:00Z' },
      { name: 'zzz', addedAt: '2025-01-01T00:00:00Z' },
      { name: 'mmm' } // no addedAt -> treated as oldest (-Infinity)
    ]

    const newest = sortCatalogPlugins(entries, 'newest')
    expect(newest.map(e => e.name)).toEqual(['zzz', 'aaa', 'mmm'])

    // `updated` uses updatedAt, independent of addedAt
    const withUpdated = [
      { name: 'old', updatedAt: '2020-01-01T00:00:00Z' },
      { name: 'new', updatedAt: '2026-01-01T00:00:00Z' }
    ]
    expect(sortCatalogPlugins(withUpdated, 'updated').map(e => e.name)).toEqual(['new', 'old'])
  })

  it('preserves the published snapshot order for the `stars` sort', () => {
    const published = [{ name: 'top' }, { name: 'bottom' }]
    // no re-sort: identical references, same order
    expect(sortCatalogPlugins(published, 'stars')).toBe(published)
  })

  it('groups by category, buckets unknowns into `general`, and keeps taxonomy order', () => {
    const entries = [
      { name: 'a', category: 'memory' },
      { name: 'b', category: 'unknown-category' },
      { name: 'c', category: 'desktop' },
      { name: 'd', category: 'memory' }
    ]

    const grouped = groupCatalogPlugins(entries)
    const asMap = new Map(grouped)

    // only categories that actually have entries are returned, in taxonomy order
    expect(grouped.map(([key]) => key)).toEqual(['desktop', 'memory', 'general'])
    // unknown categories fall back to general
    const desktop = asMap.get('desktop')
    expect(desktop?.map(e => e.name)).toEqual(['c'])
    const memory = asMap.get('memory')
    expect(memory?.map(e => e.name)).toEqual(['a', 'd'])
    const general = asMap.get('general')
    expect(general?.map(e => e.name)).toEqual(['b'])
  })

  it('returns no groups when there are no entries', () => {
    expect(groupCatalogPlugins([])).toEqual([])
  })
})
