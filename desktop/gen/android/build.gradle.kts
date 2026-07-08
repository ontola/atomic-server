buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}

// rustls-platform-verifier (reqwest's TLS certificate verifier on Android)
// needs its Kotlin component bundled in the APK. The AAR ships inside the
// rustls-platform-verifier-android crate; resolve its maven repo through
// cargo metadata so the Gradle dependency stays in lockstep with Cargo.lock.
val rustlsPlatformVerifierPackage: Map<String, String> = run {
    val metadataText = providers.exec {
        workingDir = File(rootDir, "../..")
        commandLine("cargo", "metadata", "--format-version", "1", "--locked")
    }.standardOutput.asText.get()

    @Suppress("UNCHECKED_CAST")
    val json = groovy.json.JsonSlurper().parseText(metadataText) as Map<String, Any?>

    @Suppress("UNCHECKED_CAST")
    val packages = json["packages"] as List<Map<String, Any?>>
    val pkg = packages.first { it["name"] == "rustls-platform-verifier-android" }
    mapOf(
        "repo" to File(pkg["manifest_path"] as String).parentFile.resolve("maven").absolutePath,
        "version" to pkg["version"] as String,
    )
}

extra["rustlsPlatformVerifierVersion"] = rustlsPlatformVerifierPackage["version"]

allprojects {
    repositories {
        google()
        mavenCentral()
        maven {
            url = uri(rustlsPlatformVerifierPackage["repo"]!!)
        }
    }
}

tasks.register("clean").configure {
    delete("build")
}

