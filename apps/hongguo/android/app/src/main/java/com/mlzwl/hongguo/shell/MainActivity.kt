package com.mlzwl.hongguo.shell

import android.annotation.SuppressLint
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * WebView 壳：托管 web/dist 静态资源，并把 HTTP 请求桥接给原生 OkHttp。
 *
 * 资源用 WebViewAssetLoader 映射到 https://appassets.androidplatform.net/，
 * 因此 web/dist/index.html 里的绝对路径 assets 引用无需改动即可命中。
 * 若改用 file:// 加载，绝对路径会全部 404。
 */
class MainActivity : AppCompatActivity() {

    private val tag = "HgShell"
    private val transport = HttpTransport()
    private val io = Executors.newFixedThreadPool(4)
    private lateinit var downloads: DownloadHandler

    private lateinit var webView: WebView
    private lateinit var root: ViewGroup

    /** DOM 全屏期间承载 WebView 自定义视图的容器；非全屏时为 null。 */
    private var customView: View? = null
    private var customViewCallback: android.webkit.WebChromeClient.CustomViewCallback? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 用 FrameLayout 包一层：进入 DOM 全屏时要把 WebView 的 custom view
        // 提到全屏容器里，退出时再摘掉。直接 setContentView(webView) 无处安放。
        root = android.widget.FrameLayout(this)
        webView = WebView(this)
        root.addView(
            webView,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        setContentView(root)

        /*
         * 把状态栏与导航栏的尺寸交给页面自己排版。
         *
         * ## 不处理会怎样
         *
         * `targetSdk = 36`。Android 15（API 35）起，`targetSdk >= 35` 的应用
         * 强制 edge-to-edge：窗口默认铺满整屏，**绘制到状态栏后面**。
         * 实测（1080x2400 / 420dpi）：`header` 的 `getBoundingClientRect().top`
         * 为 0，标题被状态栏压住。
         *
         * ## 为什么不能只靠页面
         *
         * 页面已经写了 `viewport-fit=cover` 和 `padding-top: env(safe-area-inset-top)`
         * （`web/src/styles/index.css:177`），这是移动端 Chrome 的正确写法。
         * 但实测 `env(safe-area-inset-top)` 返回 **0**：WebView 只有在宿主
         * 明确声明「内容延伸到系统栏」时才向页面报告安全区，否则一律报 0。
         * 所以这个 padding 在壳里等于没写。
         *
         * ## 做法
         *
         * `setDecorFitsSystemWindows(false)` 让 WebView 拿到真实安全区，
         * 页面自己的 `env(safe-area-inset-*)` 就能生效。这样不用在原生侧写死
         * 一个状态栏高度，也不用改 `web/src`（本轮约束禁止改）。
         *
         * 全屏时 `enterImmersive()` 会隐藏系统栏，安全区自动变 0，页面铺满——
         * 不需要额外分支。
         */
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // WASM 侧用 localStorage 存设备档案
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            // 视口：不设的话 WebView 默认 980px 宽布局视口，页面会被缩小成
            // 桌面样式，触摸热区全部错位。这三项是移动端页面的前提。
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
        }
        WebView.setWebContentsDebuggingEnabled(true)

        // 注入 /api/* 适配层：把页面发出的请求转成 WASM SDK 调用。
        //
        // 顺序关键：`wasm_exec.js` 先定义 `globalThis.Go`，`hg-adapter.js` 才能启动
        // WASM。两个都是普通脚本（非 module），同步执行，因此能赶在页面 bundle 之前。
        val injectScript = "<script src=\"/wasm_exec.js\"></script>" +
            "<script src=\"/hg-mp4.js\"></script>" +
            "<script src=\"/hg-cenc.js\"></script>" +
            "<script src=\"/hg-adapter.js\"></script>"

        // 封面要转码（上游是 HEIC，WebView 不解码），必须由原生侧处理。
        // `<img src>` 不经过 window.fetch，所以拦在 shouldInterceptRequest。
        val covers = CoverHandler(transport)
        val videos = VideoProxyHandler(transport)
        val sprites = SpriteHandler(transport)
        downloads = DownloadHandler(this)
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", InjectingAssetHandler(this, injectScript))
            .build()

