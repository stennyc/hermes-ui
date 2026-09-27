import { describe, expect, it } from 'vitest'

import { isLikelyProseCodeBlock } from './markdown-code'

describe('isLikelyProseCodeBlock', () => {
  it('detects prose that Streamdown mislabels as an unknown language', () => {
    expect(
      isLikelyProseCodeBlock(
        'heads',
        [
          '- Pure white (`#ffffff`), roughness 0.55, no emissive',
          '- Black wireframe edges at 35% opacity',
          '',
          'Want the bunny gone, or want me to keep riffing on it?'
        ].join('\n')
      )
    ).toBe(true)
  })

  it('keeps real code blocks', () => {
    expect(isLikelyProseCodeBlock('ts', 'const value = { bunny: true };\nreturn value')).toBe(false)
  })

  it('keeps an explicitly labelled text block even when its contents look like prose', () => {
    expect(
      isLikelyProseCodeBlock(
        'text',
        [
          'memory_midnight_pass.service',
          'memory_weekly_pass.service',
          'memory_doctor.service',
          'memory_session_backlog.service',
          'memory_vault_bridge_capture.service',
          'ops-monitor-memory-daily.service'
        ].join('\n')
      )
    ).toBe(false)
  })

  it('keeps an explicitly labelled diff block whose additions and removals look like markdown bullets', () => {
    expect(
      isLikelyProseCodeBlock(
        'diff',
        [
          'use-composer-actions.test.ts',
          '- два безымянных Blob',
          "+ три clipboard-like File(..., 'image.png')",
          '+ все три останутся в composer с разными ID',
          '',
          'use-composer-actions.ts',
          '- unique ID только когда suppliedName отсутствует',
          '+ unique ID для любого browser-local upload',
          '(имя остаётся image.png для display/upload, но не служит ключом upsert)'
        ].join('\n')
      )
    ).toBe(false)
  })

  it('still demotes a markdown-labelled prose wrap (the whole-reply fence artifact)', () => {
    expect(
      isLikelyProseCodeBlock(
        'markdown',
        ['Here is the summary of the work.', 'The refactor is complete now.', 'All tests pass on this branch.'].join(
          '\n'
        )
      )
    ).toBe(true)
  })

  it('still demotes an unlabelled multi-line prose fence', () => {
    expect(
      isLikelyProseCodeBlock(
        '',
        ['The task is complete.', 'The browser can now reload the view.', 'Please verify the result.'].join('\n')
      )
    ).toBe(true)
  })
})
