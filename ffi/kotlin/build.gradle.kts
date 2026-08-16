plugins {
    kotlin("jvm") version "2.0.21"
}

group = "dev.atomicdata"
version = "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    implementation("net.java.dev.jna:jna:5.17.0")
    testImplementation(kotlin("test"))
}

kotlin {
    jvmToolchain(21)
}

val nativeLibDir = file("${rootProject.projectDir}/../target/debug")

tasks.test {
    useJUnitPlatform()
    maxParallelForks = 1
    workingDir = rootProject.projectDir
    systemProperty("jna.library.path", nativeLibDir.absolutePath)
    systemProperty("java.library.path", nativeLibDir.absolutePath)
    environment("LD_LIBRARY_PATH", nativeLibDir.absolutePath)
    // Iroh two-process test talks to the n0 relay.
    testLogging {
        events("passed", "skipped", "failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
