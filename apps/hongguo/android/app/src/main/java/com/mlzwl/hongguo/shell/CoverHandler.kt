package com.mlzwl.hongguo.shell

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * `/api/cover` 端点：把上游 HEIC 封面转成 JPEG 交给页面。
 *
 * ## 为什么需要原生侧做
 *
 * 上游 `cover_url` 指向 `.heic` 文件（实测 `p3-reading-sign.fqnovelpic.com/...heic`）。
 * WebView 不解码 HEIC，`<img>` 会显示裂图。server 侧用 `heic-convert` 转码，
 * 端上没有这个库；但 Android 从 API 28 起 `BitmapFactory` 原生支持 HEIF，
 * 所以转码放在 Kotlin 侧最省事。
 *
 * ## 为什么走 asset loader 而不是 fetch
 *
 * `<img src>` 不经过 `window.fetch`，拦截不到。WebViewAssetLoader 能拦所有
 * 同源请求，`<img>` 也在内。
 *
 * ## 缓存
 *
 * 页面列表会反复请求同一批封面，所以用 LRU 缓存解码后的 JPEG 字节。
 * 上限与 server 的 `COVER_MAX_BYTES`（24 MB）对齐，但这里只算内存。
 */
class CoverHandler(
    private val transport: HttpTransport,
    private val maxBytes: Long = MAX_BYTES,
) : WebViewAssetLoader.PathHandler {

    private val tag = "HgCover"

    /** 简单的 LRU：用 LinkedHashMap 的访问顺序 + 手工淘汰。 */
    private val cache = object : LinkedHashMap<String, ByteArray>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ByteArray>?): Boolean {
            return size > MAX_ENTRIES
        }
    }
    private var cacheBytes = 0L

    override fun handle(path: String): WebResourceResponse? = null

    /**
     * 处理 `/api/cover?url=<encoded>`。
     *
     * **不要在这里再解码**：调用方传进来的已经是 `Uri.getQueryParameter` 的结果，
     * WebView 已经解过一次码。再解一次会把签名里的 `%2F` 变成 `/`，
     * CDN 校验失败直接回 403（实测踩过）。
     */
    fun handleCover(source: String?): WebResourceResponse {
        if (source.isNullOrEmpty()) {
            return error(400, "missing url")
        }
        if (!isAllowed(source)) {
            // 只允许上游封面域名，避免这个端点变成任意 URL 代理。
            return error(403, "host not allowed")
        }

        synchronized(cache) {
            cache[source]?.let { return jpegResponse(it) }
        }

        // 带上浏览器 UA：CDN 对 OkHttp 默认的 `okhttp/x.y.z` 回 403。
        val headers = org.json.JSONObject().put("user-agent", BROWSER_UA).toString()
        val downloaded = transport.execute("GET", source, headers, null)
        if (downloaded.error != null || downloaded.status !in 200..299) {
            Log.w(tag, "download failed: ${downloaded.status} ${downloaded.error}")
            return error(502, "upstream fetch failed")
        }
        val raw = Base64.decode(downloaded.bodyBase64, Base64.NO_WRAP)
        if (raw.isEmpty()) {
            return error(502, "empty cover")
        }
        if (raw.size > MAX_SOURCE_BYTES) {
            return error(502, "cover too large")
        }

        val jpeg = transcode(raw) ?: return error(502, "decode failed")
        synchronized(cache) {
            cache[source] = jpeg
            cacheBytes += jpeg.size
            // 字节上限比条目上限更早触发时，按插入顺序淘汰最旧的。
            while (cacheBytes > maxBytes && cache.isNotEmpty()) {
                val first = cache.entries.first()
                cacheBytes -= first.value.size
                cache.remove(first.key)
            }
        }
        return jpegResponse(jpeg)
    }

    /**
     * HEIC/其它格式 → JPEG。
     *
     * `BitmapFactory` 能直接解码 HEIF（API 28+）。已是 JPEG/PNG 时这里也走一遍，
     * 代价小且能统一输出格式。
     */
    private fun transcode(raw: ByteArray): ByteArray? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            Log.w(tag, "decode bounds failed: ${bounds.outWidth}x${bounds.outHeight}")
            return null
        }

        // 列表里封面显示宽度约 500px；按 2 的幂降采样，避免解码巨大原图。
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight, TARGET_PX)
        }
        val bitmap = BitmapFactory.decodeByteArray(raw, 0, raw.size, options) ?: run {
            Log.w(tag, "decode failed (HEIF unsupported?)")
            return null
        }
        return ByteArrayOutputStream().use { out ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
            bitmap.recycle()
            out.toByteArray()
        }
    }

    private fun sampleSizeFor(width: Int, height: Int, target: Int): Int {
        var sample = 1
        while (width / (sample * 2) >= target && height / (sample * 2) >= target) {
            sample *= 2
        }
        return sample
    }

    private fun jpegResponse(bytes: ByteArray): WebResourceResponse =
        WebResourceResponse(
            "image/jpeg",
            null,
            200,
            "OK",
            // 上游签名地址过期后内容不变，可以长缓存。
            mapOf("Cache-Control" to "private, max-age=86400"),
            ByteArrayInputStream(bytes),
        )

    private fun error(status: Int, message: String): WebResourceResponse =
        WebResourceResponse(
            "text/plain",
            "utf-8",
            status,
            message,
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(message.toByteArray(StandardCharsets.UTF_8)),
        )

    /** 与 server 的 `CoverProxyService` 一致：按域名后缀放行。 */
    private fun isAllowed(url: String): Boolean = HostAllowlist.allows(url, ALLOWED_SUFFIXES)

    private companion object {
        const val MAX_ENTRIES = 100
        const val MAX_BYTES = 24L * 1024 * 1024
        const val MAX_SOURCE_BYTES = 8 * 1024 * 1024
        const val TARGET_PX = 480
        const val JPEG_QUALITY = 82

        /** 伪装成 Android WebView 的 UA；CDN 对 OkHttp 默认 UA 回 403。 */
        const val BROWSER_UA =
            "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/131.0.0.0 Mobile Safari/537.36"

        /** 上游封面 CDN 的子域会变，按后缀放行（同 server 的注释）。 */
        val ALLOWED_SUFFIXES = listOf(
            "fqnovelpic.com",
            "fqnovel.com",
            "snssdk.com",
            "byteimg.com",
        )
    }
}
