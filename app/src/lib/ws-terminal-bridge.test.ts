import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWsTerminalBridge, describeWsClose, withPtyParams } from './ws-terminal-bridge'

// ── Scripted fake WebSocket ──────────────────────────────────────────────────
// The bridge only uses the constructor, binaryType, readyState, the three
// handlers, send() and close() — a tiny scripted fake covers the whole
// surface, and every dial is inspectable (URL + sent frames).
class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly sent: Uint8Array[] = []
  readyState = FakeWebSocket.CONNECTING
  binaryType = ''
  onopen: null | (() => void) = null
  onmessage: null | ((event: { data: unknown }) => void) = null
  onclose: null | ((event: { code: number; reason: string }) => void) = null

  constructor(readonly url: string) {
    created.push(this)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  data(payload: ArrayBuffer | string): void {
    this.onmessage?.({ data: payload })
  }

  close(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason })
  }

  send(payload: ArrayBuffer | Blob | ArrayBufferView | string): void {
    if (typeof payload === 'string') {
      this.sent.push(new TextEncoder().encode(payload))

      return
    }

    // The bridge only sends its own frames (Uint8Array<ArrayBuffer>); accept
    // the BufferSource union but record as bytes.
    const bytes =
      payload instanceof ArrayBuffer
        ? new Uint8Array(payload)
        : ArrayBuffer.isView(payload)
          ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
          : new Uint8Array(0)

    this.sent.push(bytes)
  }

  /** Frames this socket was sent, concatenated and decoded. */
  textSent(): string {
    return this.sent.map(frame => new TextDecoder().decode(frame)).join('')
  }
}

let created: FakeWebSocket[] = []
let resolvePtyUrl: () => Promise<string>

type Bridge = ReturnType<typeof createWsTerminalBridge>

function bridgeFor(): Bridge {
  created = []

  return createWsTerminalBridge({
    resolvePtyUrl: params => resolvePtyUrl().then(url => withPtyParams(url, params)),
    sessionToken: id => id
  })
}

function fakeTimers(): void {
  vi.useFakeTimers()
  created = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
}

/** Advance the clock one poll tick (the bridge polls its socket every 150ms). */
async function tick(ms = 150): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** Advance in 150ms steps until `cond` holds (bounded) — removes the
 *  microtask-ordering fragility of guessing how many ticks a re-dial takes. */
async function advanceUntil(cond: () => boolean, maxSteps = 20): Promise<void> {
  for (let i = 0; i < maxSteps && !cond(); i += 1) {
    await tick()
  }
}

