package com.mlzwl.hongguo.shell

/**
 * 上游 CDN 域名白名单校验。
 *
 * ## 为什么不能用 `host.endsWith(suffix)`
 *
 * 朴素的 `endsWith` 会把 `evilfqnovelpic.com` 当成合法域名，因为它确实以
 * `fqnovelpic.com` 结尾。攻击者只要注册这样一个域名，就能让
 * `/api/cover?url=`、`/api/video?url=`、`/api/sprite-sheet?url=` 变成
 * 指向任意服务器的代理（SSRF 的入口）。
 *
 * 正确判断是「主机名等于域名」或「主机名以 `.域名` 结尾」：
 *
 * ```
 * fqnovelpic.com              ✓ 等于
 * p3-reading-sign.fqnovelpic.com  ✓ 以 .fqnovelpic.com 结尾
 * evilfqnovelpic.com          ✗ 既不等也不以 . 结尾
 * ```
 *
 * ## 为什么三个 Handler 共用一份
 *
 * `CoverHandler`、`SpriteHandler`、`VideoProxyHandler` 各有自己的白名单常量，
 * 但校验逻辑必须一致。分散实现时改一处漏两处是迟早的事。
 */
internal object HostAllowlist {
    /**
     * 判断 `url` 的主机名是否落在 `suffixes` 里。
     *
     * 解析失败（不是合法 URL）一律返回 `false`，不抛异常。
     */
    fun allows(url: String, suffixes: List<String>): Boolean {
        val host = try {
            java.net.URI(url).host?.lowercase()
        } catch (e: Exception) {
            null
        } ?: return false
        return suffixes.any { host == it || host.endsWith(".$it") }
    }
}
