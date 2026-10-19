/**
 * A client-generated UUID that works in every context.
 *
 * `crypto.randomUUID()` only exists on a secure context (HTTPS or
 * localhost); a dashboard reached over plain HTTP on a LAN IP
 * (e.g. `http://10.1.1.117:9200`) has no `crypto.randomUUID` at all,
 * so every call site that minted an id with it threw
 * `TypeError: crypto.randomUUID is not a function` — which is what
 * made "send message" silently die.
 *
 * Callers only need uniqueness within this browser, never RFC-4122
 * validity, so the fallback (timestamp + Math.random, the same shape
 * `web-bridge/gateways.ts` `newId()` already used for its own ids)
 * is a drop-in replacement.
 */
export function clientRandomUUID(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }
}
