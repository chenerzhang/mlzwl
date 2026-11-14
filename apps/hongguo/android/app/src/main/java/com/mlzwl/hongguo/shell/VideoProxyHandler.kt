package com.mlzwl.hongguo.shell

import android.util.Log
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap

/**
 * `/api/video?url=` 端点：把上游视频字节转发给页面。
 *
 * ## 为什么需要它
 *
 * 上游视频 CDN 对 WebView 内的 `fetch` 返回 **403**（实测：UA 是 Android WebView，
 * 响应体为空）。同一个地址在 Kotlin 的 OkHttp 里能拿到 200，差异在 TLS 指纹与
 * 请求头组合上，JS 侧无法伪造。
 *
 * 所以让原生侧取字节，页面用**同源** URL 去 fetch。同源请求不经过 CORS，
 * 也不受 CDN 对浏览器请求的判定影响。
 *
 * ## 为什么不直接返回 CDN 地址给 `<video>`
 *
 * 上游视频是 CENC 加密的（`protected: true` + `cenc-aes-ctr`）。浏览器要播必须走
 * EME + license server，而上游不提供 license。所以页面必须先拿到完整字节、
 * 用 WebCrypto 解密，再生成 blob URL。这一步在 `hg-cenc.js` 里做。
 *
 * ## 缓存
 *
 * 同一集的同一档在一次会话里只会被请求一次（解密后页面用 blob URL），
 * 所以这里只缓存**最近一次**响应，用来挡住重复请求，不占太多内存。
 */
