plugins {
    id("com.android.application")
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
