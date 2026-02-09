package com.ontola.atomiccanvas_flutter

import android.content.Intent
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity: FlutterActivity() {
    private val CHANNEL = "app.atomicdata.canvas/deeplink"
    private var initialLink: String? = null
    private var channel: MethodChannel? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
        channel?.setMethodCallHandler { call, result ->
            when (call.method) {
                "getInitialLink" -> {
                    result.success(initialLink)
                    initialLink = null
                }
                "getDeviceName" -> {
                    result.success(Build.MODEL ?: "Android")
                }
                else -> result.notImplemented()
            }
        }
        // Check if launched from a deep link
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent) {
        if (intent.action == Intent.ACTION_VIEW) {
            val uri = intent.data?.toString()
            if (uri != null && uri.startsWith("did:ad:node:")) {
                if (channel != null) {
                    channel?.invokeMethod("onNewLink", uri)
                } else {
                    initialLink = uri
                }
            }
        }
    }
}