class VideoProxyHandler(
    private val transport: HttpTransport,
    private val maxBytes: Long = MAX_BYTES,
) {

    private val tag = "HgVideo"

    /** 只留最近一份：解密完成后页面不再请求，留着旧的只是占盘。 */
    private val cache = ConcurrentHashMap<String, java.io.File>()

    /**
     * 每份缓存文件当前的引用计数。
     *
     * ## 为什么需要它
     *
     * 播放页会**预热下一集**（`player-route.tsx` 的 `prefetchMedia`），所以同一时刻
     * 可能有两份视频在下载。原来的淘汰逻辑是「新的一份进来就把旧的全删」——
     * 当当前集的 `FileInputStream` 还在被 WebView 读取时，它的文件被删，
     * 读到一半就断了。
     *
     * 实测现象：点播放先报 `播放失败：视频下载失败 HTTP 502`，手动重试才成功。
     * 失败那两次正好与预取重叠。
     *
     * 现在改成：只在引用计数为 0 时才删。正在被读的文件永远不删。
     */
    private val refs = java.util.concurrent.ConcurrentHashMap<String, Int>()

    /**
     * 正在下载的 URL → 那把锁。
     *
     * ## 为什么要它
     *
     * `shouldInterceptRequest` 在后台线程池里跑，同一个 URL 可能被并发请求：
     * 播放和下载按钮会同时要同一集，切档后快速切回也会。两路同时写同一个
     * `target` 文件时，`target.outputStream()` 会把文件截断重写，于是：
     *
     * 1. 两路交叠写入，文件内容可能交错损坏；
     * 2. 先完成那一路把 `FileInputStream` 交给 WebView，后一路把文件截断，
     *    WebView 读到一半就断。
     *
     * 引用计数解决不了这个：它只保证「已经在读的文件不被淘汰」，不管
     * 「正在写的文件被另一路同时写」。
     */
    private val downloadLocks = java.util.concurrent.ConcurrentHashMap<String, Any>()

    /**
     * 拿一个 URL 的下载锁。
     *
     * `computeIfAbsent` 保证同一个 key 只会造一把锁，所有并发请求拿到同一实例。
     */
    private fun lockFor(source: String): Any =
        downloadLocks.computeIfAbsent(source) { Any() }

    /**
     * 下载结束后丢掉这把锁。
     *
     * 不回收的话，每看过一集就永久多一个 `String` + `Any` 的条目。剧集列表可以
     * 无限翻，长会话下就是一个稳定的内存增长点。
     *
     * 只在**缓存已经写好**时删锁。后来者重新 `computeIfAbsent` 后第一件事是
     * 查缓存，命中就不进下载路径，所以不会出现「两把锁写同一个文件」。
     * 如果下载失败（缓存没写成），锁保留——下一次重试要接着用同一把。
     */
    private fun releaseLock(source: String) {
        if (cache.containsKey(source)) {
            downloadLocks.remove(source)
        }
    }

    /**
     * 处理 `/api/video?url=<encoded>`。
     *
     * **必须流式落盘**：39 MB 的 1080p 视频如果读进 `ByteArray` 会直接撞爆
     * WebView 进程的 Java 堆（实测 `Failed to allocate a 39101711 byte allocation`）。
     * 写文件后交给 `FileInputStream` 返回，峰值内存只跟块大小有关。
     */
    fun handleVideo(source: String?, cacheDir: java.io.File): WebResourceResponse {
        if (source.isNullOrEmpty()) {
            return error(400, "missing url")
        }
        if (!isAllowed(source)) {
            return error(403, "host not allowed")
        }

        // 快路径：缓存已命中就不进锁。命中后文件不会被删（引用计数在
        // `videoResponse` 里 +1），所以这里读 `cache` 是安全的。
        cache[source]?.let { file ->
            if (file.exists() && file.length() > 0) {
                Log.d(tag, "cache hit ${file.length()}B")
                return videoResponse(source, file)
            }
            cache.remove(source)
        }

        // 慢路径：同一个 URL 串行下载。第二个请求进来时第一路已经下载完，
        // 重新走一遍缓存检查就能直接命中。
        //
        // 用 `try/finally` 而不是 `synchronized { }.also { }`：`synchronized`
        // 块里有两个提前 `return`（缓存命中），`.also` 不会执行，锁就漏了。
        try {
            synchronized(lockFor(source)) {
                cache[source]?.let { file ->
                    if (file.exists() && file.length() > 0) {
                        Log.d(tag, "cache hit after lock ${file.length()}B")
                        return videoResponse(source, file)
                    }
                    cache.remove(source)
                }
                return downloadAndCache(source, cacheDir)
            }
        } finally {
            releaseLock(source)
        }
    }

    /** 真正下载并写入缓存。调用方必须持有该 URL 的锁。 */
    private fun downloadAndCache(source: String, cacheDir: java.io.File): WebResourceResponse {
        val started = System.currentTimeMillis()
        // 文件名不能只用 hashCode：不同 URL 可能撞同一个值，撞上就会读到另一集的内容。
        // 用 URL 的 SHA-256 前 16 字节做标识。
        val target = java.io.File(cacheDir, "video-" + sha256Hex(source) + ".mp4")
        val headers = org.json.JSONObject().put("user-agent", BROWSER_UA).toString()
        val result = transport.downloadToFile(source, target, headers, maxBytes)
        if (result.error != null) {
            Log.w(tag, "download failed: ${result.error}")
            return error(502, "upstream fetch failed: ${result.error}")
        }
        val size = result.fileBytes ?: 0L
        if (size == 0L) {
            return error(502, "empty body")
        }
        if (size > maxBytes) {
            target.delete()
            return error(502, "video too large: $size")
        }
        Log.d(tag, "downloaded ${size}B in ${System.currentTimeMillis() - started}ms")

        cache[source] = target
        evictUnused(keep = source)
        return videoResponse(source, target)
    }

    /**
     * 清掉没人在读的缓存文件。
     *
     * 只删 `refs` 里计数为 0 的项。正在被 `FileInputStream` 读的文件保留，
     * 否则并发预取会把当前播放的那份删掉。
     *
     * `keep` 是刚刚写入的那一份：它还没被 `videoResponse` 加计数，
     * 但绝对不能删——删了之后紧接着的 `FileInputStream` 会抛
     * `FileNotFoundException`。
     */
    private fun evictUnused(keep: String? = null) {
        val iterator = cache.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            val key = entry.key
            if (key == keep) {
                continue
            }
            val count = refs[key] ?: 0
            if (count == 0) {
                entry.value.delete()
                refs.remove(key)
                iterator.remove()
            }
        }
    }

    private fun videoResponse(source: String, file: java.io.File): WebResourceResponse {
        // 先建流再加计数：`FileInputStream` 构造会抛 `FileNotFoundException`
        // （文件刚好被别的路径删了）。如果先加计数、构造失败，计数就永久停在 1，
        // 这份缓存从此再也不会被 `evictUnused` 清掉。
        val stream = try {
            TrackingInputStream(file, onClose = { release(source) })
        } catch (e: java.io.FileNotFoundException) {
            Log.w(tag, "open failed: ${e.message}")
            cache.remove(source)
            return error(502, "cache file missing")
        }
        refs.merge(source, 1, Int::plus)
        return WebResourceResponse(
            "video/mp4",
            null,
            200,
            "OK",
            mapOf(
                "Cache-Control" to "no-store",
                // 下载按钮需要知道缓存文件在哪：它不能把 8–39 MB 字节
                // 经 base64 桥接回原生（会 OOM），所以只传路径。
                // 自定义响应头对 `fetch()` 可见（同源，无 CORS 限制）。
                "X-Hg-Cache-Path" to file.absolutePath,
            ),
            stream,
        )
    }

    /**
     * 引用计数 -1。
     *
     * 降到 0 后不立即删文件：可能还有别的流在打开过程中。下次 `evictUnused`
     * 看到计数为 0 才真删。这样也避开了「在 `onClose` 回调里删文件」的时序问题。
     */
    private fun release(source: String) {
        refs.computeIfPresent(source) { _, count -> if (count <= 1) 0 else count - 1 }
    }

    /**
     * 包装 `FileInputStream`，在 `close()` 时回调。
     *
     * WebView 读完响应会关流；用回调把引用计数降下来，才能安全淘汰。
     */
    private class TrackingInputStream(
        file: java.io.File,
        private val onClose: () -> Unit,
    ) : java.io.FileInputStream(file) {
        private var closed = false

        override fun close() {
            if (!closed) {
                closed = true
                onClose()
            }
            super.close()
        }
    }

    private fun sha256Hex(value: String): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        val bytes = digest.digest(value.toByteArray())
        return bytes.take(16).joinToString("") { "%02x".format(it) }
    }

    private fun error(status: Int, message: String): WebResourceResponse =
        WebResourceResponse(
            "text/plain",
            "utf-8",
            status,
            message,
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(message.toByteArray(StandardCharsets.UTF_8)),
        )

    /** 只允许上游视频 CDN 的域名后缀，避免这个端点变成任意 URL 代理。 */
    private fun isAllowed(url: String): Boolean = HostAllowlist.allows(url, ALLOWED_SUFFIXES)

    private companion object {
        /** 1080p 实测 39 MB；留到 128 MB 以容纳更长的集。 */
        /**
         * 单集体积上限。
         *
         * 与 server 的 `MEDIA_MAX_BYTES`（200 MB）保持一致：两端对同一集要么都能播，
         * 要么都不能，不出现「网页能看、壳里报错」的差异。
         */
        const val MAX_BYTES = 200L * 1024 * 1024

        const val BROWSER_UA =
            "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/131.0.0.0 Mobile Safari/537.36"

        val ALLOWED_SUFFIXES = listOf(
            "qznovelvod.com",
            "fqnovelpic.com",
            "byteimg.com",
            "snssdk.com",
        )
    }
}
