/**
 * WebSocket terminal bridge — the web/Capacitor twin of the Electron
 * `window.hermesDesktop.terminal` bridge.
 *
 * The desktop app runs its right-sidebar shells in the Electron main process
 * (node-pty). In the plain web build (`@/web-bridge/bridge`) there is no main
 * process, so this module provides the SAME 8-method surface over a WebSocket
 * to the gateway's PTY route (`/api/pty?shell=1`, T1): the gateway spawns the
 * user's bare login shell behind the dashboard's existing PTY bridge —
 * raw byte frames, `\x1b[RESIZE:cols;rows]` control frames, close 4410 when
 * the child exits, and `?attach=` tokens for the gateway's keep-alive PTY
 * registry (a dropped socket reattaches by token and replays recent output).
 *
 * The bridge is deliberately shaped like `window.hermesDesktop.terminal`, so
 * `use-terminal-session.ts` can fall back to it without touching its control
 * flow: Electron bridge present → Electron path (byte-for-byte unchanged);
 * absent → this one.
 *
 * No new terminal dependencies: xterm + FitAddon are already the renderer's
 * terminal stack; only the WebSocket is new plumbing.
 */

import type { GatewayWsUrlResult } from '@hermes/shared'

import { getApiRequestProfile } from '@/api/client'
import type { HermesTerminalExit, HermesTerminalSession } from '@/global'

// ── T1 close codes (hermes_cli/web_routers/chat_ws.py, shell mode) ──────────
const CLOSE_CHILD_EXITED = 4410 // child shell exited (keep-alive registry drain)
const CLOSE_SUPERSEDED = 4409 // another socket took this attach token over
const CLOSE_AUTH = 4401 // credential rejected (token / ticket / host check)
const CLOSE_BAD_CWD = 4400 // ?cwd= failed server-side validation
const CLOSE_CLIENT = 4408 // peer not allowed
const CLOSE_CHAT_DISABLED = 4404 // embedded chat/PTY disabled on the gateway
const CLOSE_STALLED = 1013 // PTY input stalled
const CLOSE_INTERNAL = 1011 // server error (incl. "no POSIX PTY bridge")

/** PTY input / resize frames queued while the socket is (re)connecting. */
const MAX_QUEUED_BYTES = 64 * 1024
/** A dial that hasn't settled within this long is a dead gateway, not a slow one. */
const DIAL_TIMEOUT_MS = 20_000

export interface CreateWsTerminalBridgeOptions {
  /** Open (or reconnect) the PTY socket. The URL already carries the
   *  gateway's auth scheme (token or freshly minted ticket) plus this
   *  bridge's own params (`shell=1`, `attach=`, `cwd=`). Must resolve to a
   *  `ws(s)://` URL or the start/attach rejects with a visible error. */
  resolvePtyUrl: (params: Record<string, string>) => Promise<string>
  /** Stable per-tab attach token for the gateway's keep-alive registry: the
   *  shell outlives a dropped socket and reattaches by this token (replaying
   *  its recent output). */
  sessionToken: (id: string) => string
}

type DataListener = (payload: string) => void
type ExitListener = (payload: HermesTerminalExit) => void

