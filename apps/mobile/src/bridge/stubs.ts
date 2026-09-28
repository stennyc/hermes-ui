/**
 * stubs.ts — safe no-op implementations for the parts of the window.hermesDesktop
 * contract that don't apply to a remote mobile client: local terminal (xterm),
 * self-update, uninstall, first-launch bootstrap, multi-window, local filesystem,
 * VS Code theme marketplace, etc.
 *
 * These exist so vendored desktop code that reaches for them gets a defined,
 * harmless response instead of `undefined is not a function`. Subscription-style
 * methods return a real unsubscribe.
 */

import { dataUrlForMobileFile, mobileImagePathForBytes, mobilePathForFile, selectMobilePaths, textForMobileFile } from './mobile-files'
import { logout, probeGateway, clearAllStorage, type ProbeResult } from './auth'
import { requireSecureRemoteBaseUrl, authModeFromStatus } from './connection-config'
import { currentTarget, setTarget, requireSignOut } from './state'
import { hasSession, loadCookies } from './cookie-jar'
import { $mobileDisplayScale, setMobileDisplayScale } from '~mobile/mobile-display-scale'

const noopUnsub = (): void => {}

// A tiny "already booted, nothing to do" progress object.
const readyBoot = {
  error: null,
  fakeMode: false,
  message: 'Connected',
  phase: 'ready',
  progress: 1,
  running: false,
  timestamp: 0,
}

const unsupportedWindow = { ok: false, error: 'unsupported-on-mobile' }

/** Build the stub half of the bridge. Loosely typed; install-bridge merges the
 *  real methods over it and casts the result to the contract. */
