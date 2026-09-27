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

        // Set WebViewClient to handle navigation
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(android.webkit.WebView view, String url) {
                // Allow all URLs to load within the WebView
                return false;
            }
            
            @Override
            public void onPageFinished(android.webkit.WebView view, String url) {
                super.onPageFinished(view, url);
                // Log navigation for debugging
                android.util.Log.d("HermesUI", "Page loaded: " + url);
            }
        });

        // Load the Gateway URL directly (not local file://)
        // This ensures same-origin for cookies and WebSocket connections
        webView.loadUrl(GATEWAY_URL);
    }
}
