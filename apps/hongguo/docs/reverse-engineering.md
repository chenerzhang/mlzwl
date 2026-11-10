# 红果短剧 Web 版：逆向工程结论

本文是 `/Users/bytedance/code/github/hongguo` 项目的技术底稿。目标是把 DSH 插件 `dsh-hongguo` 重做成一个**独立的 Web 应用**（不是插件）。本文只记录已经过实测验证的事实，以及可复现的实现路径。

- 上游插件：`upstream/`（`dsh-hongguo` v1.2.1）
- 上游 SDK：`openhongguo@0.1.0`（Go 客户端 + WASM 构建）
- Go 源码：`/tmp/ohgsrc`（`github.com/beilunyang/openhongguo`，20996 行）
- 探针脚本与样本：`/tmp/probe`
- 本文档配套代码：`docs/reference/*.mjs`

> **可复现性说明。** `/tmp` 下的路径是临时工作区，重启后可能消失。文档里引用它们是为了说明「结论是怎么测出来的」，不是要求读者依赖这些路径。要重新验证，按第 10 节的步骤从 npm 和 GitHub 重新拉取即可。所有关键算法都已固化成 `docs/reference/` 下的可执行文件，不依赖 `/tmp`。

---

## 1. 结论摘要

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| 浏览器能不能直接调 API？ | **不能**。跨域预检失败，且带 `Origin` 头会被判 `AUTHENTICATION_REQUIRED`。 | `OPTIONS` 到 `log5-applog-lq.fqnovel.com/service/2/device_register/` 返回 404 无 CORS 头；API 预检带 `x-gorgon,x-medusa` 返回 403；Node 侧加 `Origin` 头 → `AUTHENTICATION_REQUIRED`。 |
| 服务端只做「哑转发」行不行？ | **可以**。浏览器里跑 WASM SDK 完成签名，只把最终 HTTP 请求交给同源转发器。`discover` / `listEpisodes` / `resolvePlayback` 全链路已在 Chrome 里跑通。 | `docs/reference/wasm-full.html` + `docs/reference/proxy.mjs`；见 5.5–5.7。**转发器必须回传解析后的 `cookies` 对象**，否则注册票据丢失、最终报 `no guest identity`。 |
| 内容密钥怎么拿？ | 服务端返回 `encrypt_info.spade_a`，本地按固定置换还原。纯 JS 已复现，与 SDK 输出逐字节一致。 | `docs/reference/spade-derive.mjs`，实测 key `7ab1ea82…7e5f` version `1` 一致。 |
| 视频怎么解密？ | 标准 CENC `cenc-aes-ctr`。WebCrypto `AES-CTR` 原地解密即可，无需 ffmpeg。 | 360p 4.3MB 中位 61ms；1080p 14.7MB 中位 62ms（冷启 261ms），1920×1080 正常播放。 |
| 解密后要不要改 MP4 结构？ | **不需要**。只需把 `encv`→`hvc1`、`enca`→`mp4a`，并把 `tenc` 的 `isProtected` 置 0，字节长度完全不变。 | `docs/reference/cenc-decrypt-browser.mjs`。 |
| 封面怎么处理？ | 剧集封面是 JPEG 可直接用；剧集列表/搜索的封面是 HEIC，需要转码。搜索接口**完全不返回封面**。 | 6/6 剧集封面 `content-type: image/jpeg`；discover/newReleases/shortRank/getSeries 返回 `ftypheic`；`search` 条目无 `cover_url` 字段。 |
| 播放地址有效期？ | 约 6 小时。过期需重新 `resolvePlayback`。 | `expire_time` 21600s、`url_expire` 21697s、`expires_at` 21697s。 |
| 匿名配额？ | 单设备连续 25 次 `resolvePlayback` 无失败；搜索仍可用。 | `t17.mjs`。 |

---

## 2. 上游插件做了什么

`upstream/` 分成两半：

**Host 半（`index.js`，1240 行，Node）**
1. 引入 `openhongguo`（WASM 版 Go SDK），维护匿名设备档案。
2. 代理播放清单与媒体分片，让页面只看到同源 URL（CDN 签名串不进浏览器历史）。
3. HEIC 封面转码（`/cover` 路由，走 ffmpeg/sips）。
4. 内容密钥**永不离开 Host**。
5. 提供 `/api/hongguo/*` 路由：`/window`、`/open`、`/cover`、`/vendor/*`、`/hghub-manifest`、`/config`、`/activity`、`/feed`、`/search`、`/series`、`/play`。

**Client 半（`client.js`，2120 行，React）**
- 侧边栏播放器 UI，历史记录 `dsh-hongguo.watch-history.v1`，音量键 `${HISTORY_KEY}.volume`。
- 常量：`PAGE=12`、`CHUNK=50`、`END_MARGIN=5`、`SPEEDS=[0.5,0.75,1,1.25,1.5,2]`、`MEDIA_KEEP=40`、`maxPages:6`。

**Standalone（`standalone/app.js`，637 行）**
- 独立窗口播放页，同样用 localStorage 记录进度，`ended` 自动下一集。

**Web 版要复刻的，本质上就是 Host 半的 5 项职责**，但可以重新划分（见第 7 节）。

---

## 3. 接口与协议

### 3.1 主机与路径

| 用途 | 值 |
| --- | --- |
| 读接口主机 | `api5-normal-sinfonlinea.fqnovel.com` |
| 设备注册主机 | `log5-applog-lq.fqnovel.com` |
| 图片 CDN | `p3-reading-sign.fqnovelpic.com`、`p6-novel.byteimg.com` |
| 视频 CDN | `*.qznovelvod.com` |

