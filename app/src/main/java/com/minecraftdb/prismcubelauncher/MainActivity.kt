package com.minecraftdb.prismcubelauncher

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Toast
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : Activity() {
    companion object {
        private const val TAG = "PrismCubeWebView"
        private const val APP_ASSETS_ORIGIN = "https://appassets.androidplatform.net"
        private const val ENTRY_URL =
            "https://appassets.androidplatform.net/assets/hbui/index.html"
        private const val DOUBLE_BACK_MS = 2_000L
    }

    private lateinit var webView: WebView
    private var backPressedAt = 0L
    private var shellReadySent = false

    // /assets/hbui/... is resolved from the packaged app assets/hbui/... tree.
    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Required for chrome://inspect and WebView DevTools.
        WebView.setWebContentsDebuggingEnabled(true)

        webView = WebView(this)
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        setContentView(webView)

        configureWebView()
        webView.addJavascriptInterface(OreUIBridge(), "AndroidBridge")

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(ENTRY_URL)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            loadsImagesAutomatically = true
            blockNetworkImage = false
            blockNetworkLoads = false

            // Local pages are served through WebViewAssetLoader, not file://.
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false

            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
            textZoom = 100
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            offscreenPreRaster = true
        }

        if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) {
            WebSettingsCompat.setSafeBrowsingEnabled(webView.settings, true)
        }

        webView.setBackgroundColor(Color.rgb(49, 50, 51))
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        webView.overScrollMode = View.OVER_SCROLL_NEVER
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.requestFocus()

        webView.webViewClient = OreUIViewClient()
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d(
                    TAG,
                    "[${message.messageLevel()}] ${message.message()} " +
                        "@${message.sourceId()}:${message.lineNumber()}"
                )
                return true
            }
        }
    }

    private inner class OreUIViewClient : WebViewClientCompat() {
        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest
        ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

        override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest
        ): Boolean {
            val uri = request.url ?: return true
            if (isAppAssetsUrl(uri)) return false

            return when (uri.scheme?.lowercase()) {
                "http", "https" -> openExternal(uri)
                else -> {
                    Log.w(TAG, "Blocked unsupported URL: $uri")
                    true
                }
            }
        }

        override fun onPageFinished(view: WebView, url: String) {
            super.onPageFinished(view, url)
            if (!shellReadySent && url.startsWith(APP_ASSETS_ORIGIN)) {
                shellReadySent = true
                sendShellReady()
            }
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceError
        ) {
            super.onReceivedError(view, request, error)
            if (request.isForMainFrame) {
                Log.e(TAG, "Main frame failed: ${error.errorCode} ${error.description}")
                showToast("页面加载失败：${error.errorCode}")
            }
        }
    }

    private fun isAppAssetsUrl(uri: Uri): Boolean {
        return uri.scheme.equals("https", ignoreCase = true) &&
            uri.host.equals("appassets.androidplatform.net", ignoreCase = true)
    }

    private fun openExternal(uri: Uri): Boolean {
        return try {
            val intent = Intent(Intent.ACTION_VIEW, uri)
                .addCategory(Intent.CATEGORY_BROWSABLE)
            startActivity(intent)
            true
        } catch (_: ActivityNotFoundException) {
            showToast("没有可以打开链接的应用")
            true
        }
    }

    /** Demonstrates Kotlin -> Web communication through evaluateJavascript. */
    private fun sendShellReady() {
        val args = JSONArray().put(
            JSONObject()
                .put("platform", "Android")
                .put("entry", ENTRY_URL)
                .put("timestamp", System.currentTimeMillis())
        )
        val message = JSONObject()
            .put("type", "engine.event")
            .put("name", "android.shell.ready")
            .put("args", args)
        postToWeb(message)
    }

    private fun postToWeb(message: JSONObject) {
        if (!::webView.isInitialized) return

        val javascript =
            "window.OreUIWebView && window.OreUIWebView.receive(" +
                JSONObject.quote(message.toString()) + ");"

        webView.post {
            webView.evaluateJavascript(javascript) { result ->
                Log.d(TAG, "evaluateJavascript result: $result")
            }
        }
    }

    private inner class OreUIBridge {
        @JavascriptInterface
        fun showToast(message: String) {
            this@MainActivity.showToast(message)
        }

        @JavascriptInterface
        fun getWorlds(): String = "[]"

        /**
         * Keep the generic channel used by webview-adapter.js. Return a JSON
         * envelope such as {"result":...} for synchronous native data; return
         * null to keep the frontend's structured fallback data. Async JNI/Rust
         * completions should call postToWeb() on the Android UI thread.
         */
        @JavascriptInterface
        fun dispatch(requestJson: String): String? {
            Log.d(TAG, "OreUI native request: $requestJson")
            // TODO: Forward requestJson through JNI to Rust when native code lands.
            return null
        }
    }

    private fun showToast(message: CharSequence) {
        runOnUiThread {
            Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
        }
    }

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
            return
        }

        val now = System.currentTimeMillis()
        if (now - backPressedAt <= DOUBLE_BACK_MS) {
            super.onBackPressed()
        } else {
            backPressedAt = now
            Toast.makeText(this, "再按一次退出", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) webView.onResume()
    }

    override fun onPause() {
        if (::webView.isInitialized) webView.onPause()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::webView.isInitialized) webView.saveState(outState)
    }

    override fun onDestroy() {
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface("AndroidBridge")
            webView.stopLoading()
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        }
        super.onDestroy()
    }
}