interface SessionRecord {
  id: string
  token: string
  /** The server-side launch dir this session dialed with — the remote shell
   *  has no host-side cwd introspection endpoint, so `cwd(id)` degrades to
   *  this value (graceful, never throws, per the Electron probe contract). */
  cwd: string
  socket: WebSocket | null
  /** Monotonic socket-dial generation: superseded sockets' close events are
   *  ignored once a replacement socket owns the session. */
  socketGeneration: number
  /** Typed frames to flush on socket open (`ArrayBuffer`-backed: `send`'s
   *  BufferSource is the non-shared flavor under TS 5.7 typed arrays). */
  queue: Uint8Array<ArrayBuffer>[]
  queuedBytes: number
  /** The dial settled into an open socket. */
  attached: boolean
  /** The socket has ever opened this session — auto-redial is a RECOVERY of
   *  a live session, so a dial that never opened (initial `start` against a
   *  dead/unconfigured gateway) does not spawn background redials. */
  everOpen: boolean
  /** The child shell exited (close 4410) — onExit fired with the neutral
   *  payload exactly once; the session is terminal, no reconnect offered. */
  exitNotified: boolean
  /** Abnormal close / dial failure, user-visible string. Cleared on a new
   *  dial that opens; set on any close the session didn't intend. */
  lastError: null | string
  /** The close code that set `lastError` (null while healthy) — `start()`'s
   *  4400 cwd-fallback checks it rather than parsing the message. */
  lastCloseCode: null | number
  /** `dispose`d — the auto-redial timer and late socket events must stop. */
  disposed: boolean
  /** Failed auto-redials since the last successful open — capped so a
   *  persistently-down gateway stops hammering the ticket endpoint. */
  redials: number
  /** The auto-redial cap fired the degradation notice (`onExit` `reason`
   *  payload) exactly once per outage. Reset on a successful open. */
  degradationNotified: boolean
  /** Captured at the start of each dial: was this session in a stored-error
   *  state (an abnormal close / failed dial) just now? When the resulting
   *  socket OPENS, that's a recovery — the `recover` listeners fire so the
   *  panel can drop its "connection lost" notice. Cleared on that open. */
  wasInError: boolean
  /** PTY output that arrived before the hook's `onData` listener registered:
   *  the first `start` resolves on socket-open, and the login-shell prompt
   *  streams in the same beat — without this buffer the prompt's first lines
   *  are silently dropped. Flushed when the first listener subscribes. */
  pendingData: string
  data: Map<unknown, DataListener>
  exit: Map<unknown, ExitListener>
  /** Fired when a re-open clears an active degradation (auto-redial or an
   *  explicit `attach` landed after a stored `lastError`). */
  recover: Map<unknown, () => void>
}

// ── byte framing ─────────────────────────────────────────────────────────────
// The T1 PTY bridge streams raw bytes; decode binary frames ourselves so 24-bit
// SGR / DCS passthrough never depends on which frame flavor a server sends.
const utf8Decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null

function decodeFrame(data: unknown): string {
  if (typeof data === 'string') {
    return data
  }

  if (data instanceof ArrayBuffer) {
    return utf8Decoder ? utf8Decoder.decode(new Uint8Array(data)) : ''
  }

  if (ArrayBuffer.isView(data)) {
    return utf8Decoder ? utf8Decoder.decode(data as ArrayBufferView) : ''
  }

  return ''
}

function toBytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text)
}

/** T1 resize frame: `\x1b[RESIZE:<cols>;<rows>]` — consumed locally by the
 *  gateway (SIGWINCH into the child), NEVER written into the PTY. */
function resizeFrame(cols: number, rows: number): Uint8Array<ArrayBuffer> {
  return toBytes(`\x1b[RESIZE:${Math.max(1, Math.floor(cols))};${Math.max(1, Math.floor(rows))}]`)
}

/** Map a pre-accept / abnormal close code onto the user-visible degradation
 *  string shown in the terminal panel. These codes mean the SHELL is gone or
 *  was never granted — the caller renders a notice; a later `attach` redial
 *  can recover a keep-alive session. */
export function describeWsClose(code: number, reason: string): string {
  switch (code) {
    case CLOSE_CHILD_EXITED:
      return 'the terminal session ended'

    case CLOSE_SUPERSEDED:
      return 'another window took over this terminal session'

    case CLOSE_AUTH:
      return `the gateway rejected the terminal session (code ${code}) — check your gateway sign-in and retry`

    case CLOSE_BAD_CWD:
      return `the chosen working directory was rejected on the gateway host${reason ? ` (${reason})` : ''}`

    case CLOSE_CHAT_DISABLED:
      return 'the gateway has embedded chat disabled, so no shell can be attached'

    case CLOSE_CLIENT:
      return 'this host is not allowed to open terminal sessions'

    case CLOSE_STALLED:
      return 'the terminal connection stalled and was closed'

    case CLOSE_INTERNAL:
      return `the gateway could not start a shell${reason ? ` (${reason})` : ''} — its host may lack a POSIX PTY bridge`

    default:
      return `the terminal connection was lost (code ${code}${reason ? `: ${reason}` : ''})`
  }
}