| 路径常量 | 值 |
| --- | --- |
| `PathDiscover` | `/reading/bookapi/bookmall/tab/v` |
| `PathCellChange` | `/reading/bookapi/bookmall/cell/change/v` |
| `PathSearch` | `/reading/bookapi/search/tab/v` |
| `PathSeries` | `/novel/player/video_detail/v1/` |
| `PathSeriesBatch` | `/novel/player/multi_video_detail/player/v1` |
| `PathPlayback` | `/novel/player/video_model/v1/` |
| `PathAlbum` | `/novel/player/album_detail/v1/` |
| `PathCategory` | `/reading/bookapi/new_category/front/v1/` |
| `PathRank` | `/reading/ugc/rank_book/get/v1/` |
| `PathRegister` | `/service/2/device_register/` |

### 3.2 App 身份常量

```
Package        = com.phoenix.read
VersionName    = 7.3.9.32
VersionCode    = 73932
AID            = 8662
AppName        = novelread
DevicePlatform = android
```

User-Agent 模板：

```
com.phoenix.read/73932 (Linux; U; Android {OSVersion}; zh_CN; {Model}; Build/{Build}; Cronet/TTNetVersion:8d40f833 2026-03-03 QuicVersion:21ac1950 2025-11-18)
```

### 3.3 匿名设备档案

字段（实测 `profile` JSON）：

```
cdid, openudid, clientudid, oaid_id, req_id,
device_id_str, install_id_str, ttreq,
store_region, store_region_src, created_at, device
```

- `device_id_str` / `install_id_str` 由注册接口下发，15 位数字。
- `ttreq` 是搜索需要的游客票据（42 字符）。
- 档案默认落在 `~/.config/openhongguo/anonymous.json`，可用 `OHG_CONFIG_DIR` 改目录。
- SDK 遇到 `ANONYMOUS_LIMITED` 会重置设备重新注册。

### 3.4 请求签名

一次请求要带 6 个签名头（`/tmp/ohgsrc/internal/protocol/sign/request.go`）：

| 头 | 算法 |
| --- | --- |
| `x-ss-stub` | body 的 MD5 大写 hex（仅 POST） |
| `x-gorgon` | 见 3.4.1 |
| `x-khronos` | `_rticket / 1000` 的十进制 |
| `x-ladon` | `base64(be32(khronos))` |
| `x-argus` | `base64(le32(khronos))` |
| `x-helios` | 见 3.4.2 |
| `x-medusa` | 见 3.4.3 |

另有 `x-ss-req-ticket`、`x-tt-request-tag`、`sdk-version`、`passport-sdk-version`、`x-vc-bdturing-sdk-version`。

**时间戳选取**：从 `nowMillis` 开始最多尝试 32 次，取第一个使 `branchOf(sm3(query), md5(body), khronos) != 1` 的 `ts/_rticket`。也就是签名里有一段「分支选择」，不是纯随机。

**查询编码**：自定义 percent-encoding，unreserved 集合是 `A-Za-z0-9-_.!~*'()`，其余按 `%XX` 大写。

#### 3.4.1 x-gorgon

```
input = md5(query)[0:4] + md5(body)[0:4] + 00 00 00 00 + le32(67503104) + be32(khronos)
key   = 4a 40 16 ((random>>8)&0xff) 47 6c 01 (random&0xff)
out   = RC4(input, key)
for i in 0..len(out)-1:
    v      = swap_nibbles(out[i])
    next   = out[i+1] if i+1 < len else out[0]
    out[i] = ~( reverse_bits(next ^ v) ^ 0x14 )
result = 84 04 (random&0xff) ((random>>8)&0xff) 40 01 + out
header = hex(result)
```

RC4 变体：PRGA 里 `i` 自增后取 `s[i]`，输出用 `s[(y+y)&255]`，不是标准 RC4。

#### 3.4.2 x-helios

```
seed   = le32(random) + "8662"
digest = md5(seed)
ascii  = hex(digest)                      // 32 个 ASCII 字符
words  = 4 个 little-endian uint64(ascii)
table  = diffuse(words)                   // 34 项扩散表
padded = PKCS#7-pad("{khronos}-1588093228-8662", 块 16)
for each 16-byte chunk (a,b) as le64:
    for t in table[0:34]:
        b = t ^ (a + ror64(b, 8))
        a = b ^ ror64(a, 61)
result = le32(random) + output
header = base64(result)
```

#### 3.4.3 x-medusa

最复杂的一段，包含 SM3、AES-CBC、自定义 XOR 混淆和 protobuf 序列化。实现要点：

- `keyHash = SM3(signKey + le32(random) + signKey)`，`signKey = 8ebdfa38…a2f5`
- `xmxor(data, hash)` 做逐字节可逆混淆（依赖 `(i*4)&28` 取 key 字节）
- `deviceProto(deviceID)` 用 protobuf 编码设备描述
- 用 `medusaAESKey` / `medusaAESIV` 做 AES-CBC
- 最终 base64

参考实现：`/tmp/ohgsrc/internal/protocol/sign/medusa.go`（205 行）+ `sm3.go`（91 行）+ `aes.go`（211 行）。`sign_test.go` 里有一组**完整期望值**，可作为移植时的对照测试：

```
gorgon("iid=7100…&_rticket=1700000000123", body, 1700000000, 0x1234)
  == "84043412400154ed198c3230d5ff1364e71df6105a46126993c0"
helios(1700000000, 2028160147)
  == "k0TjeBWFFnRXfkeKlh3Hmx1jLjrfhgCasqsF4XvB1+0eB1Mw"
keyHash(medusaSignKey(), 2378451149)
  == 1b35023431b99a949ab7b70fc50a30216076492a6229d102a7a33fa3a1104170
xmxor("0123456789abcdefghij", hash)
  == 5c69c37694106e8cbdb2e074619a1dda6c5a5a65
```

