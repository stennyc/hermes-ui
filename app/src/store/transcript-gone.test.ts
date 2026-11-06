import { beforeEach, describe, expect, it } from 'vitest'

import {
  __resetTranscriptGoneForTests,
  isTranscriptGone,
  markTranscriptGone,
  recordTranscriptAlive,
  resetTranscriptGone
} from './transcript-gone'

describe('P12: transcript gone set', () => {
  beforeEach(() => {
    __resetTranscriptGoneForTests()
  })

  it('records a confirmed 404 and the re-reads skip the id', () => {
    expect(isTranscriptGone('s1')).toBe(false)

    markTranscriptGone('s1')

    expect(isTranscriptGone('s1')).toBe(true)
    expect(isTranscriptGone('s2')).toBe(false)
  })

  it('trims ids so the set is stable across lookups', () => {
    markTranscriptGone('  s1  ')

    expect(isTranscriptGone('s1')).toBe(true)
  })

  it('ignores blank ids', () => {
    markTranscriptGone('')
    markTranscriptGone('   ')

    expect(isTranscriptGone('')).toBe(false)
  })

  it('retires a verdict when a list page still lists the id', () => {
    markTranscriptGone('s1')
    markTranscriptGone('s2')

    recordTranscriptAlive(['s1', 's3'])

    expect(isTranscriptGone('s1')).toBe(false)
    expect(isTranscriptGone('s2')).toBe(true)
    expect(isTranscriptGone('s3')).toBe(false)
  })

  it('resetTranscriptGone drops every verdict (gateway switch)', () => {
    markTranscriptGone('s1')
    markTranscriptGone('s2')

    resetTranscriptGone()

    expect(isTranscriptGone('s1')).toBe(false)
    expect(isTranscriptGone('s2')).toBe(false)
  })

  it('an id marked gone can be re-marked and retired repeatedly', () => {
    markTranscriptGone('s1')
    recordTranscriptAlive(['s1'])

    markTranscriptGone('s1')
    expect(isTranscriptGone('s1')).toBe(true)

    recordTranscriptAlive(['s1'])
    expect(isTranscriptGone('s1')).toBe(false)
  })
})