        webView.webViewClient = object : android.webkit.WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                // `/api/cover/<base64url>`：不走 asset loader，PathHandler 拿不到
                // 完整路径段。
                //
                // 两种形式都要支持：
                // - 路径令牌（当前格式，与 `shared` 的 `isCoverProxyUrl` 一致）
                // - `?url=`（旧格式，`localStorage` 里可能还留着，保留一段兼容）
                if (request.url.path?.startsWith("/api/cover") == true) {
                    val token = request.url.path?.removePrefix("/api/cover/")?.takeIf {
                        it.isNotEmpty() && it != "/api/cover"
                    }
                    val source = if (token != null) {
                        decodeCoverToken(token)
                    } else {
                        request.url.getQueryParameter("url")
                    }
                    return covers.handleCover(source)
                }
                // 视频 CDN 对 WebView 的 fetch 回 403，必须由原生侧取字节。
                if (request.url.path == "/api/video") {
                    return videos.handleVideo(request.url.getQueryParameter("url"), cacheDir)
                }
                // 雪碧图是 HEIC，`background-image` 不解码，必须转 JPEG。
                // 与 `/api/cover` 分两个处理器：这里不能降采样。
                if (request.url.path == "/api/sprite-sheet") {
                    return sprites.handleSheet(request.url.getQueryParameter("url"))
                }
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun onPageFinished(view: WebView, url: String) {
                Log.i(tag, "page finished: $url")
            }
        }

        webView.webChromeClient = object : android.webkit.WebChromeClient() {
            override fun onConsoleMessage(msg: android.webkit.ConsoleMessage): Boolean {
                // 把页面 console 转到 logcat，便于无 GUI 时取证。
                Log.i("HgConsole", "${msg.messageLevel()} ${msg.message()} @${msg.lineNumber()}")
                return true
            }

            /**
             * DOM 全屏入口。
             *
             * 不实现这个方法时，页面的 `Element.requestFullscreen()` 会直接抛
             * `TypeError: Fullscreen is not supported`——WebView 只有在宿主
             * 实现了这个回调时才向页面暴露 Fullscreen API。所以「点全屏无效」
             * 的根因在宿主，不在页面。
             */
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) {
                    callback.onCustomViewHidden()
                    return
                }
                Log.i(tag, "enter fullscreen")
                customView = view
                customViewCallback = callback
                root.addView(
                    view,
                    ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
                )
                webView.visibility = View.GONE
                // 页面会在全屏后自己调 screen.orientation.lock('landscape')。
                // WebView 的 orientation lock 走宿主 Activity 的屏幕方向，
                // 需要允许 Activity 随传感器旋转才能生效（见 manifest 的
                // configChanges + screenOrientation="fullSensor"）。
                enterImmersive()
            }

            override fun onHideCustomView() {
                Log.i(tag, "exit fullscreen")
                val view = customView ?: return
                root.removeView(view)
                customView = null
                customViewCallback?.onCustomViewHidden()
                customViewCallback = null
                webView.visibility = View.VISIBLE
                exitImmersive()
            }
        }

        // 返回键：全屏时先退全屏，其次交给 WebView 历史，最后才退出应用。
        // 不接管的话按返回键会直接结束 Activity，页面路由历史全丢。
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (customView != null) {
                        webView.webChromeClient?.onHideCustomView()
                        return
                    }
                    if (webView.canGoBack()) {
                        webView.goBack()
                        return
                    }
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            },
        )

        installBridge(webView)

        val target = intent?.getStringExtra("target")
        // probe / origin-test 等探针页都从 assets 加载；不传 target 时走正式入口。
        val url = if (target != null) {
            "https://appassets.androidplatform.net/$target.html"
        } else {
            BuildConfig.SHELL_START_URL
        }
        Log.i(tag, "loading $url")
        webView.loadUrl(url)
    }

    /**
     * 注册 JS 与 Kotlin 的消息通道。
     *
     * 消息是异步的，因此用自增 id 做请求/响应配对：JS 侧维护 id -> resolve 的表。
     * 通道名 hgBridge 与 probe.html 里的用法必须一致。
     */
    private fun installBridge(webView: WebView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Log.e(tag, "WEB_MESSAGE_LISTENER unsupported; transport bridge disabled")
            return
        }
        val allowed = setOf("https://appassets.androidplatform.net")
        WebViewCompat.addWebMessageListener(
            webView,
            "hgBridge",
            allowed,
            object : WebViewCompat.WebMessageListener {
                override fun onPostMessage(
                    view: WebView,
                    message: WebMessageCompat,
                    sourceOrigin: android.net.Uri,
                    isMainFrame: Boolean,
                    replyProxy: androidx.webkit.JavaScriptReplyProxy,
                ) {
                    val data = message.data ?: return
                    io.execute {
                        val reply = handleBridgeMessage(data)
                        replyProxy.postMessage(reply)
                    }
                }
            },
        )
    }

    /** 处理一条桥接消息，返回要回传的 JSON 字符串。 */
    private fun handleBridgeMessage(data: String): String {
        return try {
            val req = JSONObject(data)
            val id = req.optInt("id", -1)
            // 下载落盘不是 HTTP 请求：页面的 `<a download>` 在 WebView 里
            // 不会触发 DownloadListener，blob URL 也不会。这里单独走三段式命令，
            // 避免 39 MB 视频一次 base64 过桥导致 OOM。
            val op = req.optString("op")
            if (op == "downloadBegin") {
                return JSONObject().apply {
                    put("id", id)
                    put("token", downloads.begin())
                }.toString()
            }
            if (op == "downloadChunk") {
                val written = downloads.appendChunk(req.optString("token"), req.optString("chunk"))
                return JSONObject().apply {
                    put("id", id)
                    put("written", written)
                }.toString()
            }
            if (op == "downloadFinish") {
                val outcome = downloads.finish(req.optString("token"), req.optString("displayName"))
                return JSONObject().apply {
                    put("id", id)
                    outcome.uri?.let { put("uri", it) }
                    put("bytes", outcome.bytes)
                    outcome.error?.let { put("error", it) }
                }.toString()
            }
            if (op == "downloadCancel") {
                return JSONObject().apply {
                    put("id", id)
                    put("cancelled", downloads.cancel(req.optString("token")))
                }.toString()
            }
            val result = transport.execute(
                method = req.optString("method", "GET"),
                url = req.getString("url"),
                headersJson = req.optString("headers", "{}"),
                bodyBase64 = req.optString("bodyBase64").ifEmpty { null },
            )
            JSONObject().apply {
                put("id", id)
                put("status", result.status)
                put("headers", JSONObject(result.headersJson))
                put("cookies", JSONObject(result.cookiesJson))
                put("bodyBase64", result.bodyBase64)
                result.error?.let { put("error", it) }
            }.toString()
        } catch (e: Throwable) {
            Log.e(tag, "bridge error: ${e.message}")
            JSONObject().apply {
                put("id", -1)
                put("error", e.message ?: e::class.java.simpleName)
            }.toString()
        }
    }

    /**
     * 全屏时隐藏状态栏与导航栏。
     *
     * 用 `WindowInsetsController` 而不是已废弃的 `systemUiVisibility`。
     * `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` 让用户仍能从边缘划出系统栏。
     */
    private fun enterImmersive() {
        /*
         * 页面在全屏后会调 `screen.orientation.lock('landscape')`。
         * Android WebView 不实现这个 API：实测抛
         * `NotSupportedError: screen.orientation.lock() is not available on this device.`
         * 移动端 Chrome 上它是可用的，因此壳必须自己把屏幕转成横屏，
         * 否则「全屏」只剩竖屏满屏，16:9 视频上下带大黑边。
         *
         * 用 SENSOR_LANDSCAPE 而不是 LANDSCAPE：允许用户在两个横屏方向之间
         * 翻转，与 Chrome 的 lock('landscape') 行为一致。
         */
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        window.statusBarColor = Color.BLACK
        window.navigationBarColor = Color.BLACK
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            window.insetsController?.let { controller ->
                controller.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                controller.systemBarsBehavior =
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        }
    }

    /** 退出全屏：恢复系统栏与竖屏。 */
    private fun exitImmersive() {
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            window.insetsController?.show(
                WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars(),
            )
        }
    }

    /**
     * 退出时释放 WebView。
     *
     * 不调 `webView.destroy()` 时，WebView 内部的渲染进程、定时器与
     * `WebMessageListener` 都会跟着 Activity 泄漏；旋转或重入时新旧两个 WebView
     * 同时活着，内存会翻倍。
     *
     * 顺序：先从视图树里摘掉，再 `destroy()`，最后停执行器。反过来会让正在跑
     * 的 `shouldInterceptRequest` 向已销毁的 WebView 写数据。
     */
    /**
     * 解析封面路径令牌（base64url，无填充）→ 上游地址。
     *
     * 与适配层 `base64UrlEncode()` 对应：那里是 `btoa` 后把 `+` 换成 `-`、
     * `/` 换成 `_`、去掉 `=`。这里反过来。
     *
     * 解析失败一律返回 `null`，由 `CoverHandler` 回 400。**不抛异常**：
     * 令牌来自页面，任何脏值都不该让拦截器崩掉。
     *
     * 安全边界：这里只做解码，不做域名校验。真正的白名单检查在
     * `CoverHandler.isAllowed()` 里，解码后的地址仍然要过那道关。
     */
    private fun decodeCoverToken(token: String): String? {
        return try {
            val normalized = token.replace('-', '+').replace('_', '/')
            // 补回 base64 的 `=` 填充：长度不是 4 的倍数时 `Base64.decode` 会失败。
            val padded = when (normalized.length % 4) {
                2 -> "$normalized=="
                3 -> "$normalized="
                0 -> normalized
                else -> return null
            }
            val bytes = android.util.Base64.decode(padded, android.util.Base64.DEFAULT)
            String(bytes, Charsets.UTF_8)
        } catch (e: Exception) {
            Log.w(tag, "cover token decode failed: ${e.message}")
            null
        }
    }

    override fun onDestroy() {
        if (::webView.isInitialized) {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.stopLoading()
            webView.loadUrl("about:blank")
            webView.clearHistory()
            webView.removeAllViews()
            webView.destroy()
        }
        io.shutdown()
        super.onDestroy()
    }
}