> 这组向量是移植 x-medusa 到 JS 时唯一可靠的验收标准。没有它，写出来的实现无法判断对错。

### 3.5 设备注册

请求：`POST /service/2/device_register/?req_id=<uuid>&tt_data=a`

请求体是三层包装：

1. `{"magic_tag":"ss_app_log","header":{…},"_gen_time":<ms>}`（header 字段按固定顺序序列化）
2. gzip 压缩（`ModTime` = 生成时间，`OS` = 255）
3. `TTEncrypt` 外壳：

```
prefixHash = SHA512(prefix_const)              // prefix_const = 3176c9b6…fa25a
keyIV      = SHA512(prefixHash + tt_const)     // tt_const = 4dd4c2e6…dd58
digest     = SHA512(plain)
padded     = PKCS#7(digest + plain)
body       = 74 63 05 10 00 00 + prefix_const + AES-CBC(keyIV[0:16], iv=keyIV[16:32], padded)
```

响应字段：`device_id_str`、`install_id_str`、`new_user`。缺任一 id 即视为注册失败。

### 3.6 播放模型

`POST /novel/player/video_model/v1/` 返回的 `data.video_model` 是一个**字符串化的 JSON**（要二次 `JSON.parse`）。结构：

```jsonc
{
  "video_id": "v02ebeg…",
  "video_duration": 110.334,
  "url_expire": 1794238525,
  "big_thumbs": [ { "img_url": "…~tplv-noop.heif", "img_num": 110, "img_x_len": 10, "img_y_len": 10, "interval": 1 } ],
  "video_list": [
    {
      "main_url": "https://v26-reading-video.qznovelvod.com/…",
      "video_meta": { "definition": "360p", "vwidth": 640, "vheight": 360, "codec_type": "bytevc1", "bitrate": 186765, "size": 3429581, … },
      "encrypt_info": { "encrypt": true, "kid": "6ae6eece…d0fb", "spade_a": "rLwi8mi7OMZ0gDjQcJw8zEeH…", "encryption_method": "cenc-aes-ctr" },
      "quality_type": 40,
      "gear_des_key": "0:MP4|1:encrypt|2:h265_hvc1|4:360p|5:normal|6:only_roi_audio_64k_v194|10000:105",
      "volume": { "loudness": -11.3, "peak": 1, … }
    }
  ]
}
```

一集通常给 5 档清晰度（实测同一集）：

| definition | 分辨率 | 编码 | bitrate | size |
| --- | --- | --- | --- | --- |
| 360p | 640×360 | bytevc1 | 253,908 | 9.35 MB |
| 480p | 854×480 | bytevc1 | 348,454 | 12.77 MB |
| 540p | 960×540 | bytevc1 | 363,457 | 13.32 MB |
| 720p | 1280×720 | bytevc1 | 399,581 | 14.62 MB |
| 1080p | 1920×1080 | bytevc1 | 738,450 | 26.88 MB |

注意 540p 与 720p 的 bitrate 只差 10%，但 1080p 翻倍。默认选 720p 是合理折中。

要点：

- `big_thumbs` 是**雪碧图**（10×10 网格，110 张，间隔 1 秒），做进度条缩略图用；格式 HEIF，需要转码。
- `gear_des_key` 是「字段号:值」的竖线分隔串，可直接解析出清晰度、编码、音量策略。
- `check_info` 形如 `c:0-180635-2109`，是分片校验信息。
- 每个清晰度各自带一份 `spade_a`，密钥相同。

### 3.7 剧集列表

`listEpisodes(seriesId)` 返回的条目字段：

```
id, series_id, number, title, playable,
cover_url, cover_expires_at,
content_type, comment_count, digg_count
```

- `number` 从 1 开始，与 App 显示一致。
- `playable` 实测 40/40 为 `true`，但**字段存在说明有 false 的可能**，播放前要判。
- `content_type` 是枚举：`1004` = 漫剧（动态漫），`1` = 真人短剧。见 `types.d.ts` 的完整枚举。
- 没有 `duration` 字段（`types.d.ts` 里有 `duration?`，但实测返回 `undefined`）。时长只能从播放模型的 `video_duration` 拿。
- 一次返回全部集数（实测 78 / 117 集，`has_more: false`，无 `cursor`）。集数多的剧可能分页。

### 3.8 播放地址寿命

实测三个时间字段（同一时刻对比 `now`）：

| 字段 | 相对 now | 说明 |
| --- | --- | --- |
| `data.expire_time` | 21600 s | 恰好 6 小时，接口层固定值 |
| `url_expire` | 21697 s | 视频 URL 的过期时间 |
| `playback.expires_at`（SDK） | 21697 s | 等于 `url_expire` |

即播放地址寿命约 **6 小时**，且 `expire_time` 与 `url_expire` 只差不到 100 秒，可以视为同一时刻。

所以缓存播放地址时按 6 小时处理；过期后必须重新走 `resolvePlayback`，不能用旧 key 拼 URL。

> 早前记录的「1800 秒」是误读，已由本次实测修正。

---

## 4. DRM：两段算法

红果的「加密」是两段独立算法，必须都实现才能播放。

### 4.1 第一段：spade_a → 内容密钥

`encrypt_info.spade_a` 是一段 base64，里面藏着 AES 内容密钥。还原步骤：

