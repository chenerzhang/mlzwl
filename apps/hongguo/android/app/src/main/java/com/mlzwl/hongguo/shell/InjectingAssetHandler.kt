package com.mlzwl.hongguo.shell

import android.content.Context
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.nio.charset.StandardCharsets

/**
 * 托管 `web/dist` 静态资源，并在 `index.html` 的 `<head>` 最前面注入适配层脚本。
 *
 * ## 为什么必须注入到 `<head>` 最前
 *
 * `web/dist/index.html` 的 app bundle 是 `<script type="module" src="/assets/index-*.js">`。
 * ES module 是延迟执行的，但它内部的 `import` 链会立刻开始加载，而 `api-client.ts`
 * 在**模块顶层**就取了 `fetch`。如果注入脚本晚于 app bundle，页面可能已经发出了
 * 第一个 `/api/feed` 请求，那个请求会打到不存在的路径上。
 *
 * 把注入脚本放在 `<head>` 第一行、并且**不是 module**（普通脚本同步执行），
 * 就能保证它在任何 module 之前跑完。
 *
 * ## 为什么在 Kotlin 侧改写，而不是让前端配合
 *
 * 约束要求不改 `web/src` 与 vite 配置。改写发生在 `shouldInterceptRequest`，
 * 对页面透明。
 */
class InjectingAssetHandler(
    private val context: Context,
    private val injectScript: String,
) : WebViewAssetLoader.PathHandler {

    /** 真正的 assets 读取器。除 `index.html` 外全部走它。 */
    private val assets = WebViewAssetLoader.AssetsPathHandler(context)

    override fun handle(path: String): WebResourceResponse? {
        if (!isIndex(path)) {
            return assets.handle(path)
        }

        val html = readAsset(INDEX_ASSET)
        if (html == null) {
            // 读不到就退回原样，让页面自己报 404，不要在壳里编造响应。
            return assets.handle(path)
        }

        val patched = inject(html)
        return WebResourceResponse(
            "text/html",
            "utf-8",
            200,
            "OK",
            // 每次启动都可能换脚本内容，不要缓存。
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(patched.toByteArray(StandardCharsets.UTF_8)),
        )
    }

    private fun isIndex(path: String): Boolean {
        // AssetLoader 会把 `/` 与 `/index.html` 都映射到 index.html。
        val normalized = path.trimStart('/')
        return normalized.isEmpty() || normalized == INDEX_ASSET
    }

    private fun readAsset(name: String): String? =
        try {
            context.assets.open(name).use { it.readBytes().toString(StandardCharsets.UTF_8) }
        } catch (e: Exception) {
            null
        }

    /**
     * 把脚本插到 `<head>` 之后的第一行。
     *
     * 用字符串查找而不是正则：index.html 是 vite 生成的固定结构，找 `<head>` 足够，
     * 正则在这里只会增加出错面。
     */
    private fun inject(html: String): String {
        val marker = "<head>"
        val index = html.indexOf(marker)
        if (index < 0) {
            return html
        }
        val at = index + marker.length
        return html.substring(0, at) + injectScript + html.substring(at)
    }

    private companion object {
        const val INDEX_ASSET = "index.html"
    }
}
