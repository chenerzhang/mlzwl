package com.mlzwl.hongguo.shell

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * 把页面「下载」按钮产生的文件真正落到设备上。
 *
 * ## 为什么需要原生参与
 *
 * 页面的下载实现是 `downloadEpisode()` → `saveBlob()`：
 * `fetch('/api/media/:id')` 拿到 Blob，然后造一个 `<a download>` 并 `click()`。
 *
 * 在移动端 Chrome 上，浏览器会接管这个 click 并把文件存进下载目录。但
 * **Android WebView 不会**：`DownloadListener` 只对真正的网络下载触发，
 * `blob:` URL 不会触发它。实测：`anchor.click()` 确实执行了（页面里能
 * 拦到），但 `/sdcard/Download/` 目录仍然是空的。这是壳与浏览器之间的
 * 能力差，必须由壳补上。
 *
 * ## 为什么要分块传，而不是一次传完
 *
 * 视频必须是**解密后**的字节，而解密发生在 JS 侧（`hg-cenc.js` 用
 * WebCrypto）。原生侧的 `/api/video` 缓存文件是**加密**的，直接复制没有意义。
 *
 * 但 1080p 单集实测 8.9 MB、最长见过 39 MB。一次经 `WebMessageListener`
 * 传 base64 会放大 4/3 并且要在 Java 堆里建完整字符串，之前已经因此 OOM
 * （`Failed to allocate a 39101711 byte allocation`）。
 *
 * 所以改成「开始 → 逐块追加 → 结束」三段式，每块 512 KB 原始字节
 * （base64 后约 683 KB 字符串）。峰值内存只跟块大小有关，与视频总长无关。
 *
 * ## 为什么走 MediaStore 而不是直接写 /sdcard/Download
 *
 * API 29 起分区存储生效，应用不能直接写公共下载目录。MediaStore 是官方
 * 通道，写入后系统「下载」应用能立刻看到，用户拔数据线也能在文件管理器
 * 里找到。
 */
class DownloadHandler(private val context: Context) {

    private val tag = "HgDownload"

    /** 进行中的下载：token → 临时文件。 */
    private val sessions = ConcurrentHashMap<String, File>()

    /** 每个会话的创建时间，用于回收泄漏的会话。 */
    private val startedAt = ConcurrentHashMap<String, Long>()

    /**
     * 开始一次下载：建临时文件，返回 token。
     *
     * ## 为什么要先回收
     *
     * 页面在 `downloadBegin` 之后崩溃或刷新，`downloadFinish` / `downloadCancel`
     * 就永远不会到。不回收的话临时文件会一直堆在 `cacheDir`，占满磁盘。
     * 这里在每次开始前清一遍超过 [SESSION_TTL_MS] 的会话，并限制并发会话数。
     */
    fun begin(): String {
        sweepStale()
        val token = "dl-" + System.nanoTime()
        val file = File(context.cacheDir, "$token.part")
        file.parentFile?.mkdirs()
        file.createNewFile()
        sessions[token] = file
        startedAt[token] = System.currentTimeMillis()
        return token
    }

    /**
     * 清掉超时或超量的会话。
     *
     * 保留最近 [MAX_SESSIONS] 个；更早的删文件。超时阈值取 10 分钟：正常下载
     * 1080p 单集实测 2 秒，10 分钟足够容纳慢网。
     */
    private fun sweepStale() {
        val now = System.currentTimeMillis()
        for ((token, started) in startedAt.entries) {
            if (now - started > SESSION_TTL_MS) {
                discard(token)
            }
        }
        // 仍然超量时按开始时间淘汰最旧的。
        while (sessions.size >= MAX_SESSIONS) {
            val oldest = startedAt.entries.minByOrNull { it.value }?.key ?: break
            discard(oldest)
        }
    }

    /** 删除一个会话的临时文件并清掉两个表的记录。 */
    private fun discard(token: String) {
        sessions.remove(token)?.delete()
        startedAt.remove(token)
    }