1. base64 解码得 `raw`。
2. `marker = raw[0] ^ raw[1] ^ raw[2]`，`prefixLen = marker - 0x30`，`outLen = len(raw) - marker + 0x2f`。
3. 取 `buf = raw[1 : 1+outLen]`。
4. `tail = len(raw) - prefixLen`，`b16 = raw[tail-2]`，`b14 = raw[tail-1]`。
5. `tag[i] = b14 ^ b16 ^ raw[i+tail]`（长度 `prefixLen`）。
6. 若 `tag` 以 `app_v2` 或 `web_v2` 开头，走 v2 置换，否则走 v1。
7. 置换后 `buf[0]` 是 hex 位数 `versionLen`；`key = buf[1 : outLen-versionLen]`；`version = buf[outLen-versionLen:]`。

置换 `scramble`（v1/v2 两版）：

```
prev = 0x55, cur = 0xfa
for i in 0..len-1:
    term = -(0x15 + popcount(i)) & 0xff
    if i even:  buf[i] = v2 ? ((cur ^ b) - prev + term) : (term + (cur ^ b)); cur = b
    else:       buf[i] = v2 ? ((prev ^ b) - prev + term) : (term + (prev ^ b)); prev = b
```

v2 额外先做相邻字节交换（循环到 `len-2` 为止）。

**验证**：`docs/reference/spade-derive.mjs` 的输出与 SDK `contentKey.key` / `.version` 完全一致。

### 4.2 第二段：CENC 解密

样本特征（实测）：

- 顶层箱结构：`ftyp` → `moov` → `free` → `mdat`。**不是分片 MP4，没有 `moof`**。360p 与 1080p 都是这个布局，`moov` 固定在偏移 28。

> 这一点很重要：因为不是 fragmented MP4，整个文件是一次性完整下载 + 一次性解密，不能按 `moof` 分片流式处理。好在解密只要 60ms，一次性处理完全可接受。
- `stsd` 里样本条目类型是 `encv`（视频）/ `enca`（音频）。
- `sinf` → `schm`（`cenc`）→ `schi` → `tenc`。
- `tenc` 实测 hex（360p 样本）：`0000000000000108 6ac5fe72f8818b74365c536a0003ebeb`
  - 拆开：`version=0`（1B）、`flags=0`（3B）、`reserved`（**2B**）、`isProtected=1`（1B）、`perSampleIVSize=8`（1B）、`KID=6ac5fe72…03ebeb`（16B）
  - 1080p 样本是 `0000000000000108 6a9024fa…0002ebeb`，布局相同，KID 不同
- `senc`：`flags=0x0`（**没有 subsample**），每样本 8 字节 IV。
- `stsz`：`sampleSize=0` + 显式 size 表。样本数因清晰度而异（360p 视频 2919、1080p 视频 3524；1080p 音频 6326）。
- `stsc`：视频 2 个 run（chunk1 每 chunk 3 样本，chunk2 每 chunk 1 样本）；音频 1449 个 run，以 `spc=1`/`spc=2` 交替为主，最后一个 run `first=3522 spc=9`。

> 音频的 `stsc` 这么碎，是因为 AAC 帧长短不一（每 chunk 装不满固定帧数）。实现时**必须真的按 `stsc` 表逐 run 展开**，不能假设「每 chunk 样本数恒定」；否则音频会从第一个 spc 变化处开始错位，表现为声音正常但时长不对或爆音。

解密步骤：

1. 解析 `moov/trak/mdia/minf/stbl`，取 `stsd` 首条目。
2. 在条目里按类型偏移找 `sinf`（`encv` 偏移 78，`enca` 偏移 28）。
3. 从 `sinf/schi/tenc` 读 `perSampleIVSize`、`isProtected`、`KID`。

> **`tenc` 字段偏移不能硬编码。** 标准布局是 `version(1) flags(3) reserved(1) isProtected(1) ivSize(1) KID(16)`，但实测红果样本是 `version(1) flags(3) reserved(2) isProtected(1) ivSize(1) KID(16)` —— 多了一个 reserved 字节。实测 hex：
>
> ```
> 00000000 0000 01 08 6a9024fa…0002ebeb
> └ver──┘ └flg┘ └rsv┘ │  │  └───── KID (16) ─────┘
>                      │  └ ivSize = 8
>                      └ isProtected = 1
> ```
>
> 正确做法是**从尾部反推**：KID 占最后 16 字节，`ivSize` 在其前 1 字节，`isProtected` 再前 1 字节。这样对两种布局都成立。硬编码 `body+6` 在这份样本上刚好能跑，但换成标准布局的文件就会改错字节（把 `isProtected` 写成 `ivSize` 的值）。
4. 从 `senc` 读每样本 IV（8 字节）。**8 字节 IV 是 16 字节计数器块的高半部**，低半部补 0。
5. 用 `stsc`+`stco`/`co64`+`stsz` 算出每个样本的文件偏移与长度。
6. `AES-CTR(key, counter=IV||0^8, length=sample)` 原地解密。
7. 把样本条目类型从 `encv` 改 `hvc1`、`enca` 改 `mp4a`，`tenc.isProtected` 置 0。

**关键点：字节长度完全不变。** 因为不删任何 box、不改任何偏移，所以可以直接在 `Uint8Array` 上原地改，然后 `URL.createObjectURL(new Blob([buf]))` 交给 `<video>`。

实测性能（Chrome，单线程 WebCrypto，5 次取中位数）：

| 样本 | 大小 | 中位耗时 | 区间 | 结果 |
| --- | --- | --- | --- | --- |
| 360p | 4,304,752 B | 61 ms | 60–79 ms | 640×360，97.3s，正常播放 |
| 1080p | 14,764,649 B | 62 ms | 58–306 ms | 1920×1080，146.8s，正常播放 |

