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

android {
    namespace = "com.mlzwl.hongguo.shell"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.mlzwl.hongguo.shell"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
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