/**
 * The WebSocket-backed implementation of the `window.hermesDesktop.terminal`
 * surface. One instance per terminal tab (session ids never collide); the
 * gateway's keep-alive registry holds the shell up to its TTL between dials.
 */
export function createWsTerminalBridge(options: CreateWsTerminalBridgeOptions) {
  const { resolvePtyUrl, sessionToken } = options
  const sessions = new Map<string, SessionRecord>()

  function record(id: string): SessionRecord {
    let session = sessions.get(id)

    if (!session) {
      session = {
        id,
        token: sessionToken(id),
        cwd: '',
        socket: null,
        socketGeneration: 0,
        queue: [],
        queuedBytes: 0,
        attached: false,
        everOpen: false,
        exitNotified: false,
        lastError: null,
        lastCloseCode: null,
        disposed: false,
        redials: 0,
        degradationNotified: false,
        wasInError: false,
        pendingData: '',
        data: new Map(),
        exit: new Map(),
        recover: new Map()
      }
      sessions.set(id, session)
    }

    return session
  }

  /** Append a frame to the input queue (flushed on socket open). */
  function enqueue(session: SessionRecord, frame: Uint8Array<ArrayBuffer>): void {
    if (session.queuedBytes + frame.byteLength > MAX_QUEUED_BYTES && session.queue.length > 0) {
      // Overflow: keep the most recent bytes — a burst typed into a dead
      // socket is lost either way; the newest keystrokes matter most.
      while (session.queue.length > 0 && session.queue[0].byteLength + frame.byteLength > MAX_QUEUED_BYTES) {
        session.queuedBytes -= session.queue.shift()!.byteLength
      }
    }

    session.queue.push(frame)
    session.queuedBytes += frame.byteLength
  }

  function openSocket(session: SessionRecord, params: Record<string, string>): void {
    session.socketGeneration += 1
    const generation = session.socketGeneration

    void Promise.resolve()
      .then(() => resolvePtyUrl(params))
      .then(url => {
        // A replacement dial superseded this one (attach racing start): drop
        // it silently; the new socket's listeners drive the session state.
        if (generation !== session.socketGeneration || typeof url !== 'string' || !/^wss?:\/\//i.test(url)) {
          if (generation === session.socketGeneration && !/^wss?:\/\//i.test(String(url))) {
            session.lastError = 'could not resolve a gateway WebSocket URL for the terminal'
          }

          return
        }

        const socket = new WebSocket(url)
        socket.binaryType = 'arraybuffer'

        if (generation !== session.socketGeneration) {
          // Superseded while the URL promise was in flight.
          try {
            socket.close()
          } catch {
            // already gone
          }

          return
        }

        session.socket = socket
        // Was this session in a stored-error state (an abnormal close / a
        // failed dial) just now? Captured BEFORE `lastError` is cleared so a
        // successful re-open can be recognized as a recovery. A fresh `start`
        // has no stored error, so `wasInError` stays false and recover never
        // fires spuriously.
        session.wasInError = session.lastError != null
        session.lastError = null
        session.attached = false

        let wasOpen = false

        socket.onopen = () => {
          if (generation !== session.socketGeneration || session.socket !== socket) {
            return
          }

          wasOpen = true
          session.attached = true
          session.everOpen = true
          session.redials = 0
          session.degradationNotified = false
          session.lastCloseCode = null

          // Recovery: this open cleared a stored degradation (a redial after
          // an abnormal close, or an explicit `attach`). Tell the panel to
          // drop its "connection lost" notice and resume claiming open.
          if (session.wasInError) {
            session.wasInError = false

            for (const callback of session.recover.values()) {
              callback()
            }
          }

          // Drain PTY input + resizes captured while the socket was down.
          const queue = session.queue

          session.queue = []
          session.queuedBytes = 0

          for (const frame of queue) {
            try {
              socket.send(frame)
            } catch {
              // send() only throws while closing — nothing to retry here.
            }
          }
        }

        socket.onmessage = event => {
          if (generation !== session.socketGeneration || session.socket !== socket) {
            return
          }

          const text = decodeFrame(event.data)

          if (!text) {
            return
          }

          // Before the hook's `onData` listener has registered (the `start`
          // promise resolves on socket-open, and the login-shell prompt lands
          // in the same beat) buffer it; the first `onData` flushes it.
          if (session.data.size === 0) {
            session.pendingData += text

            if (session.pendingData.length > 64 * 1024) {
              // Bound the pre-listener buffer: keep the tail (the live prompt
              // is at the end) rather than the whole login banner.
              session.pendingData = session.pendingData.slice(-64 * 1024)
            }

            return
          }

          for (const callback of session.data.values()) {
            callback(text)
          }
        }

        socket.onclose = event => {
          if (generation !== session.socketGeneration || session.socket !== socket) {
            return
          }

          session.socket = null
          session.attached = false

          if (event.code === CLOSE_CHILD_EXITED) {
            // The child shell exited: fire onExit ONCE with the neutral
            // payload — the hook closes the tab like a real terminal.
            session.exitNotified = true

            for (const callback of session.exit.values()) {
              callback({ code: 0, signal: null })
            }

            return
          }

          if (event.code === 1000 || (event.code === 1005 && wasOpen)) {
            // Clean teardown (dispose / page hide) — nothing to surface.
            return
          }

          // Abnormal close: degrade visibly and keep the session record so
          // `attach` can redial the same keep-alive shell.
          if (session.lastError == null) {
            session.lastError = describeWsClose(event.code, event.reason)
            session.lastCloseCode = event.code
          }

          // Surface the notice immediately (not at the redial cap) so the panel
          // reacts to the drop the moment it happens.
          fireDegradation(session)

          // Auto-redial ONLY when this socket had been live and then dropped
          // (gateway restart, network blip) — the registry holds the shell up
          // to its TTL, so recovery is unobserved. A rejection BEFORE the
          // socket ever opened (4400/4404/4408/1011, or an auth ticket that
          // is already consumed/invalid) is permanent for these params:
          // surface it and let the user start a fresh session.
          if (event.code !== CLOSE_SUPERSEDED && session.everOpen) {
            scheduleRedial(session)
          }
        }
      })
      .catch(error => {
        if (generation !== session.socketGeneration || session.socket !== null) {
          return
        }

        session.lastError = error instanceof Error ? error.message : String(error)
        fireDegradation(session)

        // URL resolution failed (auth re-mint, network): each redial mints a
        // fresh credential, so a transient failure self-heals — but only for a
        // session that was ever live; a fresh `start` against a dead gateway
        // surfaces the error and leaves recovery to the user reopening.
        if (session.everOpen) {
          scheduleRedial(session)
        }
      })
  }

  /** Bounded fast burst (5 × 2s) then slow 30s retries: a brief gateway
   *  restart heals unobserved; a long outage stops hammering the ticket
   *  endpoint but the panel recovers on its own the moment the gateway is
   *  back, no user action. A successful open resets the counter; `dispose`
   *  and a child exit stop the timer chain (the record's flags are checked
   *  in every timer body). */
  const REDIAL_BURST = 5
  const REDIAL_FAST_MS = 2_000
  const REDIAL_SLOW_MS = 30_000

  /** Dial params for the reattach path: the keep-alive token only. A reattach
   *  must NOT carry `cwd` — the T1 registry treats the token as the session's
   *  identity and respawns the ORIGINAL launch directory when the registry
   *  session was reaped or the gateway restarted; a differing `cwd` would
   *  start a NEW shell behind a stale prompt instead of resurrecting the old
   *  one. */
  function reattachParams(session: SessionRecord): Record<string, string> {
    return { shell: '1', attach: session.token }
  }

  /** Fire the one-shot degradation notice (`onExit` `reason` payload) so the
   *  panel keeps the tab and shows what happened. Idempotent per outage:
   *  flapping closes don't re-spam the notice; a successful open resets the
   *  flag so the next outage notifies again. */
  function fireDegradation(session: SessionRecord): void {
    if (session.degradationNotified || !session.lastError || session.exitNotified || session.disposed) {
      return
    }

    session.degradationNotified = true

    for (const callback of session.exit.values()) {
      callback({ code: null, signal: null, reason: session.lastError })
    }
  }

  function scheduleRedial(session: SessionRecord): void {
    const slow = session.redials >= REDIAL_BURST
    const delay = slow ? REDIAL_SLOW_MS : REDIAL_FAST_MS

    // Past the fast burst, keep only SLOW retries (never stop entirely — a
    // long gateway outage must still self-heal the panel); the cap only
    // downgrades the cadence, it doesn't abandon the session.
    session.redials += 1

    window.setTimeout(() => {
      if (!session.disposed && !session.exitNotified && session.lastError && !session.attached) {
        openSocket(session, reattachParams(session))
      }
    }, delay)
  }

  /** Poll the CURRENT socket (tracked by generation so a replacement dial is
   *  followed automatically) until it opens or dies. */
  function awaitSocketSettled(session: SessionRecord, timeoutMs: number): Promise<'closed' | 'open'> {
    return new Promise(resolve => {
      let done = false

      const finish = (result: 'closed' | 'open') => {
        if (done) {
          return
        }

        done = true
        window.clearInterval(poll)
        resolve(result)
      }

      const check = () => {
        if (done) {
          return
        }

        const socket = session.socket

        if (socket?.readyState === WebSocket.OPEN) {
          finish('open')
        } else if (socket && socket.readyState === WebSocket.CLOSED) {
          finish('closed')
        } else if (!socket && session.lastError) {
          // The URL dial itself failed (auth re-mint, network) — no socket
          // was ever created; don't sit out the full timeout on a dead end.
          finish('closed')
        }
      }

      const poll = window.setInterval(check, 150)
      check()
      window.setTimeout(() => finish('closed'), timeoutMs)
    })
  }

  const bridge = {
    /** Start a fresh shell session. Resolves once the socket is OPEN (the
     *  gateway has accepted the upgrade and spawned the child; first prompt
     *  bytes then stream through `onData`). A dead `cwd` fails closed
     *  server-side (close 4400, pre-accept) — the bridge degrades gracefully
     *  by re-dialing WITHOUT `cwd` (the gateway then spawns in its launch
     *  directory) instead of rejecting with a dead-path error: a remote
     *  shell has no host-side cwd introspection, so a stale persisted
     *  directory must never block the panel. */
    start: async (opts: { cols?: number; cwd?: string; rows?: number } = {}): Promise<HermesTerminalSession> => {
      const id = `ws-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
      const session = record(id)

      session.cwd = (opts.cwd ?? '').trim()
      session.exitNotified = false
      session.degradationNotified = false
      session.lastError = null
      session.lastCloseCode = null

      const dial = (cwdParam: string | undefined) =>
        openSocket(session, {
          shell: '1',
          attach: session.token,
          ...(cwdParam ? { cwd: cwdParam } : {})
        })

      dial(session.cwd || undefined)

      // Spawn at the requested viewport: the first `resize` from the hook is
      // delta-gated, so the initial size must ride the initial queue (flushed
      // on socket open) instead of the PTY booting at the server default.
      if (opts.cols && opts.rows) {
        enqueue(session, resizeFrame(opts.cols, opts.rows))
      }

      if ((await awaitSocketSettled(session, DIAL_TIMEOUT_MS)) !== 'open') {
        // 4400 = the requested cwd no longer exists on the gateway host:
        // degrade to the gateway's launch dir rather than failing the start.
        if (session.lastCloseCode === CLOSE_BAD_CWD && session.cwd) {
          session.cwd = ''
          session.lastError = null
          session.lastCloseCode = null

          dial(undefined)

          if ((await awaitSocketSettled(session, DIAL_TIMEOUT_MS)) !== 'open') {
            throw new Error(session.lastError ?? 'could not reach the gateway terminal service')
          }
        } else {
          throw new Error(session.lastError ?? 'could not reach the gateway terminal service')
        }
      }

      return { id, shell: 'shell', cwd: session.cwd }
    },

    /** Reattach after a dropped connection: redial the SAME gateway
     *  keep-alive session by its attach token (the shell survives up to the
     *  registry TTL and replays its recent output). The reconnect mints fresh
     *  auth through `resolvePtyUrl`, so a stale single-use ticket never rides
     *  along. Resolves false when the session is unrecoverable (abnormal
     *  close, registry reaped, gateway down) — the caller shows the stored
     *  `lastError`. */
    attach: async (id: string): Promise<boolean> => {
      const session = record(id)

      if (session.attached && session.socket?.readyState === WebSocket.OPEN) {
        return true
      }

      if (session.exitNotified) {
        // The child shell exited — nothing to reattach to.
        return false
      }

      // Fresh recovery: give it the full fast burst again. `lastError` is left
      // intact on purpose — `openSocket` captures `wasInError` from it at dial
      // time and clears it on open, which is what fires the recover listeners.
      // A failed re-attach keeps the stored error for the caller to surface.
      session.redials = 0
      openSocket(session, { shell: '1', attach: session.token })

      return (await awaitSocketSettled(session, DIAL_TIMEOUT_MS)) === 'open'
    },

    /** Register an output listener (server → PTY bytes, already UTF-8 text).
     *  Returns the unsubscribe, Electron-bridge compatible. */
    onData: (id: string, callback: DataListener): (() => void) => {
      const session = record(id)
      session.data.set(callback, callback)

      // Flush the pre-listener output buffer so the first prompt isn't lost.
      if (session.pendingData) {
        const pending = session.pendingData

        session.pendingData = ''
        callback(pending)
      }

      return () => {
        session.data.delete(callback)
      }
    },

    /** Register an exit listener. Fires once with `{ code: 0, signal: null }`
     *  when the child shell exits (close 4410 → the hook closes the tab),
     *  and once with `reason` set on an abnormal socket close (→ the hook
     *  keeps the tab and renders the user-visible notice). Late subscribers
     *  on an already-settled session are told the stored outcome. */
    onExit: (id: string, callback: ExitListener): (() => void) => {
      const session = record(id)
      session.exit.set(callback, callback)

      if (session.exitNotified) {
        callback({ code: 0, signal: null })
      } else if (session.lastError) {
        callback({ code: null, signal: null, reason: session.lastError })
      }

      return () => {
        session.exit.delete(callback)
      }
    },

    /** Register a RECOVERY listener: when a re-open clears an active
     *  degradation (an auto-redial or an explicit `attach` lands after an
     *  abnormal close stored `lastError`), fires once. This is a WS-bridge
     *  surface — the Electron main-process bridge never degrades mid-session. */
    onRecover: (id: string, callback: () => void): (() => void) => {
      const session = record(id)
      session.recover.set(callback, callback)

      return () => {
        session.recover.delete(callback)
      }
    },

    /** Send keystrokes into the shell. Bytes typed before the socket is up
     *  are queued so input during a brief reconnect never vanishes. */
    write: async (id: string, data: string): Promise<boolean> => {
      const session = record(id)
      const socket = session.socket

      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(toBytes(data))

          return true
        } catch {
          // send() throws while closing — fall through and queue.
        }
      }

      enqueue(session, toBytes(data))

      return true
    },

    /** T1 resize frame — the gateway consumes it locally (SIGWINCH into the
     *  child); identical call shape to the Electron bridge's `resize`. */
    resize: async (id: string, size: { cols: number; rows: number }): Promise<boolean> => {
      const session = record(id)
      const socket = session.socket
      const frame = resizeFrame(size.cols, size.rows)

      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(frame)

          return true
        } catch {
          // fall through and queue
        }
      }

      enqueue(session, frame)

      return true
    },

    /** Close the socket. The gateway's keep-alive registry holds the shell up
     *  to its TTL, so a later `attach` resumes it; after the TTL (or a server
     *  restart) the next dial simply spawns a fresh shell. Never throws;
     *  safe to call repeatedly (tab-close and pane-close both dispose). */
    dispose: async (id: string): Promise<boolean> => {
      const session = sessions.get(id)

      if (session) {
        session.disposed = true
        sessions.delete(id)
      }

      const socket = session?.socket

      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.close(1000, 'terminal disposed')
        } catch {
          // already closing
        }
      }

      return Boolean(session)
    },

    /** Electron-bridge twin of `cwd(id)`: a REMOTE shell has no host-side
     *  process-introspection endpoint, so this degrades gracefully to the
     *  directory the session was dialed in (or '' when it fell back to the
     *  gateway's launch dir). Best-effort by contract — it never throws. */
    cwd: async (id: string): Promise<string | null> => {
      const session = sessions.get(id)

      return session?.cwd ?? null
    },

    /** Test/teardown helper: the user-visible degradation string stored on a
     *  session after an abnormal close (null while healthy). */
    lastError: (id: string): null | string => {
      return sessions.get(id)?.lastError ?? null
    }
  }

  return bridge
}

/** The 8-method surface `use-terminal-session.ts` speaks — structurally
 *  identical to `Window['hermesDesktop']['terminal']`. */
export type WsTerminalBridge = ReturnType<typeof createWsTerminalBridge>

// ── Gateway URL resolution (same source of truth as the page's other WS) ────
// The page's gateway client (`getGatewayWsUrl`) already resolves the active
// registry source: token gateways reuse the session token, cookie/gated
// gateways mint a fresh single-use ticket per call (the renderer re-resolves
// the URL on every reconnect for exactly this reason). The PTY route shares
// that auth machinery (`_ws_auth_reason` in the gateway), so a `/api/ws` URL
// works verbatim against `/api/pty` once the path is swapped.

/** Append this bridge's own params to the URL the gateway client produced for
 *  `/api/ws`, swapping in `/api/pty` while preserving the auth pair and the
 *  dev-proxy routing tag. */
export function withPtyParams(wsUrl: string, params: Record<string, string>): string {
  const original = new URL(wsUrl)
  const url = new URL(wsUrl)

  url.pathname = '/api/pty'
  url.search = ''

  for (const [key, value] of Object.entries(params)) {
    if (value !== '') {
      url.searchParams.set(key, value)
    }
  }

  for (const [key, value] of original.searchParams.entries()) {
    // The original URL's auth credential plus the dev-proxy routing tag
    // survive the path swap.
    if (key === 'token' || key === 'ticket' || key === 'internal' || key === '__hgw') {
      url.searchParams.set(key, value)
    }
  }

  return url.toString()
}

/** Resolve a dialable PTY URL from the ACTIVE registry source's `/api/ws`
 *  URL. Must be called immediately before opening the socket (tickets are
 *  single-use, 30s TTL). */
export async function resolvePtyUrlFor(params: Record<string, string> = {}): Promise<string> {
  const mint = window.hermesDesktop?.getGatewayWsUrl

  if (typeof mint !== 'function') {
    throw new Error('no gateway connection is available to open a terminal session')
  }

  const result = (await mint(getApiRequestProfile() ?? null)) as GatewayWsUrlResult | null

  if (result == null) {
    throw new Error('could not resolve a gateway WebSocket URL')
  }

  if (typeof result === 'string') {
    return withPtyParams(result, params)
  }

  if (result.ok) {
    return withPtyParams(result.wsUrl, params)
  }

  if ((result as { needsOauthLogin?: boolean }).needsOauthLogin) {
    throw new Error('your gateway session expired — sign in again to open a terminal')
  }

  throw new Error((result as { error: string }).error || 'could not resolve a gateway WebSocket URL')
}

/**
 * The lazily-resolving bridge `use-terminal-session.ts` falls back to when
 * `window.hermesDesktop.terminal` is absent (web + Capacitor builds). The
 * real WS bridge materializes on first use, resolving the gateway URL through
 * the page's own `getGatewayWsUrl` at dial time — so a later profile or
 * connection switch re-resolves against the CURRENT active registry source,
 * exactly like the renderer's gateway reconnects do.
 */
export class LazyTerminalBridge {
  private bridgePromise: null | Promise<ReturnType<typeof createWsTerminalBridge>> = null

  private makeBridge = () =>
    createWsTerminalBridge({
      resolvePtyUrl: params => resolvePtyUrlFor(params),
      sessionToken: id => id
    })

  private resolve(): Promise<ReturnType<typeof createWsTerminalBridge>> {
    if (!this.bridgePromise) {
      this.bridgePromise = Promise.resolve().then(this.makeBridge)
    }

    return this.bridgePromise
  }

  attach = async (id: string): Promise<boolean> => this.resolve().then(bridge => bridge.attach(id))

  cwd = async (id: string): Promise<string | null> => this.resolve().then(bridge => bridge.cwd(id))

  dispose = async (id: string): Promise<boolean> => this.resolve().then(bridge => bridge.dispose(id))

  onData = (id: string, callback: (payload: string) => void): (() => void) => {
    let unsub: (() => void) | null = null
    let unmounted = false

    void this.resolve().then(bridge => {
      if (unmounted) {
        return
      }

      unsub = bridge.onData(id, callback)
    })

    return () => {
      unmounted = true
      unsub?.()
    }
  }

  onExit = (id: string, callback: (payload: HermesTerminalExit) => void): (() => void) => {
    let unsub: (() => void) | null = null
    let unmounted = false

    void this.resolve().then(bridge => {
      if (unmounted) {
        return
      }

      unsub = bridge.onExit(id, callback)
    })

    return () => {
      unmounted = true
      unsub?.()
    }
  }

  onRecover = (id: string, callback: () => void): (() => void) => {
    let unsub: (() => void) | null = null
    let unmounted = false

    void this.resolve().then(bridge => {
      if (unmounted) {
        return
      }

      unsub = bridge.onRecover(id, callback)
    })

    return () => {
      unmounted = true
      unsub?.()
    }
  }

  resize = async (id: string, size: { cols: number; rows: number }): Promise<boolean> =>
    this.resolve().then(bridge => bridge.resize(id, size))

  start = async (options?: { cols?: number; cwd?: string; rows?: number }): Promise<HermesTerminalSession> =>
    this.resolve().then(bridge => bridge.start(options))

  write = async (id: string, data: string): Promise<boolean> => this.resolve().then(bridge => bridge.write(id, data))
}

export function createLazyTerminalBridge(): LazyTerminalBridge {
  return new LazyTerminalBridge()
}

/** One bridge per window: session records, input queues and auto-redial
 *  timers are per-tab state that must survive the hook's effect re-runs
 *  (the panel re-mounts on layout moves, not on gateway outages). The URL
 *  resolution is lazy and per-dial, so a later profile/connection switch
 *  re-resolves against the CURRENT active registry source. */
let _defaultBridge: LazyTerminalBridge | null = null

export function getWsTerminalBridge(): LazyTerminalBridge {
  if (!_defaultBridge) {
    _defaultBridge = createLazyTerminalBridge()
  }

  return _defaultBridge
}
