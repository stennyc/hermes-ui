import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.nousresearch.hermesagent.mobile',
  appName: 'Hermes',
  webDir: 'dist',
  // CapacitorHttp routes the bridge's REST calls (login + ws-ticket) through
  // the NATIVE HTTP stack, which bypasses the browser CORS that the gateway
  // locks to localhost — the whole reason a plain PWA can't talk to a remote
  // gateway but this app can. See src/bridge/http.ts.
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    // Makes env(safe-area-inset-*) report the REAL system-bar insets on Android
    // edge-to-edge (the system WebView otherwise only reports display cutouts).
    // Used ONLY to push the titlebar below the status bar — see theme-fallback.css.
    // LIGHT = dark bar icons, matching the default light theme.
    SafeArea: {
      // Initial icon styles (before JS runs) for the default light theme: LIGHT =
      // dark icons on a light background. Both bars are re-synced at runtime to the
      // active app theme via SafeArea.setSystemBarsStyle — see native-init.ts. The
      // bar BACKGROUNDS stay transparent so the themed app background shows behind.
      statusBarStyle: 'LIGHT',
      navigationBarStyle: 'LIGHT',
    },
    // Keyboard is used only for its JS events (keyboardWillShow/Hide) and
    // Keyboard.hide() — see mobile-behaviors. The actual resize-above-keyboard is
    // done natively by Chromium on Android edge-to-edge; the SafeArea plugin is
    // patched (patches/@capacitor-community+safe-area) so it doesn't ALSO pad for
    // the IME, which used to double-collapse the viewport (innerHeight 914 → 241).
    Keyboard: {
      resize: 'none',
    },
    // Allow cleartext HTTP for local/private gateways without TLS.
    // HTTPS is recommended for public-facing gateways.
    LocalNotifications: {
      iconColor: '#5E8BFF',
      smallIcon: 'ic_stat_hermes',
    },
  },
  server: {
    // Allow both http:// and https:// gateways. For TLS-enabled gateways the
    // WebView stays on https/wss; for plain HTTP gateways it falls back to
    // http/ws. The bridge's native HTTP stack (CapacitorHttp) handles REST
    // calls through either scheme.
    androidScheme: 'http',
    iosScheme: 'http',
    cleartext: true,
  },
}

export default config