/** Start a session, open its socket, and let the poll observe the open. */
async function openSession(bridge: Bridge, opts: { cols?: number; cwd?: string; rows?: number } = {}): Promise<{ bridge: Bridge; id: string; socket: FakeWebSocket }> {
  const start = bridge.start(opts)
  await advanceUntil(() => created.length >= 1)
  const socket = created[0]!
  socket.open()
  await tick() // poll observes OPEN → start resolves
  const session = await start

  return { bridge, id: session.id, socket }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ws-terminal-bridge', () => {
  it('dials /api/pty with the attach token, boots at the requested size, streams and accepts input', async () => {
    fakeTimers()
    resolvePtyUrl = async () => 'ws://gw.test/api/ws?token=abc&__hgw=http%3A%2F%2F127.0.0.1%3A9119'
    const bridge = bridgeFor()

    const { id, socket } = await openSession(bridge, { cols: 80, cwd: '/root', rows: 24 })

    // Bridge params first, then the resolved URL's auth pair + routing tag.
    expect(new URL(socket.url).searchParams.get('shell')).toBe('1')
    expect(new URL(socket.url).searchParams.get('attach')).toBe(id)
    expect(new URL(socket.url).searchParams.get('cwd')).toBe('/root')
    expect(new URL(socket.url).searchParams.get('token')).toBe('abc')
    expect(socket.url).toContain('__hgw=')

    // The initial resize rode the pre-open queue, flushed on open.
    expect(socket.textSent()).toBe('\x1b[RESIZE:80;24]')

    // Boot output that lands BEFORE the listener registers is buffered...
    socket.data('boot $ ')
    const seen: string[] = []
    bridge.onData(id, payload => seen.push(payload))
    expect(seen).toEqual(['boot $ '])

    // ...and live output + input round-trip after.
    socket.data('hello')
    expect(seen).toEqual(['boot $ ', 'hello'])

    await bridge.write(id, 'ls\r')
    expect(socket.textSent()).toBe('\x1b[RESIZE:80;24]ls\r')

    await bridge.resize(id, { cols: 100, rows: 40 })
    expect(socket.textSent()).toBe('\x1b[RESIZE:80;24]ls\r\x1b[RESIZE:100;40]')

    // The remote shell has no host cwd endpoint: the probe degrades to the
    // dial cwd.
    await expect(bridge.cwd(id)).resolves.toBe('/root')

    // A clean dispose closes with 1000 and surfaces no exit notice.
    const exits: unknown[] = []
    bridge.onExit(id, payload => exits.push(payload))
    await bridge.dispose(id)
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    expect(exits).toEqual([])
  })

  it('rejects start when the gateway is unreachable, and degrades a dead cwd (4400) to the launch dir', async () => {
    fakeTimers()

    // (a) No gateway at all: the URL dial rejects → start rejects fast, and no
    //     socket was ever created (so no auto-redial is spawned).
    resolvePtyUrl = async () => {
      throw new Error('no gateway reachable')
    }

    const bridge = bridgeFor()
    const pending = bridge.start({ cols: 80, rows: 24 })
    // Keep the rejection handled while we advance the fake clock (a late
    // `.rejects` surfaces as an unhandled error in Vitest); assert on the
    // captured failure afterwards.
    let dialError: unknown = null
    pending.then(
      () => undefined,
      error => {
        dialError = error
      }
    )
    await tick()
    await tick() // the poller observes the stored lastError and fails fast
    expect(dialError).toBeInstanceOf(Error)
    expect((dialError as Error).message).toBe('no gateway reachable')
    expect(created.length).toBe(0)

    // (b) A dead `cwd` fails closed pre-accept (close 4400): the bridge degrades
    //     by re-dialing WITHOUT cwd, and the session reports the fallback dir.
    resolvePtyUrl = async () => 'ws://gw.test/api/ws?token=abc'
    const bridge2 = bridgeFor()
    const pending2 = bridge2.start({ cols: 80, cwd: '/gone', rows: 24 })
    await advanceUntil(() => created.length === 1)
    expect(new URL(created[0]!.url).searchParams.get('cwd')).toBe('/gone')
    created[0]!.close(4400, 'cwd: /gone does not exist')
    await advanceUntil(() => created.length === 2) // 4400 fallback re-dials without cwd
    expect(new URL(created[1]!.url).searchParams.get('cwd')).toBeNull()
    created[1]!.open()
    await tick()
    const session2 = await pending2

    expect(created[1]!.url).toBe(`ws://gw.test/api/pty?shell=1&attach=${session2.id}&token=abc`)
    expect(created[1]!.url).not.toContain('cwd=')
    expect(session2.cwd).toBe('')
  })

  it('fires onExit with a neutral payload when the child shell exits (close 4410)', async () => {
    fakeTimers()
    resolvePtyUrl = async () => 'ws://gw.test/api/ws?token=abc'
    const { bridge, id, socket } = await openSession(bridgeFor())

    const exits: unknown[] = []
    bridge.onExit(id, payload => exits.push(payload))

    socket.close(4410)

    expect(exits).toEqual([{ code: 0, signal: null }])

    // No auto-redial after a child exit; a re-attach finds nothing.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(created.length).toBe(1)
    await expect(bridge.attach(id)).resolves.toBe(false)
  })

  it('surfaces an abnormal close as a degradation notice and recovers on redial', async () => {
    fakeTimers()
    resolvePtyUrl = async () => 'ws://gw.test/api/ws?token=abc'
    const { bridge, id, socket } = await openSession(bridgeFor())

    const exits: Array<{ code: number | null; signal: string | null; reason?: string }> = []
    const recovers: string[] = []
    bridge.onExit(id, payload => exits.push(payload))
    bridge.onRecover(id, () => recovers.push(id))

    // Network drop: the notice fires immediately (not at the redial cap)...
    socket.close(1006)
    expect(exits).toHaveLength(1)
    expect(exits[0]?.reason).toMatch(/connection was lost/i)
    expect(exits[0]?.code).toBe(null)

    // ...and the bounded fast burst re-dials by the keep-alive token (no cwd).
    await advanceUntil(() => created.length === 2)
    const redial = created.at(-1)!
    expect(new URL(redial.url).searchParams.get('attach')).toBe(id)
    expect(new URL(redial.url).searchParams.get('cwd')).toBeNull()

    // Input typed while the socket was down is flushed on the redial open.
    await bridge.write(id, 'recovered')
    redial.open()
    await tick()
    expect(recovers).toEqual([id])
    expect(redial.textSent()).toBe('recovered')

    // The next outage notifies again (the flag reset on the successful open).
    redial.close(1013)
    expect(exits).toHaveLength(2)
    expect(exits[1]?.reason).toMatch(/stalled/i)
  })

  it('re-attaches on demand after a drop, clearing the stored error on success', async () => {
    fakeTimers()
    resolvePtyUrl = async () => 'ws://gw.test/api/ws?token=abc'
    const { bridge, id, socket } = await openSession(bridgeFor())

    socket.close(1006)
    await advanceUntil(() => created.length === 2) // an auto-redial has dialed

    // An explicit attach mints a fresh credential and lands on the last dial.
    const attachPromise = bridge.attach(id)
    await advanceUntil(() => created.length === 3)
    const target = created.at(-1)!
    target.open()
    await tick()

    await expect(attachPromise).resolves.toBe(true)
    expect(bridge.lastError(id)).toBe(null)
  })

  it('keeps the fast burst, then downgrades to slow retries without abandoning the session', async () => {
    fakeTimers()
    resolvePtyUrl = async () => 'ws://gw.test/api/ws?token=abc'
    await openSession(bridgeFor())

    // Drop the live socket; every redial dies again: the counter climbs fast
    // (2s) through the 5-try burst, then slows to the 30s cadence — sockets
    // keep appearing, so a long outage still self-heals.
    created[0]!.close(1006)

    for (let i = 1; i <= 10; i += 1) {
      // Redials 1-5 ride the fast 2s burst; 6+ ride the 30s slow cadence
      // (the timer each close arms). Advance exactly that delay.
      await vi.advanceTimersByTimeAsync(i <= 5 ? 2_000 : 30_000)
      const socket = created.at(-1)!
      expect(socket.readyState).toBe(FakeWebSocket.CONNECTING)
      socket.close(1006)
    }

    expect(created.length).toBe(11) // initial + 10 redials
  })

  it('dispose stops the auto-redial timers', async () => {
    fakeTimers()
    resolvePtyUrl = async () => 'ws://gw.test/api/ws?token=abc'
    const { bridge, id, socket } = await openSession(bridgeFor())

    // Drop the live socket (a redial timer is now armed), then dispose the
    // session: its timers must stop, no matter how far we fast-forward.
    socket.close(1006)
    await advanceUntil(() => created.length === 2)
    await bridge.dispose(id)
    const count = created.length
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(created.length).toBe(count)
  })
})