首轮（冷启动）会慢：1080p 首轮 261–306 ms，后续稳定在 60 ms 左右，约 240 MB/s。这个速度说明**可以按需解密整集**，不需要流式分片解密。

编码是 `bytevc1`（HEVC）。Chrome 桌面支持 `hvc1`：`mediaCapabilities` 与 `MediaSource.isTypeSupported('video/mp4; codecs="hvc1…"')` 均为 `true`。**Safari 支持，Firefox 在多数平台不支持 HEVC** —— 这是 Web 版的真实兼容性风险，见第 8 节。

参考实现：
- `docs/reference/cenc-decrypt-browser.mjs` — 浏览器版，WebCrypto，原地解密。
- `docs/reference/cenc-decrypt-node.mjs` — Node 版，供离线校验。
- `docs/reference/cenc-decrypt-inplace.mjs` — 只做原地改写的精简版。

**对照验证**：解密后的文件可被 ffmpeg 解码为 `hevc + aac 44.1kHz stereo`，也可用
`ffmpeg -decryption_key <hex> -i enc.mp4 -map 0 -c copy out.mp4` 独立验证密钥正确。

---

## 5. 浏览器直连的障碍（实测）

这一节记录「为什么必须有一个服务端/转发层」，避免后续重复试错。

### 5.1 设备注册没有 CORS

```
OPTIONS https://log5-applog-lq.fqnovel.com/service/2/device_register/
  → 404，无 access-control-allow-* 头
```

浏览器无法发出这个 POST，SDK 在 WASM 里直接报 `TRANSPORT`。

### 5.2 API 预检被拒

```
OPTIONS https://api5-normal-sinfonlinea.fqnovel.com/reading/bookapi/bookmall/tab/v
  Access-Control-Request-Headers: x-gorgon, x-medusa, …
  → 403
```

自定义签名头必然触发预检，预检不过，请求发不出去。

### 5.3 带 Origin 会被判未授权

Node 侧对同一请求只加一个 `Origin: https://example.com`：

```
无 Origin → 200，正常返回数据
有 Origin → AUTHENTICATION_REQUIRED
```

这是**服务端主动的反盗链策略**，不是浏览器限制。所以「让浏览器直接 fetch、靠 CORS 放开」这条路根本不通，即使 CDN 加了 `*` 也没用。

### 5.4 媒体与封面是开放的

实测（`Range: bytes=0-99`）：

```
视频 CDN   → 206  access-control-allow-origin: *
                  content-range: bytes 0-99/<size>
                  accept-ranges: 缺失（但 206 有效，按 Range 支持处理）
剧集封面   → 200  content-type: image/jpeg  ACAO: *
剧集列表封面 → 200  content-type: image/heic  ACAO: *
```

媒体可以跨域 `Range` 拉取。**只有 API 层需要转发。**

> `accept-ranges` 头不一定出现，但实际请求 `Range` 会返回 206。判断能否分段时**不要只看这个头**，直接发一次 `Range: bytes=0-0` 探测更可靠。

### 5.5 「哑转发」方案已验证

在浏览器里加载 `openhongguo.wasm`（配 `wasm_exec.js`，全局 `__openhongguo`），给它一个自定义 `transport`，把请求原样交给同源转发器：

```js
const transport = async (req) => {
  const r = await fetch('/proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body: req.body ? [...req.body] : null }),
  })
  const out = await r.json()
  // cookies 必须原样回传，否则注册票据丢失 —— 见 5.6
  return { status: out.status, headers: out.headers, cookies: out.cookies, body: new Uint8Array(out.body) }
}
```

转发器做三件事：域名白名单、原样转发、回传 `{status, headers, cookies, body}`。

**实测结果**：`discover` 返回 9 条。签名逻辑全部留在浏览器，服务端**不知道**密钥、设备档案或签名算法。

### 5.6 转发器的三个硬性要求（踩坑记录）

这三条都实际踩过，缺一条就失败：

**1. 剥掉传输层响应头**

转发器要删掉 `content-encoding` / `content-length` / `transfer-encoding`。否则 WASM 侧的 gzip 解码会拿到已解压的 body，报 `unsupported content encoding`。

**2. 必须回传解析后的 `cookies` 对象，不能只回 `set-cookie` 头**

这是最隐蔽的一条。SDK 的 transport 契约是：

```ts
Response = { status, headers, cookies?: Record<string, string>, body }
```

`cookies` 是 `{ttreq, store-region, store-region-src, install_id}` 这样的**扁平对象**，不是 `Set-Cookie` 头数组。浏览器 `fetch` 的 `headers` 里读不到 `Set-Cookie`（被 CORS 过滤），所以转发器必须用 `headers.getSetCookie()` 自己解析：

```js
const lines = upstream.headers.getSetCookie?.() ?? []
const cookies = {}
for (const line of lines) {
  const pair = line.split(';', 1)[0]
  const i = pair.indexOf('=')
  if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
}
```

**为什么缺了会失败**：`ttreq` 只在注册响应的 `Set-Cookie` 里，body 里没有。SDK 靠它拼后续请求的 `Cookie` 头。拿不到票据 → `guestReady()` 判定未就绪 → 重注册 → 服务端认为「同一 `req_id` 重复注册」并返回空身份：

```json
{"server_time":1794217368,"device_id":0,"install_id":0,"new_user":0,
 "device_id_str":"0","install_id_str":"0"}
```

HTTP 状态是 200，body 只有 109 字节。SDK 报 `anonymous registration returned no guest identity`。**这个错误信息指向注册，根因在转发器。**

