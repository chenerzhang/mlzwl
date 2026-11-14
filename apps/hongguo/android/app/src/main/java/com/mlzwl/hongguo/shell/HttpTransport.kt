package com.mlzwl.hongguo.shell

import android.util.Base64
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 把上游 HTTP 请求交给 OkHttp 发出，供 WebView 内的 openhongguo WASM 使用。
 *
 * 为什么必须在 Kotlin 侧发请求：WebView 内的 fetch 受同源策略与 CORS 约束，
 * 上游不给 CORS 响应头，预检会 403。OkHttp 是原生 HTTP 客户端，不受这些约束，
 * 因此签名请求可以直连上游。
 *
 * 与 SDK 的 Transport 契约一一对应：
 *   TransportRequest  = { method, url, headers, body }
 *   TransportResponse = { status, headers, cookies, body }
 */
class HttpTransport(
    private val client: OkHttpClient = defaultClient(),
) {
    private val tag = "HgTransport"

    /** 单个请求的结果；body 用 Base64 传输，避免 JS 侧处理二进制边界。 */
    data class Result(
        val status: Int,
        val headersJson: String,
        val cookiesJson: String,
        val bodyBase64: String,
        val error: String? = null,
        /** 流式下载时写入的字节数；非流式路径为 null。 */
        val fileBytes: Long? = null,
    )

    /**
     * 执行一次请求。[bodyBase64] 为空表示无请求体。
     *
     * 返回的 Result 永远不为 null：网络异常写进 [Result.error]，由 JS 侧抛错，
     * 这样 WASM 的重试逻辑仍然生效。
     */
    fun execute(
        method: String,
        url: String,
        headersJson: String,
        bodyBase64: String?,
    ): Result {
        return try {
            val headers = JSONObject(headersJson)
            val builder = Request.Builder().url(url)
            for (key in headers.keys()) {
                // Host 与 Content-Length 由 OkHttp 自己算，显式设置会抛错。
                if (key.equals("host", ignoreCase = true) ||
                    key.equals("content-length", ignoreCase = true)
                ) {
                    continue
                }
                builder.header(key, headers.optString(key))
            }

            val bodyBytes = if (bodyBase64.isNullOrEmpty()) {
                null
            } else {
                Base64.decode(bodyBase64, Base64.NO_WRAP)
            }
            val requestBody = when {
                bodyBytes == null -> null
                else -> bodyBytes.toRequestBody(null)
            }
            builder.method(method.uppercase(), requestBody)

            client.newCall(builder.build()).execute().use { response ->
                val responseHeaders = JSONObject()
                val cookies = JSONObject()
                for (name in response.headers.names()) {
                    val lower = name.lowercase()
                    if (lower == "set-cookie" || lower == "cookie") {
                        continue
                    }
                    // SDK 的契约是单值字符串；多值取第一个。
                    responseHeaders.put(name, response.headers.values(name).first())
                }
                // 与 nodeTransport 一致：Set-Cookie 拆成 name=value 的扁平表。
                for (line in response.headers.values("set-cookie")) {
                    val pair = line.substringBefore(';')
                    val eq = pair.indexOf('=')
                    if (eq > 0) {
                        cookies.put(pair.substring(0, eq).trim(), pair.substring(eq + 1).trim())
                    }
                }
                val bytes = response.body?.bytes() ?: ByteArray(0)
                Log.d(tag, "$method $url -> ${response.code} ${bytes.size}B")
                Result(
                    status = response.code,
                    headersJson = responseHeaders.toString(),
                    cookiesJson = cookies.toString(),
                    bodyBase64 = Base64.encodeToString(bytes, Base64.NO_WRAP),
                )
            }
        } catch (e: Throwable) {
            Log.w(tag, "$method $url failed: ${e.message}")
            Result(
                status = 0,
                headersJson = "{}",
                cookiesJson = "{}",
                bodyBase64 = "",
                error = e.message ?: e::class.java.simpleName,
            )
        }
    }

    /**
     * 把响应体**流式**写入文件，返回写入的字节数。
     *
     * 视频不能走 [execute]：那条路径把整个响应读进 `ByteArray`，39 MB 的 1080p
     * 视频会直接把 WebView 进程的堆（上限 201 MB）撞爆，实测报
     * `Failed to allocate a 39101711 byte allocation`。这里按 64 KB 分块写盘，
     * 峰值内存只跟块大小有关。
     *
     * 失败时删除半成品文件，避免调用方拿到一个截断的 MP4。
     */
    fun downloadToFile(
        url: String,
        target: java.io.File,
        headersJson: String = "{}",
        maxBytes: Long = Long.MAX_VALUE,
    ): Result {
        return try {
            val headers = JSONObject(headersJson)
            val builder = Request.Builder().url(url)
            for (key in headers.keys()) {
                if (key.equals("host", ignoreCase = true) ||
                    key.equals("content-length", ignoreCase = true)
                ) {
                    continue
                }
                builder.header(key, headers.optString(key))
            }
            builder.method("GET", null)

            client.newCall(builder.build()).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w(tag, "GET $url -> ${response.code}")
                    return Result(
                        status = response.code,
                        headersJson = "{}",
                        cookiesJson = "{}",
                        bodyBase64 = "",
                        error = "HTTP ${response.code}",
                    )
                }
                val body = response.body ?: return Result(
                    status = response.code,
                    headersJson = "{}",
                    cookiesJson = "{}",
                    bodyBase64 = "",
                    error = "empty body",
                )
                // 先看声明的长度：超限就别白写一遍磁盘。
                // 实测有一集 360p 就有 248 MB，写完整份再删要 12 秒。
                val declared = body.contentLength()
                if (declared > maxBytes) {
                    Log.w(tag, "GET $url -> declared $declared B, over limit $maxBytes")
                    return Result(
                        status = response.code,
                        headersJson = "{}",
                        cookiesJson = "{}",
                        bodyBase64 = "",
                        error = "declared $declared bytes, limit $maxBytes",
                    )
                }
                target.parentFile?.mkdirs()
                var written = 0L
                body.byteStream().use { input ->
                    target.outputStream().use { output ->
                        val buffer = ByteArray(BUFFER_SIZE)
                        while (true) {
                            val read = input.read(buffer)
                            if (read <= 0) {
                                break
                            }
                            output.write(buffer, 0, read)
                            written += read
                            // 声明长度不可信时（chunked 无 content-length），
                            // 边写边查，超限立即停。
                            if (written > maxBytes) {
                                Log.w(tag, "GET $url -> exceeded $maxBytes B while streaming")
                                output.close()
                                target.delete()
                                return Result(
                                    status = response.code,
                                    headersJson = "{}",
                                    cookiesJson = "{}",
                                    bodyBase64 = "",
                                    error = "exceeded $maxBytes bytes",
                                )
                            }
                        }
                    }
                }
                Log.d(tag, "GET $url -> ${response.code} ${written}B (streamed)")
                Result(
                    status = response.code,
                    headersJson = "{}",
                    cookiesJson = "{}",
                    bodyBase64 = "",
                    fileBytes = written,
                )
            }
        } catch (e: Throwable) {
            Log.w(tag, "GET $url failed: ${e.message}")
            target.delete()
            Result(
                status = 0,
                headersJson = "{}",
                cookiesJson = "{}",
                bodyBase64 = "",
                error = e.message ?: e::class.java.simpleName,
            )
        }
    }

    companion object {
        /** 流式下载的块大小。64 KB 在吞吐与内存之间比较平衡。 */
        private const val BUFFER_SIZE = 64 * 1024

        private fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .followRedirects(true)
            .build()
    }
}
