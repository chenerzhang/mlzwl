package com.mlzwl.hongguo.shell

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/**
 * `/api/sprite-sheet` 端点：把上游 HEIC 雪碧图转成 JPEG 交给页面。
 *
 * ## 为什么需要原生侧做
 *
 * 进度条缩略图来自上游 `big_thumbs[0].img_urls`，指向 `.heic` 文件。
 * 前端 `sprite-preview.tsx` 用 `background-image` + `background-position`
 * 裁剪出单帧，而 **`background-image` 不解码 HEIC**（`<img>` 在某些 WebView
 * 版本能解码，但背景图不行）。所以必须转成 JPEG。
 *
 * ## 与 `CoverHandler` 的区别
 *
 * **不能复用 `CoverHandler`**：它按 `TARGET_PX=480` 降采样，因为封面只需要
 * 列表缩略尺寸。雪碧图是 `gridX × gridY` 格的拼图，降采样会让每格变小、
 * 且 `background-size` 是按原始像素算的，降采样后裁剪位置全错。
 * 这里保持原始分辨率，只做格式转换。
 *
 * ## 缓存
 *
 * 单张雪碧图实测 1–6 张不等，每张最大几 MB。转码后的 JPEG 按 32 MB 上限
 * LRU 缓存：同一集拖进度条会反复取同一张图。
 */
class SpriteHandler(
    private val transport: HttpTransport,
    private val maxBytes: Long = MAX_BYTES,
) {
    private val tag = "HgSprite"

    /** 按上游地址缓存转码后的 JPEG 字节。 */
    private val cache = object : LinkedHashMap<String, ByteArray>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ByteArray>?): Boolean {
            return size > MAX_ENTRIES
        }
    }
    private var cacheBytes = 0L

    /**
     * 处理 `/api/sprite-sheet?url=<encoded>`。
     *
     * **不要在这里再解码**：与 `/api/cover` 同理，`Uri.getQueryParameter`
     * 已经解过一次码，再解会把签名里的 `%2F` 变成 `/`，CDN 校验失败回 403。
     */
    fun handleSheet(source: String?): WebResourceResponse {
        if (source.isNullOrEmpty()) {
            return error(400, "missing url")
        }
        if (!isAllowed(source)) {
            return error(403, "host not allowed")
        }

        synchronized(cache) {
            cache[source]?.let { return jpegResponse(it) }
        }

        val headers = org.json.JSONObject().put("user-agent", BROWSER_UA).toString()
        val downloaded = transport.execute("GET", source, headers, null)
        if (downloaded.error != null || downloaded.status !in 200..299) {
            Log.w(tag, "download failed: ${downloaded.status} ${downloaded.error}")
            return error(502, "upstream fetch failed")
        }
        val raw = Base64.decode(downloaded.bodyBase64, Base64.NO_WRAP)
        if (raw.isEmpty()) {
            return error(502, "empty sheet")
        }
        if (raw.size > MAX_SOURCE_BYTES) {
            Log.w(tag, "sheet too large: ${raw.size}")
            return error(502, "sheet too large")
        }

        val jpeg = transcode(raw) ?: return error(502, "decode failed")
        synchronized(cache) {
            cache[source] = jpeg
            cacheBytes += jpeg.size
            while (cacheBytes > maxBytes && cache.isNotEmpty()) {
                val first = cache.entries.first()
                cacheBytes -= first.value.size
                cache.remove(first.key)
            }
        }
        return jpegResponse(jpeg)
    }

    /**
     * HEIC → JPEG，**不降采样**。
     *
     * `inSampleSize` 保持 1。雪碧图的格宽高是固定的（实测 240x136），
     * 降采样会让前端按 `gridX * cellWidth` 算出的 `background-size` 与实际
     * 图片尺寸不符，裁剪窗口偏移。
     */
    private fun transcode(raw: ByteArray): ByteArray? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            Log.w(tag, "decode bounds failed: ${bounds.outWidth}x${bounds.outHeight}")
            return null
        }

        val bitmap = BitmapFactory.decodeByteArray(raw, 0, raw.size) ?: run {
            Log.w(tag, "decode failed (HEIF unsupported?)")
            return null
        }
        val jpeg = ByteArrayOutputStream().use { out ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
            bitmap.recycle()
            out.toByteArray()
        }
        Log.d(tag, "transcoded ${bounds.outWidth}x${bounds.outHeight} -> ${jpeg.size}B")
        return jpeg
    }

    private fun jpegResponse(bytes: ByteArray): WebResourceResponse =
        WebResourceResponse(
            "image/jpeg",
            null,
            200,
            "OK",
            // 同一集的雪碧图地址稳定，可以长缓存。
            mapOf("Cache-Control" to "private, max-age=86400"),
            ByteArrayInputStream(bytes),
        )

    private fun error(status: Int, message: String): WebResourceResponse =
        WebResourceResponse(
            "text/plain",
            "utf-8",
            status,
            message,
            mapOf("content-type" to "text/plain; charset=utf-8"),
            ByteArrayInputStream(message.toByteArray()),
        )

    private fun isAllowed(url: String): Boolean = HostAllowlist.allows(url, ALLOWED_SUFFIXES)

    private companion object {
        const val MAX_ENTRIES = 24
        const val MAX_BYTES = 32L * 1024 * 1024
        const val MAX_SOURCE_BYTES = 16 * 1024 * 1024
        const val JPEG_QUALITY = 88

        /** 与 `CoverHandler` 同一批上游 CDN 后缀，额外加雪碧图域名。 */
        val ALLOWED_SUFFIXES = listOf(
            "fqnovelpic.com",
            "fqnovel.com",
            "snssdk.com",
            "byteimg.com",
            // 实测雪碧图在 `p26-sign.douyinpic.com`（与封面不同域）。
            "douyinpic.com",
        )

        /** 伪装成 Android WebView 的 UA；CDN 对 OkHttp 默认 UA 回 403。 */
        const val BROWSER_UA =
            "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/131.0.0.0 Mobile Safari/537.36"
    }
}