**不传 `cookies` 的后果**：注册响应里的 `ttreq` 票据丢失 → SDK 认为游客未就绪 → 每次调用都重新注册 → 服务端最终返回 `device_id: 0` / `install_id: 0`（HTTP 200，body 只有 109 字节）→ SDK 报 `anonymous registration returned no guest identity`。

实测对比：

| 转发器行为 | `discover` | `listEpisodes` | `resolvePlayback` |
| --- | --- | --- | --- |
| 只回 `set-cookie` 头 | ✅ 有数据 | ✅ 有集数 | ❌ `UNKNOWN anonymous registration returned no guest identity` |
| 回 `cookies` 对象 | ✅ 有数据 | ✅ 有集数 | ✅ 5 档清晰度 + 内容密钥 |

**3. 跨端口要绝对 URL + `access-control-allow-origin: *`**

页面在 8899、转发器在 8902 时，`fetch('/proxy')` 会打到 8899（静态服务器）拿到 501 HTML，`JSON.parse` 报 `Unexpected token '<'`。必须写绝对 URL，并让转发器返回 CORS 头。

### 5.7 浏览器内全链路实测

以上三条都修好后，在 Chrome 里用 WASM SDK + 哑转发器跑通完整链路：

```
discover:        9 items, 3251ms, calls=2
listEpisodes:  117 eps,    183ms, calls=3
resolvePlayback:           127ms, calls=4
streams: 360p,480p,540p,720p,1080p
contentKey: 7ab1ea823678c9932b71a29134817e5f v1
profile persisted: yes (605 bytes)
2nd discover (warm device): 2869ms, calls=6
```

`calls` 是转发次数。第一次 `discover` 只 2 次（注册 + tab），说明设备档案一次注册就复用成功；修复前是 3 次并持续增长。

- `discover` 慢（3.3s）是因为两次响应分别 330 KB 和 890 KB，走 JSON 数组转发有膨胀。生产环境应改成二进制直传（`Content-Type: application/octet-stream` 把 body 原样流过去），或让转发器直接把响应体 `pipe` 回来。
- `listEpisodes` 上百集只花 180–240ms，说明单个小响应很快；`discover` 慢全在那两个 330KB / 890KB 的大响应上。
- 设备档案 605 字节，可以安全放 `localStorage`。

---

## 6. 备用片源（hghub）

`upstream/sdk/hghub/` 是一个独立实现，不复用 openhongguo。它的价值是：当红果接口不可用时还有第二条路。

- 封面加密：AES-128-CBC，key `f5d965df75336270`，IV `97b60394abc2fbe1`。
- 播放：标准 HLS + AES-128（`#EXT-X-KEY`），不需要 CENC。
- 线路：`huangguoai.com` / `huangguoai.ai`。
- 图片基址：`pic.drleao.cn`。
- 分类：`ai-duanju` / `ai-manju` / `ai-huanlian` / `ai-mogai`。

**现状**：站点已迁移到加密通道 `dx150-edge-v1`（ECDH P-256 + HKDF-SHA256 + AES-GCM），端点 `/api/{user,playback,public,dynamic}/request` 在 curl 下全部 404。旧信封 `/api/edge/request` 也已 404。

**结论**：hghub 当前**不可用**，且用户已明确要求不再访问该站点。Web 版不要依赖它。保留记录只是为了说明「为什么这个方向放弃了」。

> 注意：仓库历史里还有第三个片源 `hg2`（目标 APK `com.hg2.two_zero_one` v2.0.1，Flutter）。它在 commit `043c675` 被移除，逆向文档可从 `git show 043c675^:docs/reverse-engineering.md` 恢复。该方向涉及 CloudFront 分发和 `x-api-key` HMAC-SHA1 签名，同样不作为 Web 版主线。

---

## 7. Web 版架构

### 7.1 三种可行形态

| 形态 | 服务端职责 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A. 纯静态 + 哑转发** | 只转发 HTTP | 签名/密钥全在浏览器，服务端无状态，部署最轻 | 仍需一个转发端点（不能纯 GitHub Pages） |
| **B. 静态 + Node SDK** | 跑 `openhongguo`，出解密后数据 | 浏览器零负担，兼容性最好 | 服务端持有设备档案与密钥，有运维成本 |
| **C. 边缘函数** | Cloudflare Worker 等做转发 + 缓存 | 无服务器运维，全球延迟低 | 平台限制（CPU 时间、包大小） |

**建议先做 A**：它把「必须服务端」的部分压到最小（一个 30 行的转发器），其余逻辑都是可测试的纯前端代码。如果后面发现浏览器 HEVC 兼容性不可接受，再升级到 B（B 只是把 A 的转发器换成「转发 + 转码」）。

### 7.2 浏览器方案的真实代价

选 A 形态之前，先看清它把成本挪到了哪里。

**必须接受的三个事实：**

1. **`openhongguo.wasm` 是 6,855,007 字节（6.85 MB）。** 首屏必须下载它才能发第一个 API 请求。压缩后实测：gzip 1.86 MB、brotli(q11) 1.34 MB。按 4G 有效带宽 5–10 Mbps 算，光下载就要 1–2 秒，再加 WASM 编译。
2. **转发器不能省。** 不是「为了跨域顺手加的」，而是 API 层反盗链（`Origin` → `AUTHENTICATION_REQUIRED`）导致的硬约束。任何纯静态托管（GitHub Pages / Vercel 静态 / OSS）都跑不起来。
3. **转发器要能读 `Set-Cookie`。** 浏览器 `fetch` 读不到这个头，所以转发必须在服务端完成解析，把结果作为 JSON 字段回传。这意味着转发器不是「无脑 pipe」，它有 10 行必须写对的逻辑。