    /**
     * 追加一块数据。
     *
     * @param base64 原始字节的 base64 编码
     * @return 已累计写入的字节数；token 不存在或超限时返回 -1
     */
    fun appendChunk(token: String?, base64: String?): Long {
        val file = sessions[token] ?: return -1
        if (base64.isNullOrEmpty()) {
            return file.length()
        }
        // 累计体积上限：防止异常或恶意脚本把缓存目录写满。
        // 实测最长的一集 1080p 约 39 MB，[MAX_BYTES] 留到 256 MB。
        if (file.length() > MAX_BYTES) {
            Log.w(tag, "chunk rejected: over $MAX_BYTES bytes")
            if (token != null) {
                discard(token)
            }
            return -1
        }
        return try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            file.appendBytes(bytes)
            file.length()
        } catch (e: Throwable) {
            Log.w(tag, "append failed: ${e.message}")
            -1
        }
    }

    /**
     * 结束下载：把临时文件复制进公共下载目录，然后删除临时文件。
     *
     * @param displayName 用户看到的文件名，例如 `7673860531840617496-1080p.mp4`
     */
    fun finish(token: String?, displayName: String?): Outcome {
        val file = sessions.remove(token)
            ?: return Outcome(error = "unknown download token")
        startedAt.remove(token)
        if (!file.exists() || file.length() == 0L) {
            file.delete()
            return Outcome(error = "empty download")
        }
        val name = sanitize(displayName)
        return try {
            val outcome = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveViaMediaStore(file, name)
            } else {
                saveViaLegacyDir(file, name)
            }
            outcome
        } catch (e: Throwable) {
            Log.w(tag, "save failed: ${e.message}")
            Outcome(error = e.message ?: e::class.java.simpleName)
        } finally {
            // 临时文件已经复制进下载目录，留着只是占缓存。
            file.delete()
        }
    }

    /** 取消一次下载并清理临时文件。 */
    fun cancel(token: String?): Boolean {
        val file = sessions.remove(token) ?: return false
        startedAt.remove(token)
        return file.delete()
    }

    /** API 29+：写 MediaStore.Downloads。 */
    private fun saveViaMediaStore(source: File, name: String): Outcome {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, "video/mp4")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri: Uri = resolver.insert(collection, values)
            ?: return Outcome(error = "insert returned null")

        val written = resolver.openOutputStream(uri)?.use { output ->
            source.inputStream().use { input ->
                // 按块复制：与 `HttpTransport.downloadToFile` 同样的理由，避免整份读进内存。
                val buffer = ByteArray(BUFFER_SIZE)
                var total = 0L
                while (true) {
                    val read = input.read(buffer)
                    if (read <= 0) {
                        break
                    }
                    output.write(buffer, 0, read)
                    total += read
                }
                total
            }
        } ?: 0L

        if (written == 0L) {
            resolver.delete(uri, null, null)
            return Outcome(error = "wrote 0 bytes")
        }

        // 清掉 pending 标记，文件才对其他应用可见。
        resolver.update(
            uri,
            ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) },
            null,
            null,
        )
        Log.i(tag, "saved $name ($written B) -> $uri")
        return Outcome(uri = uri.toString(), bytes = written)
    }

    /** API 28 及以下：直接写公共下载目录。 */
    @Suppress("DEPRECATION")
    private fun saveViaLegacyDir(source: File, name: String): Outcome {
        val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        dir.mkdirs()
        val target = File(dir, name)
        source.copyTo(target, overwrite = true)
        Log.i(tag, "saved ${target.absolutePath} (${target.length()} B)")
        return Outcome(uri = target.absolutePath, bytes = target.length())
    }

    /**
     * 文件名清洗：去掉路径分隔符与奇怪字符，保留中文。
     *
     * 三件事：
     * 1. 把路径分隔符与控制字符换成 `_`，避免穿越到其它目录。
     * 2. 把 `..` 整体换成 `_`：`..` 不含分隔符，单靠第 1 步拦不住，
     *    而 `File(dir, "..")` 会指到父目录。
     * 3. 截断到 [MAX_NAME_BYTES]：多数文件系统单个文件名上限是 255 字节，
     *    上游剧名很长时会把 `.mp4` 后缀也一起截掉。
     */
    private fun sanitize(displayName: String?): String {
        val raw = displayName?.trim().orEmpty()
        val base = if (raw.isEmpty()) {
            "hongguo-" + System.currentTimeMillis() + ".mp4"
        } else {
            raw
        }
        var cleaned = base.replace(Regex("""[\\/:*?"<>|\u0000-\u001f]"""), "_")
        cleaned = cleaned.replace("..", "_")
        // 先截断再补后缀，保证后缀一定在。
        if (cleaned.endsWith(".mp4")) {
            cleaned = cleaned.removeSuffix(".mp4")
        }
        if (cleaned.toByteArray().size > MAX_NAME_BYTES) {
            cleaned = cleaned.take(MAX_NAME_BYTES / 3)
        }
        return "$cleaned.mp4"
    }

    /** 下载结果。字段与 JS 侧约定一致，由 MainActivity 序列化成 JSON。 */
    data class Outcome(
        val uri: String? = null,
        val bytes: Long = 0L,
        val error: String? = null,
    )

    private companion object {
        const val BUFFER_SIZE = 64 * 1024

        /** 单次下载累计体积上限。实测最长的一集 1080p 约 39 MB。 */
        const val MAX_BYTES = 256L * 1024 * 1024

        /** 同时存在的下载会话上限。正常只有 1 个（用户点一次下载）。 */
        const val MAX_SESSIONS = 4

        /** 会话超时：10 分钟内没结束就回收。 */
        const val SESSION_TTL_MS = 10 * 60 * 1000L

        /** 文件名（不含后缀）的字节上限，给 `.mp4` 留余量。 */
        const val MAX_NAME_BYTES = 200
    }
}