describe('ws-terminal-bridge url helpers', () => {
  it('withPtyParams swaps the route but preserves the auth pair and routing tag', () => {
    expect(withPtyParams('ws://gw.test/api/ws?token=abc&__hgw=x', { shell: '1', attach: 't', cwd: '/r' })).toBe(
      'ws://gw.test/api/pty?shell=1&attach=t&cwd=%2Fr&token=abc&__hgw=x'
    )

    // Empty values are dropped; ticket gateways keep their ticket.
    expect(withPtyParams('wss://gw.test/api/ws?ticket=t-1', { shell: '1', attach: '' })).toBe(
      'wss://gw.test/api/pty?shell=1&ticket=t-1'
    )
  })

  it('describeWsClose maps the T1 gate codes to user-visible strings', () => {
    expect(describeWsClose(4410, '')).toBe('the terminal session ended')
    expect(describeWsClose(4409, '')).toMatch(/another window took over/i)
    expect(describeWsClose(4401, '')).toMatch(/rejected the terminal session/i)
    expect(describeWsClose(4400, '/gone')).toMatch(/working directory was rejected/i)
    expect(describeWsClose(4404, '')).toMatch(/embedded chat disabled/i)
    expect(describeWsClose(4408, '')).toMatch(/not allowed/i)
    expect(describeWsClose(1013, '')).toMatch(/stalled/i)
    expect(describeWsClose(1011, 'no pty')).toMatch(/could not start a shell/i)
    expect(describeWsClose(1006, '')).toMatch(/connection was lost/i)
  })
})