**如果这三条都不能接受，就该选 B 形态**：浏览器只拿渲染好的 JSON 和已解密的媒体，服务端承担 WASM、设备档案、密钥、转码。代价是服务端有状态、有运维成本，且内容密钥经过服务端。

### 7.3 模块划分

```
web/
  index.html
  src/
    sdk/            openhongguo.wasm + wasm_exec.js + 封装（transport 注入）
    transport/      同源转发客户端
    drm/
      spade.mjs     spade_a → key（docs/reference/spade-derive.mjs）
      cenc.mjs      CENC 解密（docs/reference/cenc-decrypt-browser.mjs）
    media/
      cache.mjs     解密结果 LRU（内存 + IndexedDB），键 = video_id + definition
      sprite.mjs    雪碧图切片 → 进度条缩略图
    covers.mjs      HEIC 探测与降级（见 7.5）
    state/          播放进度、历史、音量（沿用 localStorage 键名以兼容旧数据）
    ui/             列表 / 搜索 / 播放器 / 历史
  server/
    proxy.mjs       域名白名单转发器（A 形态唯一必需的后端）
```

### 7.4 数据流

```
[UI] 点击剧集
  → sdk.listEpisodes(seriesId)                    经转发器
  → sdk.resolvePlayback(episodeId)                经转发器
  → spade.derive(spade_a)                         本地，得 AES key
  → 选清晰度（默认 720p，按屏幕/网速降级）
  → fetch(videoUrl, { Range })                    直连 CDN，CORS 允许
  → cenc.decrypt(bytes, key)                      本地，原地
  → Blob URL → <video>
  → 进度写 localStorage
```

**密钥永远不进 URL、不进日志、不进 localStorage。** 每次播放时从 `spade_a` 现算。

### 7.5 封面与雪碧图

- 剧集封面：JPEG，直接用。
- 剧集列表/搜索封面：HEIC（`ftypheic`）。浏览器只有 Safari 能显示 HEIC。
- `big_thumbs`：HEIF 雪碧图。

三种处理方式，按部署形态选：

1. **A 形态**：前端探测 HEIC，失败则用 CSS 占位或隐藏封面（不阻塞功能）。可选择性让转发器加一个 `/cover?url=` 端点做转码。
2. **B 形态**：Host 侧用 `ffmpeg`/`sips` 转码并缓存，前端只拿 JPEG。
3. **混合**：转发器只在 `Accept` 不含 `image/heic` 时转码，Safari 直连原图。

注意：封面 URL 带 `x-expires` / `x-signature`，签名覆盖路径与尺寸模板，**不能改尺寸参数**，只能整 URL 透传。

`cover_expires_at` 字段**不可靠**：实测四个接口返回值不一致（discover 返回零值 `0001-01-01T00:00:00Z`、newReleases 返回正确时间、shortRank 直接缺字段、search 返回零值）。要判断封面是否过期，**直接解析 URL 的 `x-expires`**，不要依赖这个字段。

另外，`search` 返回的条目**根本没有 `cover_url`**（实测 5–18 条均无），只有 `id` / `title` / `description` / `episode_count`。搜索页要显示封面，必须先 `listEpisodes(seriesId)` 取第一集封面（JPEG），或多一次 `getSeries` 调用。这是搜索结果无封面的根因，不是 bug。

### 7.6 兼容旧数据

旧插件的 localStorage 键：

```
dsh-hongguo.watch-history.v1
dsh-hongguo.watch-history.v1.volume
dsh-hongguo
```

Web 版沿用同名键，用户从插件迁过来时进度不丢。

---

## 8. 已知风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| **HEVC 兼容性** | 内容是 `bytevc1`（HEVC）。Chrome/Edge/Safari 支持，Firefox 多数平台不支持。 | 检测 `MediaSource.isTypeSupported`；不支持时降级提示，或走 B 形态在服务端转码成 H.264。 |
| **接口随时可变** | 签名算法（`x-gorgon`/`x-medusa`）是黑盒逆向结果，服务端改算法即失效。 | 用 WASM SDK 而不是自己重写签名（SDK 可随 npm 更新）；`sign_test.go` 那组向量只验证「实现对不对」，不验证「服务端还认不认」，后者只能靠线上探测。 |
| **WASM 体积** | 6.85 MB，gzip 1.86 MB、brotli 1.34 MB。首屏必须下载完才能发第一个请求。 | brotli + 长缓存（文件名带 hash）；或用 B 形态把 WASM 留在服务端。 |
| **匿名配额** | 单设备 25 次连续播放正常，但配额上限未测出。 | 复用设备档案；触发 `ANONYMOUS_LIMITED` 时重置；不要每次刷新都注册新设备。 |
| **URL 寿命** | 播放地址约 6 小时（`url_expire` 与 `expires_at` 一致）。 | 播放前检查 `expires_at`，剩余不足 5 分钟就重取。 |
| **转发器被滥用** | 开放转发等于开放 API。 | 域名白名单 + 速率限制 + 只允许签名后的请求形态。 |
| **法律与合规** | 这是第三方客户端，绕过 DRM 与反盗链。 | 仅个人研究，不公开部署、不分发解密后内容。 |

---

## 9. 待决问题

1. **部署形态**：A（哑转发）还是 B（Node SDK）？取决于是否接受 HEVC 兼容性损失。
2. **技术栈**：React/Vue/Svelte/原生？上游是 React，复用 `client.js` 的 UI 逻辑成本最低。
3. **清晰度策略**：默认 720p？是否提供手动切换？
4. **是否保留 hghub 备用源**：当前不可用，建议删掉。
5. **雪碧图缩略图**是否做：需要 HEIF 解码，成本不低。

