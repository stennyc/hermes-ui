import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// #93911 review follow-up: the Desktop deadline for bot_relay.deliver mirrors
// three backend numbers. Nothing in the type system links a TS constant to a
// Python default, so this file is the seam: it reads the backend sources and
// fails when a mirror drifts or the settlement margin stops being positive.
// Without it, raising the backend turn timeout would silently reintroduce
// #93911 — the client giving up before a valid typed settlement arrives.

// The IN-repo client mirror always lives here.
const relaySource = readFileSync(join(process.cwd(), 'src/plugins/hermes-bots/relay.ts'), 'utf8')

// The BACKEND source the client mirrors. Upstream is a monorepo (the backend
// is checked out next to the UI, so `join(cwd, '..', '..')` reaches it); a
// UI-only fork has the backend INSTALLED separately, not checked out. Probe
// monorepo → the well-known installed root → an explicit `HERMES_AGENT_ROOT`
// override so the drift-guard works in both layouts, and fail with a
// descriptive "backend not found" (instead of a bare ENOENT at import time)
// when it genuinely can't be located. `HERMES_AGENT_ROOT` wins last so a CI
// box pointing elsewhere is the escape hatch.
function resolveBackendRoot(): string {
  const candidates = [
    join(process.cwd(), '..', '..'),
    '/usr/local/lib/hermes-agent',
    process.env.HERMES_AGENT_ROOT
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const root of candidates) {
    if (existsSync(join(root, 'hermes_cli', 'config_defaults.py')) && existsSync(join(root, 'tools', 'bot_relay.py'))) {
      return root
    }
  }

  throw new Error(`hermes-agent backend source not found for the relay mirror; tried: ${candidates.join(', ')}`)
}

// Loaded in `beforeAll` (not at module scope) so a missing backend fails one
// described test cleanly instead of breaking collection of the whole file.
let configDefaults = ''
let relayPlumbing = ''

beforeAll(() => {
  const root = resolveBackendRoot()

  configDefaults = readFileSync(join(root, 'hermes_cli', 'config_defaults.py'), 'utf8')
  relayPlumbing = readFileSync(join(root, 'tools', 'bot_relay.py'), 'utf8')
})

function tsConstant(name: string): number {
  const match = relaySource.match(new RegExp(`const ${name} = ([0-9_]+)`))
  expect(match, `${name} must stay a literal so this test can read it`).toBeTruthy()

  return Number(match![1].replaceAll('_', ''))
}

function pyConstant(name: string): number {
  const match = relayPlumbing.match(new RegExp(`^${name}\\s*=\\s*(\\d+)`, 'm'))
  expect(match, `${name} must exist as a literal in tools/bot_relay.py`).toBeTruthy()

  return Number(match![1])
}

describe('bot_relay.deliver budget mirrors', () => {
  it('mirrors the backend turn-lock default', () => {
    const lockWaitMatch = configDefaults.match(/"turn_wait_seconds":\s*(\d+)/)

    expect(lockWaitMatch, 'bot_mode.turn_wait_seconds default must exist in config_defaults.py').toBeTruthy()
    expect(tsConstant('RELAY_TURN_LOCK_WAIT_MS')).toBe(Number(lockWaitMatch![1]) * 1000)
  })

  it('mirrors the backend per-attempt turn timeout', () => {
    // The backend names both numbers explicitly (tools/bot_relay.py) so the mirror is a
    // constant-to-constant check, not a count of textual subprocess.run(...) call sites.
    expect(tsConstant('RELAY_TURN_ATTEMPT_MS')).toBe(pyConstant('TURN_ATTEMPT_TIMEOUT_SECONDS') * 1000)
    expect(tsConstant('RELAY_TURN_MAX_ATTEMPTS')).toBe(pyConstant('TURN_MAX_ATTEMPTS'))
  })

  it('shares its settlement margin with the sender-side waiter budget', () => {
    // tests/tools/test_bot_relay.py checks that REPLY_WAIT_SECONDS exceeds the rebuilt sum.
    expect(tsConstant('RELAY_DELIVER_SETTLEMENT_MARGIN_MS')).toBe(
      pyConstant('DESKTOP_DELIVER_SETTLEMENT_MARGIN_SECONDS') * 1000
    )
  })

  it('keeps the client deadline strictly greater than the backend ceiling', () => {
    const margin = tsConstant('RELAY_DELIVER_SETTLEMENT_MARGIN_MS')

    // Strictly greater, not equal: a backend that answers at its own limit
    // still has to serialize and transport that answer.
    expect(margin, 'settlement margin must be positive').toBeGreaterThan(0)

    // The call site must pass the composed budget, not a bare literal.
    const drain = relaySource.slice(
      relaySource.indexOf('async function drainRelayOutboxes'),
      relaySource.indexOf('export function startBotRelay')
    )

    expect(drain).toMatch(/'bot_relay\.deliver'[\s\S]{0,400}RELAY_DELIVER_TIMEOUT_MS/)
    expect(drain).not.toMatch(/'bot_relay\.deliver'[\s\S]{0,400}\d{6,}/)
  })
})
