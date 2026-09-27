import { describe, expect, it } from 'vitest'

import { preprocessMarkdown } from '@/lib/markdown-preprocess'
import { tailBoundedRemend } from '@/lib/remend-tail'

describe('preprocessMarkdown', () => {
  it('strips inline accidental triple-backtick starts', () => {
    const input = [
      'Working as intended.',
      "Here's your scene: ``` http://localhost:8812/",
      '',
      '- **Multicolored cube**',
      '- **Rotates**'
    ].join('\n')

    const output = preprocessMarkdown(input)

    expect(output).not.toContain('```')
    expect(output).toContain("Here's your scene:")
    expect(output).not.toContain('http://localhost:8812/')
    expect(output).toContain('- **Multicolored cube**')
  })

  it('demotes invalid fenced prose blocks with closers', () => {
    const fence = '```'

    const input = [
      `${fence} http://localhost:8812/`,
      '- **Scroll wheel** - zoom',
      '- **Right-drag/pan** - disabled',
      fence
    ].join('\n')

    const output = preprocessMarkdown(input)

    expect(output).not.toContain('```')
    expect(output).not.toContain('http://localhost:8812/')
    expect(output).toContain('- **Scroll wheel** - zoom')
  })

  it('drops fences around a preview-only URL block', () => {
    const fence = '```'
    const input = ['Server is back.', '', fence, 'http://localhost:8812/', fence].join('\n')

    const output = preprocessMarkdown(input)

    expect(output).toContain('Server is back.')
    expect(output).not.toContain('```')
    expect(output).not.toContain('http://localhost:8812/')
  })

  it('demotes prose sentence masquerading as fence info', () => {
    const input = ['```Heads up - a bunny got added', '- Pure white (`#ffffff`)', '- Ambient dropped to 0.18'].join(
      '\n'
    )

    const output = preprocessMarkdown(input)

    expect(output).not.toContain('```heads')
    expect(output).toContain('Heads up - a bunny got added')
    expect(output).toContain('- Pure white (`#ffffff`)')
  })

  it('keeps valid code fences intact', () => {
    const fence = '```'
    const input = [`${fence}ts`, 'const value = 1;', fence].join('\n')

    const output = preprocessMarkdown(input)

    expect(output).toContain('```ts')
    expect(output).toContain('const value = 1;')
  })

  it('keeps a closed text fence whose lines do not look like source code', () => {
    const input = [
      '```text',
      'memory_midnight_pass.service',
      'memory_weekly_pass.service',
      'memory_doctor.service',
      'memory_session_backlog.service',
      'memory_vault_bridge_capture.service',
      'ops-monitor-memory-daily.service',
      '```'
    ].join('\n')

    expect(preprocessMarkdown(input)).toBe(input)
  })

  it('keeps a named text fence while its closing fence is still streaming', () => {
    const body = [
      '```text',
      'memory_midnight_pass.service',
      'memory_weekly_pass.service',
      'memory_doctor.service',
      'memory_session_backlog.service',
      'memory_vault_bridge_capture.service',
      'ops-monitor-memory-daily.service'
    ].join('\n')

    expect(preprocessMarkdown(body)).toBe(body)
    expect(preprocessMarkdown(`${body}\n\`\`\``)).toBe(`${body}\n\`\`\``)
    expect(tailBoundedRemend(preprocessMarkdown(body)).startsWith('```text')).toBe(true)
  })

  it('keeps a named text fence that starts mid-message while streaming', () => {
    const input = [
      'Here are the services:',
      '',
      '```text',
      'memory_midnight_pass.service',
      'memory_weekly_pass.service'
    ].join('\n')

    const output = preprocessMarkdown(input)

    expect(output).toContain('```text')
    expect(output).toContain('Here are the services:')
    expect(output).toContain('memory_weekly_pass.service')
  })

  it('does not duplicate content when a dangling named fence sits inside a tilde fence', () => {
    const input = [
      '~~~',
      '```text',
      'line one prose here.',
      'line two prose here.',
      'line three prose here.',
      '~~~',
      'trailing prose'
    ].join('\n')

    const output = preprocessMarkdown(input)

    expect(output.split('line one prose here.').length - 1).toBe(1)
    expect(output.split('line three prose here.').length - 1).toBe(1)
    expect(output).toContain('trailing prose')
  })

  it('preserves the info-line text of a closed prose fence instead of truncating it to a language tag', () => {
    const input = [
      '```Heads up - a bunny got added',
      '- Pure white (`#ffffff`)',
      '- Ambient dropped to 0.18',
      '```'
    ].join('\n')

    const output = preprocessMarkdown(input)

    expect(output).toContain('Heads up - a bunny got added')
    expect(output).not.toContain('```heads')
    expect(output).toContain('- Pure white (`#ffffff`)')
  })

  it('demotes a closed unlabelled prose fence so streaming and closed states match', () => {
    const input = ['```', '- Pure white (`#ffffff`)', '- Ambient dropped to 0.18', '```'].join('\n')

    const output = preprocessMarkdown(input)

    expect(output).not.toContain('```')
    expect(output).toContain('- Pure white (`#ffffff`)')
  })

  it('demotes a markdown-wrapped prose reply without leaving a stray language token', () => {
    const input = [
      '```markdown',
      'Here is the summary of the work.',
      'The refactor is complete now.',
      'All tests pass on this branch.',
      '```'
    ].join('\n')

    const output = preprocessMarkdown(input)

    expect(output).not.toContain('```')
    expect(output).not.toMatch(/^markdown$/m)
    expect(output).toContain('Here is the summary of the work.')
  })

  it('keeps dangling real code fences during streaming', () => {
    const input = ['```ts', 'const value = 1;'].join('\n')
    const output = preprocessMarkdown(input)

    expect(output.startsWith('```ts')).toBe(true)
    expect(output).toContain('const value = 1;')
  })

  it('demotes dangling prose fences', () => {
    const input = ['```', '- Pure white (`#ffffff`)', '- Ambient dropped to 0.18'].join('\n')
    const output = preprocessMarkdown(input)

    expect(output).not.toContain('```')
    expect(output).toContain('- Pure white (`#ffffff`)')
  })

  it('autolinks raw urls in prose', () => {
    const output = preprocessMarkdown(
      'Book here:\nhttps://www.getyourguide.com/culebra-island-l145468/from-fajardo-tour-t19894/'
    )

    expect(output).toContain('<https://www.getyourguide.com/culebra-island-l145468/from-fajardo-tour-t19894/>')
  })

  it('strips orphan numeric citation markers outside code spans', () => {
    const output = preprocessMarkdown('This is the source[0], but keep `items[0]` untouched.')

    expect(output).toContain('source,')
    expect(output).not.toContain('source[0]')
    expect(output).toContain('`items[0]`')
  })

  it('demotes title/url blocks wrapped in malformed inline fences', () => {
    const input = [
      '**🚢 TOMORROW (Fajardo, crystal clear cays, pickup avail):**',
      '',
      'Icacos Full-Day Catamaran — 6hr, $140, small group, pickup```',
      'https://www.getyourguide.com/fajardo-l882/from-fajardo-icacos-island-full-day-catamaran-trip-t19891/',
      '```Sail Getaway Luxury Cat (Cordillera Cays, water slide, unlimited rum) — 6hr, $195```',
      'https://www.getyourguide.com/fajardo-l882/icacos-all-inclusive-sailing-catamaran-beach-and-snorkel-t466138/'
    ].join('\n')

    const output = preprocessMarkdown(input)

    expect(output).not.toContain('```')
    expect(output).toContain('Sail Getaway Luxury Cat')
    expect(output).toContain(
      '<https://www.getyourguide.com/fajardo-l882/from-fajardo-icacos-island-full-day-catamaran-trip-t19891/>'
    )
    expect(output).toContain(
      '<https://www.getyourguide.com/fajardo-l882/icacos-all-inclusive-sailing-catamaran-beach-and-snorkel-t466138/>'
    )
  })

  it('autolinks urls glued to prices and removes orphan fence tails', () => {
    const input = [
      '**🐢 TODAY (from San Juan, no driving):**',
      '',
      'Sea Turtles & Manatees Snorkel + Free Rum — 1.5hr,',
      '~$56```https://www.getyourguide.com/san-juan-puerto-rico-l355/san-juan-snorkel-sea-turtles-manatees-free-video-rum-t879147/ Old San Juan Sunset Cruise w/ Drinks + Hotel Pickup — 1.5hr, ~$99 (drinks, no snorkel)```',
      'https://www.getyourguide.com/en-gb/san-juan-puerto-rico-l355/san-juan-old-san-juan-sunset-cruise-with-drinks-transfer-t405191/'
    ].join('\n')

    const output = preprocessMarkdown(input)

    expect(output).not.toContain('```')
    // Currency dollar amounts get escaped to `\$` in the preprocessor
    // so they don't get parsed as math delimiters by remark-math (we
    // enable singleDollarTextMath, which would otherwise greedy-match
    // `$56...$99` as one big inline math span). The escape is invisible
    // to the user — `\$` renders as a literal `$` in the final output.
    expect(output).toContain(
      '~\\$56<https://www.getyourguide.com/san-juan-puerto-rico-l355/san-juan-snorkel-sea-turtles-manatees-free-video-rum-t879147/> Old San Juan Sunset Cruise'
    )
    expect(output).toContain(
      '<https://www.getyourguide.com/en-gb/san-juan-puerto-rico-l355/san-juan-old-san-juan-sunset-cruise-with-drinks-transfer-t405191/>'
    )
  })

  it('demotes url-only fenced blocks to clickable markdown links', () => {
    const input = [
      'Sea Turtles & Manatees Snorkel + Free Rum — 1.5hr, ~$56',
      '```',
      'https://www.getyourguide.com/san-juan-puerto-rico-l355/san-juan-snorkel-sea-turtles-manatees-free-video-rum-t879147/',
      '```',
      '',
      'Old San Juan Sunset Cruise w/ Drinks + Hotel Pickup — 1.5hr, ~$99',
      '```',
      'https://www.getyourguide.com/en-gb/san-juan-puerto-rico-l355/san-juan-old-san-juan-sunset-cruise-with-drinks-transfer-t405191/',
      '```'
    ].join('\n')

    const output = preprocessMarkdown(input)

    expect(output).not.toContain('```')
    expect(output).toContain(
      '<https://www.getyourguide.com/san-juan-puerto-rico-l355/san-juan-snorkel-sea-turtles-manatees-free-video-rum-t879147/>'
    )
    expect(output).toContain(
      '<https://www.getyourguide.com/en-gb/san-juan-puerto-rico-l355/san-juan-old-san-juan-sunset-cruise-with-drinks-transfer-t405191/>'
    )
  })

  it('does not swallow trailing emphasis asterisks into an autolinked url', () => {
    const input = '**PR opened: https://github.com/NousResearch/hermes-agent/pull/12345**'

    const output = preprocessMarkdown(input)

    // The URL is autolinked WITHOUT the trailing `**` glued into the href,
    // and the bold emphasis run stays intact so it renders as bold + a link.
    expect(output).toContain('<https://github.com/NousResearch/hermes-agent/pull/12345>')
    expect(output).not.toContain('pull/12345**>')
    expect(output).not.toContain('12345*')
  })

  it('stops an autolinked url at mid-string bold markers', () => {
    const input = 'See https://github.com/foo/bar**bold** for details.'

    const output = preprocessMarkdown(input)

    expect(output).toContain('<https://github.com/foo/bar>')
    expect(output).toContain('**bold**')
  })

  it('keeps underscores and tildes inside autolinked url paths', () => {
    const input = 'Docs at https://example.com/a_b/c~d/page'

    const output = preprocessMarkdown(input)

    expect(output).toContain('<https://example.com/a_b/c~d/page>')
  })

  it('handles a fenced block larger than V8 spread-argument limit', () => {
    // A single huge code block (e.g. a logged minified bundle) used to throw
    // `RangeError: Maximum call stack size exceeded` via `out.push(...lines)`.
    const body = Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join('\n')
    const input = `\`\`\`js\n${body}\n\`\`\``

    expect(() => preprocessMarkdown(input)).not.toThrow()
  })
})