export function makeStubs() {
  return {
    revalidateConnection: async () => ({ ok: true, rebuilt: false }),
    touchBackend: async () => ({ ok: true }),

    // Multi-window → handled by in-app routing on mobile.
    openSessionWindow: async () => unsupportedWindow,
    openNewSessionWindow: async () => unsupportedWindow,

    // Session navigation — mobile handles via HashRouter
    // Must use window.location.hash directly for React Router to pick up the route
    openSession: async (storedSessionId: string, _options?: unknown) => {
      console.log(`[openSession] Opening session: ${storedSessionId}`)
      const encodedId = encodeURIComponent(storedSessionId)
      // React Router v8 reads location.pathname from the hash portion
      // Direct assignment triggers the router's internal listener
      window.location.hash = `/${encodedId}`
      // Force React Router state update by dispatching synthetic popstate event
      setTimeout(() => {
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
      }, 100)
      return
    },

    // Boot / bootstrap: there is no local backend to install on a phone.
    getBootProgress: async () => readyBoot,
    onBootProgress: () => noopUnsub,
    getBootstrapState: async () => ({
      active: false,
      manifest: null,
      stages: {},
      error: null,
      log: [],
      startedAt: null,
      completedAt: null,
      unsupportedPlatform: null,
    }),
    resetBootstrap: async () => ({ ok: true }),
    repairBootstrap: async () => ({ ok: true }),
    cancelBootstrap: async () => ({ ok: true, cancelled: false }),
    onBootstrapEvent: () => noopUnsub,

    // Connection-config UI (desktop Settings → Gateway). Mobile owns its own
    // connect/login screens, so these return inert defaults.
    getConnectionConfig: async () => {
      const target = currentTarget()
      return {
        envOverride: false,
        mode: 'remote' as const,
        profile: null,
        remoteAuthMode: target?.authMode ?? 'oauth' as const,
        remoteOauthConnected: target !== null,
        remoteTokenPreview: target?.token ? target.token.slice(0, 8) + '...' : null,
        remoteTokenSet: target?.authMode === 'token' && Boolean(target.token),
        remoteUrl: target?.baseUrl ?? '',
      }
    },
    saveConnectionConfig: async (p: unknown) => {
      // Parse and persist connection config
      const params = p as { mode?: string; remoteUrl?: string; remoteAuthMode?: string; remoteToken?: string }
      if (params.remoteUrl) {
        try {
          const baseUrl = requireSecureRemoteBaseUrl(params.remoteUrl)
          await setTarget({
            baseUrl,
            authMode: (params.remoteAuthMode as 'oauth' | 'token') ?? 'oauth',
            provider: null,
            token: params.remoteToken || null,
          })
        } catch {
          // Invalid URL - return as-is, mobile will show error
        }
      }
      // Return a proper GatewaySettingsState-like object with all required fields
      return {
        envOverride: false,
        mode: (params.mode as 'local' | 'remote' | 'cloud' | 'ssh') ?? 'remote',
        profile: null,
        remoteAuthMode: (params.remoteAuthMode as 'oauth' | 'token') ?? 'oauth',
        remoteOauthConnected: true,
        remoteTokenPreview: params.remoteToken ? params.remoteToken.slice(0, 8) + '...' : null,
        remoteTokenSet: params.remoteAuthMode === 'token' && Boolean(params.remoteToken),
        secureTokenStorage: true,
        remoteUrl: params.remoteUrl ?? '',
        cloudOrg: '',
        sshHost: '',
        sshUser: '',
        sshPort: null,
        sshKeyPath: '',
        sshRemoteHermesPath: '',
        sshRemoteProfile: '',
      }
    },
    applyConnectionConfig: async (p: unknown) => {
      // Save and apply (connect to) the config
      const params = p as { mode?: string; remoteUrl?: string; remoteAuthMode?: string; remoteToken?: string }
      if (params.remoteUrl) {
        try {
          const baseUrl = requireSecureRemoteBaseUrl(params.remoteUrl)
          await setTarget({
            baseUrl,
            authMode: (params.remoteAuthMode as 'oauth' | 'token') ?? 'oauth',
            provider: null,
            token: params.remoteToken || null,
          })
        } catch {
          // Invalid URL
        }
      }
      // Return a proper GatewaySettingsState-like object
      return {
        envOverride: false,
        mode: (params.mode as 'local' | 'remote' | 'cloud' | 'ssh') ?? 'remote',
        profile: null,
        remoteAuthMode: (params.remoteAuthMode as 'oauth' | 'token') ?? 'oauth',
        remoteOauthConnected: true,
        remoteTokenPreview: params.remoteToken ? params.remoteToken.slice(0, 8) + '...' : null,
        remoteTokenSet: params.remoteAuthMode === 'token' && Boolean(params.remoteToken),
        secureTokenStorage: true,
        remoteUrl: params.remoteUrl ?? '',
        cloudOrg: '',
        sshHost: '',
        sshUser: '',
        sshPort: null,
        sshKeyPath: '',
        sshRemoteHermesPath: '',
        sshRemoteProfile: '',
      }
    },
    testConnectionConfig: async (p: unknown) => {
      const params = p as { mode?: string; remoteUrl?: string; remoteAuthMode?: string }
      const url = params.remoteUrl?.trim()
      if (!url) return { baseUrl: '', ok: false, version: null, reachable: false, error: 'No URL provided' }
      try {
        const probe = await probeGateway(url)
        return {
          baseUrl: probe.baseUrl,
          ok: probe.reachable,
          version: probe.version,
          reachable: probe.reachable,
          error: probe.error,
        }
      } catch (e) {
        return { baseUrl: url, ok: false, version: null, reachable: false, error: (e as Error).message }
      }
    },
    probeConnectionConfig: async (remoteUrl: string) => {
      try {
        const probe = await probeGateway(remoteUrl)
        return {
          baseUrl: probe.baseUrl,
          reachable: probe.reachable,
          authMode: probe.authMode as 'oauth' | 'token',
          providers: probe.providers,
          version: probe.version,
          error: probe.error,
        }
      } catch (e) {
        return {
          baseUrl: remoteUrl,
          reachable: false,
          authMode: 'oauth' as const,
          providers: [],
          version: null,
          error: (e as Error).message,
        }
      }
    },
    oauthLoginConnectionConfig: async (remoteUrl: string) => {
      console.log(`[oauthLogin] Processing login for: ${remoteUrl}`)
      try {
        const baseUrl = requireSecureRemoteBaseUrl(remoteUrl)
        await loadCookies(baseUrl)
        const hasValidSession = hasSession(baseUrl)
        console.log(`[oauthLogin] Session exists: ${hasValidSession}`)

        if (hasValidSession) {
          await setTarget({ baseUrl, authMode: 'oauth', provider: null, token: null })
          console.log(`[oauthLogin] Target set successfully`)
          return { ok: true, baseUrl, connected: true }
        } else {
          console.warn(`[oauthLogin] No valid session found`)
          return { ok: false, baseUrl, connected: false, error: 'No session after login' }
        }
      } catch (e) {
        console.error(`[oauthLogin] Error:`, e)
        return { ok: false, baseUrl: remoteUrl, connected: false, error: (e as Error).message }
      }
    },
    oauthLogoutConnectionConfig: async (remoteUrl?: string) => {
      // Clear both server-side session and local cookie jar
      const baseUrl = remoteUrl || currentTarget()?.baseUrl
      if (baseUrl) {
        await logout(baseUrl).catch(() => { /* best-effort */ })
      }
      // Clear ALL app data to prevent stale state
      await clearAllStorage()
      // Clear the persisted target so the app returns to connect screen
      await setTarget(null)
      // Trigger sign out event for navigation
      requireSignOut()
      return { ok: true, connected: false }
    },

    // Zoom — bridge to mobile display scale system.
    // Desktop uses window zoom (Electron IPC); mobile uses CSS custom properties.
    zoom: {
      get: async () => {
        const current = $mobileDisplayScale.get()
        return { percent: Math.round(current.overall * 100) }
      },
      setPercent: async (percent: number) => {
        const clamped = Math.min(120, Math.max(85, percent)) / 100
        setMobileDisplayScale({ overall: clamped })
      },
      onChanged: (callback: (_: { percent: number }) => void) => noopUnsub,
    },

    profile: {
      get: async () => ({ profile: null }),
      set: async () => ({ profile: null }),
    },

    requestMicrophoneAccess: async () => true,
    requestNotificationPermission: async () => false,
    capturePhoto: async () => null,

    // The phone never exposes arbitrary local paths. It can still attach the
    // exact bytes a user chose through Android's system document/photo picker.
    readFileDataUrl: dataUrlForMobileFile,
    readFileDataUrlForAttach: dataUrlForMobileFile,
    readFileText: async (filePath: string) => ({ path: filePath, text: await textForMobileFile(filePath) }),
    selectPaths: selectMobilePaths,
    readDir: async () => ({ entries: [] }),
    getPathForFile: (file: File) => mobilePathForFile(file),
    sanitizeWorkspaceCwd: async (cwd?: null | string) => ({ cwd: cwd ?? '', sanitized: false }),

    // Images selected from Android's gallery/file picker keep their exact bytes
    // in the same process-local attachment store as ordinary documents.
    saveImageFromUrl: async () => false,
    saveImageBuffer: async (data: ArrayBuffer | Uint8Array, ext: string) => mobileImagePathForBytes(data, ext),
    saveClipboardImage: async () => '',

    // Link / preview helpers.
    fetchLinkTitle: async () => '',
    normalizePreviewTarget: async () => null,
    watchPreviewFile: async (url: string) => ({ id: '', path: url }),
    stopPreviewFileWatch: async () => true,
    onPreviewFileChanged: () => noopUnsub,
    onClosePreviewRequested: () => noopUnsub,

    settings: {
      getDefaultProjectDir: async () => ({ defaultLabel: '', dir: null, resolvedCwd: '' }),
      pickDefaultProjectDir: async () => ({ canceled: true, dir: null }),
      setDefaultProjectDir: async (dir: null | string) => ({ dir }),
    },

    revealLogs: async () => ({ ok: false, path: '', error: 'unsupported-on-mobile' }),
    getRecentLogs: async () => ({ path: '', lines: [] as string[] }),

    // Local PTY terminal — not ported to mobile.
    terminal: {
      dispose: async () => true,
      onData: () => noopUnsub,
      onExit: () => noopUnsub,
      resize: async () => true,
      start: async () => ({ cwd: '', id: '', shell: '' }),
      write: async () => true,
    },

    onBackendExit: () => noopUnsub,

    getVersion: async () => ({
      appVersion: '0.0.1',
      electronVersion: '',
      nodeVersion: '',
      platform: 'capacitor',
      hermesRoot: '',
    }),

    updates: {
      check: async () => ({ supported: false, reason: 'managed-on-server' }),
      apply: async () => ({ ok: false, error: 'managed-on-server' }),
      getBranch: async () => ({ branch: '' }),
      setBranch: async (name: string) => ({ branch: name }),
      onProgress: () => noopUnsub,
    },

    uninstall: {
      summary: async () => ({
        hermes_home: '',
        agent_installed: false,
        gui_installed: false,
        source_built_artifacts: [],
        packaged_app_paths: [],
        userdata_dir: '',
        userdata_exists: false,
        platform: 'capacitor',
      }),
      run: async () => ({ ok: false, error: 'unsupported-on-mobile' }),
    },

    themes: {
      fetchMarketplace: async (id: string) => ({ extensionId: id, displayName: '', themes: [] }),
      searchMarketplace: async () => [],
    },
  }
}