---

## 10. 复现清单

想从头验证本文任一结论，按下面顺序做。

### 10.1 准备 SDK

```bash
mkdir -p /tmp/ohg && cd /tmp/ohg
npm pack openhongguo@0.1.0 && tar xzf openhongguo-0.1.0.tgz
cd /tmp/probe && npm i /tmp/ohg/package
```

### 10.2 验证接口可用

```bash
node -e "
import('openhongguo').then(async (m) => {
  const c = await m.createClient({ profile: m.memoryProfileStore(), retryAttempts: 1 })
  const p = await c.discover({})
  console.log(p.items.length, p.items[0].title)
})"
```

期望：输出条数与第一条标题。失败说明 IP 被限或接口变了。

### 10.3 验证密钥还原

抓一集的 `spade_a`，与 SDK 的 `contentKey` 对比：

在 SDK 装好的目录里运行（`import 'openhongguo'` 需要能解析到包）：

```bash
node --input-type=module -e "
import { deriveContentKey } from '/abs/path/to/docs/reference/spade-derive.mjs'
import { createClient, memoryProfileStore, nodeTransport } from 'openhongguo'
import { gunzipSync } from 'node:zlib'

const inner = nodeTransport({ timeoutMs: 30000 })
let raw
const transport = async (req) => {
  const res = await inner(req)
  if (/video_model/.test(req.url)) {
    let body = Buffer.from(res.body)
    if ((res.headers['content-encoding'] || '') === 'gzip') { try { body = gunzipSync(body) } catch {} }
    raw = body.toString('utf8')
  }
  return res
}
const c = await createClient({ profile: memoryProfileStore(), retryAttempts: 1, transport })
const page = await c.discover({})
const eps = await c.listEpisodes(page.items[0].id)
const play = await c.resolvePlayback(eps.items[0].id)
const model = JSON.parse(JSON.parse(raw).data.video_model)
const mine = deriveContentKey(model.video_list[0].encrypt_info.spade_a)
console.log('sdk ', play.contentKey.key)
console.log('mine', mine.key)
console.log('match', mine.key === play.contentKey.key)
"
```

期望：`match true`。

### 10.4 验证 CENC 解密（Node，离线）

```bash
# 先下载一集加密样本和它的密钥，再用 inplace 解密
node -e "
import('openhongguo').then(async (m) => {
  const fs = await import('node:fs')
  const c = await m.createClient({ profile: m.memoryProfileStore(), retryAttempts: 1 })
  const p = await c.discover({})
  const eps = await c.listEpisodes(p.items[0].id)
  const play = await c.resolvePlayback(eps.items[0].id)
  const s = play.playback.streams.at(-1)
  const buf = Buffer.from(await (await fetch(s.url)).arrayBuffer())
  fs.writeFileSync('/tmp/probe/enc.mp4', buf)
  fs.writeFileSync('/tmp/probe/fx.json', JSON.stringify({ key: play.contentKey.key, definition: s.definition }))
  console.log('saved', s.definition, buf.length)
})"

node docs/reference/cenc-decrypt-inplace.mjs /tmp/probe/enc.mp4 $(node -p "require('/tmp/probe/fx.json').key") /tmp/probe/plain.mp4
ffprobe -v error -show_entries stream=codec_name,width,height -of default=nw=1 /tmp/probe/plain.mp4
```

期望：`ffprobe` 输出 `codec_name=hevc` 与正确分辨率，`ffmpeg -v error -i plain.mp4 -f null -` 无报错。

### 10.5 验证浏览器全链路

```bash
# 页面 8899，转发器 8902
node docs/reference/proxy.mjs 8902 &
python3 -m http.server 8899 -d /tmp/probe &

# 把 wasm 与 wasm_exec.js 放进 /tmp/probe（从 /tmp/ohg/package/dist 取）
cp /tmp/ohg/package/dist/openhongguo.wasm /tmp/probe/
cp $(dirname $(node -p "require.resolve('openhongguo')"))/wasm_exec.js /tmp/probe/ 2>/dev/null || true

# 打开 http://127.0.0.1:8899/wasm-full.html
```

期望输出见 5.7。若 `resolvePlayback` 报 `no guest identity`，检查转发器是否回传了 `cookies` 对象（5.6 第 2 条）。

### 10.6 文件对照

| 文件 | 用途 | 持久性 |
| --- | --- | --- |
| `docs/reference/spade-derive.mjs` | spade_a → 内容密钥 | ✅ 已入库 |
| `docs/reference/cenc-decrypt-browser.mjs` | 浏览器 CENC 解密（WebCrypto） | ✅ 已入库 |
| `docs/reference/cenc-decrypt-node.mjs` | Node CENC 解密（带 box 诊断输出） | ✅ 已入库 |
| `docs/reference/cenc-decrypt-inplace.mjs` | 原地改写精简版（命令行） | ✅ 已入库 |
| `docs/reference/proxy.mjs` | 同源转发器（含 `cookies` 解析） | ✅ 已入库 |
| `docs/reference/wasm-full.html` | 浏览器内 WASM 全链路验证页 | ✅ 已入库 |
| `/tmp/probe/enc*.mp4` | 加密样本（需自行下载） | ⚠️ 临时 |
| `/tmp/ohgsrc/internal/protocol/sign/sign_test.go` | 签名算法验收向量 | ⚠️ 临时 |
| `/tmp/ohgsrc/internal/drm/spade.go` | spade_a 参考实现 | ⚠️ 临时 |
