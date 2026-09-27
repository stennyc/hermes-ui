import type { GenerateSWOptions } from 'workbox-build'

// The dashboard injects a short-lived session token into index.html at request
// time, so the HTML shell must never be PRECACHED - a precached copy would
// replay a token from before a dashboard restart. But navigations still need
// an offline story: a NetworkFirst runtime route always fetches the fresh
// token-injected document while online (identical token freshness to not
// caching at all) and only falls back to the last good copy when the network
// is unreachable, where a stale token is moot anyway.
//
// This lives in src (not vite.config.ts) so `tsc -p .` typechecks it and the
// unit test can import it without executing the whole Vite config module.
export const PWA_WORKBOX_OPTIONS = {
  // Precache only static hashed assets. `html` is deliberately absent:
  // index.html is the only HTML we emit and it must stay uncached; the
  // globIgnores entry is belt-and-suspenders against a future HTML emit.
  globPatterns: ['**/*.{js,css,woff,woff2,ttf,otf,eot,png,jpg,jpeg,svg,gif,webp,ico}'],
  globIgnores: ['**/index.html'],
  // Code splitting keeps chunks small, but stay generous so the largest split
  // vendor chunk is always precached - a chunk over the cap would be silently
  // skipped and break offline use.
  maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
  // No precache fallback for navigations - the runtime route below owns them.
  navigateFallback: null,
  runtimeCaching: [
    {
      // Own real navigations, but NEVER the gateway: /api (REST + the /api/ws
      // upgrade), /auth, and /login must always hit the network untouched.
      // NOTE: workbox-build stringifies this function into the generated
      // service worker, so it must stay self-contained (no outer-scope refs).
      urlPattern: ({ request, url }: { request: Request; url: URL }) =>
        request.mode === 'navigate' && !/^\/(api|auth|login)([/?]|$)/.test(url.pathname),
      handler: 'NetworkFirst',
      options: {
        cacheName: 'app-shell',
        // Slow network beats stale token: wait this long before serving the
        // cached shell so online launches always get the fresh document.
        networkTimeoutSeconds: 5
      }
    }
  ]
} satisfies Partial<GenerateSWOptions>
