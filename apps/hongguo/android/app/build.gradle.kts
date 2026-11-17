import java.util.Properties

plugins {
    id("com.android.application")
}

// 签名材料只从环境变量或 local.properties 读，绝不写进仓库。
//
// 两条路径：
//   - 找到 keystore 与四项参数 → 产出已签名 APK。
//   - 缺任何一项 → 产出 app-release-unsigned.apk，构建不失败。
//
// 这样本地开发无需配置签名也能 assembleRelease，CI 则在 secrets 齐全时
// 直接出可安装的签名包。优先级：环境变量 > local.properties。
//
// local.properties 已在 .gitignore 里，是 Android 官方约定的本机配置入口。
val localProperties = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) {
        f.inputStream().use { load(it) }
    }
}

fun signingValue(envName: String, propertyName: String): String? =
    System.getenv(envName)?.takeIf { it.isNotBlank() }
        ?: localProperties.getProperty(propertyName)?.takeIf { it.isNotBlank() }

val hgKeystorePath = signingValue("HG_KEYSTORE_FILE", "hg.keystore.file")
val hgKeystorePassword = signingValue("HG_KEYSTORE_PASSWORD", "hg.keystore.password")
val hgKeyAlias = signingValue("HG_KEY_ALIAS", "hg.key.alias")
val hgKeyPassword = signingValue("HG_KEY_PASSWORD", "hg.key.password")

// keystore 路径相对本模块目录（app/）解析，与 Gradle 的默认约定一致。
val hgKeystoreFile = hgKeystorePath?.let { file(it) }
val hasSigningMaterial =
    hgKeystoreFile != null && hgKeystoreFile.exists() &&
        hgKeystorePassword != null && hgKeyAlias != null && hgKeyPassword != null

if (!hasSigningMaterial) {
    logger.lifecycle(
        "hongguo: 未找到签名材料，assembleRelease 将产出 unsigned APK。" +
            "配置方法见 apps/hongguo/android/README.md 的「CI 构建与签名」一节。",
    )
}

/*
 * 版本基号。整个仓库只有这一处定义，workflow 不重复写。
 *
 * 发正式版时改这里：`0.1.0` → `0.2.0`。`versionCode` 不跟着改，它由 CI 的
 * `run_number` 递增维护，人工不干预。
 */
val baseVersion = "0.1.0"

android {
    namespace = "com.mlzwl.hongguo.shell"
    compileSdk = 36

    /*
     * 版本号由 CI 注入，本地构建回退到固定值。
     *
     * ## 为什么不写死
     *
     * 写死 `versionCode = 1` 时，每次 CI 产物都是同一个版本号：
     * - Android 靠 `versionCode` 判断升级，同值只能靠 `adb install -r` 覆盖，
     *   系统「应用信息」里永远显示同一个 `versionName`。
     * - 下载回来的 artifact 名字恒为 `hongguo-shell-release`，不记 run id
     *   就分不清哪个包含哪次修复。
     *
     * ## 取值约定
     *
     * | 环境变量             | 来源                | 例        |
     * | -------------------- | ------------------- | --------- |
     * | `HG_VERSION_CODE`    | `github.run_number` | `7`       |
     * | `HG_GIT_SHA`         | commit 短 SHA       | `979826a` |
     *
     * `versionCode` 用 `run_number` 而不是 commit 计数：它严格单调递增，
     * 被取消的 run 也消耗序号，不会出现两个产物同号。
     *
     * `versionName` 由本文件拼装，基号 `baseVersion` 只在这里出现一次，
     * workflow 不需要重复写：
     *
     * - CI：`0.1.0+7.g979826a`（`+` 后是 semver 构建元数据）
     * - 本地：`0.1.0`
     *
     * ## 降级安装会被拒
     *
     * `versionCode` 一旦开始递增，装回旧包会被系统拒绝（`INSTALL_FAILED_
     * VERSION_DOWNGRADE`）。这是 Android 的既定行为，不是本配置的缺陷；
     * 需要回退时先 `adb uninstall`，代价是清掉本地数据（收藏、历史）。
     *
     * ## 对构建可复现性的影响
     *
     * 版本号进了 APK，CI 与本地产物不再字节相同。要恢复可复现，两边必须
     * 传同一组 `HG_VERSION_CODE` / `HG_GIT_SHA`。README 的「构建可复现」
     * 一节已同步说明。
     */
    val injectedVersionCode = System.getenv("HG_VERSION_CODE")?.trim()?.toIntOrNull()
    val injectedGitSha = System.getenv("HG_GIT_SHA")?.trim()?.takeIf { it.isNotEmpty() }

    defaultConfig {
        applicationId = "com.mlzwl.hongguo.shell"
        minSdk = 26
        targetSdk = 36
        versionCode = injectedVersionCode ?: 1
        versionName = if (injectedVersionCode == null) {
            baseVersion
        } else {
            // `github.sha` 是 40 位完整 SHA。截到 7 位：与 `git log --oneline`
            // 一致，用户能直接比对；versionName 太长在「应用信息」里会被截断。
            val sha = injectedGitSha?.take(7)?.let { ".g$it" } ?: ""
            "$baseVersion+$injectedVersionCode$sha"
        }
    }

    // signingConfigs 必须先于 buildTypes 声明，否则 getByName("release") 会抛异常。
    signingConfigs {
        if (hasSigningMaterial) {
            create("release") {
                storeFile = hgKeystoreFile
                storePassword = hgKeystorePassword
                keyAlias = hgKeyAlias
                keyPassword = hgKeyPassword
                // v1 供 minSdk 26 以下兼容；v2/v3 是当前主流。
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        debug {
            // 调试期直接从 Vite dev server 加载，便于热更新。
            isMinifyEnabled = false
            buildConfigField("String", "SHELL_START_URL", "\"http://10.0.2.2:5173/\"")
        }
        release {
            // 发布期由 WebViewAssetLoader 托管打包进 APK 的 web/dist。
            isMinifyEnabled = false
            buildConfigField("String", "SHELL_START_URL", "\"https://appassets.androidplatform.net/index.html\"")

            // 有签名材料就签，没有就留空让 AGP 产出 unsigned。
            if (hasSigningMaterial) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // web/dist 由仓库根的 pnpm hongguo:build 产出；这里只读取，不生成。
    // 路径基准是本模块目录（app/），所以回退两级到 apps/hongguo/。
    sourceSets["main"].assets.directories.add("src/main/assets")
    sourceSets["main"].assets.directories.add("../../web/dist")

    // 调试期留在 assets 里的样本文件不能进包。它们已在 .gitignore 里，但
    // Gradle 扫的是目录而不是 git 索引，不排除就会被静默打进 APK，
    // 造成本地产物与 CI 产物不一致（实测差 1.2 MB）。
    androidResources {
        ignoreAssetsPattern = "hevc-sample.mp4"
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.18.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("com.squareup.okhttp3:okhttp:5.4.0")
}

// AGP 9 已内置 Kotlin 支持，不再需要 org.jetbrains.kotlin.android 插件（它与新 DSL 不兼容）。
// 但 jvmTarget 仍需显式声明，否则依赖内置默认值。
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}
