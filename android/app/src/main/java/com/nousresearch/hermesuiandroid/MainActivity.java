package com.nousresearch.hermesuiandroid;

import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebViewClient;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // Gateway URL - must match the origin the app expects
    private static final String GATEWAY_URL = "http://10.1.1.117:9200";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Configure WebView settings BEFORE loading any URL
        android.webkit.WebView webView = getBridge().getWebView();
        WebSettings settings = webView.getSettings();
        
        // Enable features required for Hermes UI
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setNeedInitialFocus(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        
        // Critical: Enable JavaScript DOM storage for session persistence
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        
        // Allow mixed content (HTTP gateway on Android)
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        
        // Enable features required for Hermes UI
        settings.setSaveFormData(true);
        settings.setSavePassword(true);
        settings.setLightTouchEnabled(true);

        // Configure CookieManager for OAuth/password flows
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);

        // Android 5.0+ (API 21+): Set cookie policy to accept all cookies
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP) {
            cookieManager.setAcceptThirdPartyCookies(webView, true);
        }

        // Load the main page first
        webView.loadUrl(GATEWAY_URL);

        // Inject JavaScript to handle cross-origin API requests via a proxy pattern
        // This intercepts fetch/XHR calls and rewrites them to use same-origin proxy
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(android.webkit.WebView view, String url) {
                android.util.Log.d("HermesUI", "shouldOverride: " + url);
                return false;
            }

            @Override
            public void onPageStarted(android.webkit.WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                android.util.Log.d("HermesUI", "onPageStarted: " + url);
            }

            @Override
            public void onPageFinished(android.webkit.WebView view, String url) {
                super.onPageFinished(view, url);
                android.util.Log.d("HermesUI", "onPageFinished: " + url);

                // After login, the gateway returns JSON {"ok":true,"next":"/"}
                // instead of HTTP redirect. We need to navigate to the next page.
                if (url.contains("/auth/password-login")) {
                    // Inject JavaScript to parse the response and navigate
                    view.evaluateJavascript(
                        "(function() { " +
                        "  const originalFetch = window.fetch; " +
                        "  window.fetch = function(url, options) { " +
                        "    return originalFetch.apply(this, arguments).then(response => { " +
                        "      if (url.includes('/auth/password-login') && response.ok) { " +
                        "        return response.json().then(json => { " +
                        "          if (json.ok && json.next) { " +
                        "            window.location.href = json.next; " +
                        "          } " +
                        "        }); " +
                        "      } " +
                        "      return response; " +
                        "    }); " +
                        "  }; " +
                        "})()",
                        null
                    );
                }

                // Inject CORS proxy script to handle cross-origin requests
                // This wraps fetch to proxy through the same-origin gateway
                view.evaluateJavascript(
                    "(function() { " +
                    "  const proxyTarget = '" + GATEWAY_URL.replace("http://", "").replace("https://", "") + "'; " +
                    "  const originalFetch = window.fetch; " +
                    "  window.fetch = function(url, options) { " +
                    "    // If this is a cross-origin request to another gateway, proxy it through the current origin " +
                    "    try { " +
                    "      const targetUrl = new URL(url); " +
                    "      const currentOrigin = new URL(window.location.href).origin; " +
                    "      if (targetUrl.origin !== currentOrigin && (url.includes('/api/') || url.includes('/auth/') || url.includes('/login'))) { " +
                    "        // Rewrite to proxy through current gateway " +
                    "        const proxiedUrl = currentOrigin + url; " +
                    "        console.log('[CORS Proxy]', 'Rewriting', url, '->', proxiedUrl); " +
                    "        url = proxiedUrl; " +
                    "      } " +
                    "    } catch(e) { " +
                    "      // Invalid URL, proceed normally " +
                    "    } " +
                    "    return originalFetch.apply(this, arguments); " +
                    "  }; " +
                    "})()",
                    null
                );
            }
        });
    }
}
