package dev.atomicdata

import java.io.File

/**
 * Second OS process for the Iroh P2P test. Invoked by [IrohTest].
 */
object IrohPeerChild {
    @JvmStatic
    fun main(args: Array<String>) {
        val handshakePath = args[0]
        val storePath = args[1]
        val donePath = args[2]
        val hs = parseObject(File(handshakePath).readText())
        val store = Store.open(storePath)
        store.loadAgent(hs.getValue("secret"))
        store.startPeer()
        val report = store.syncWith(hs.getValue("node_id"), hs["drive"])
        val got = store.get(hs.getValue("subject"))
        val ok = got != null && got.get("name") == hs["name"]
        File(donePath).writeText(
            buildString {
                append("{")
                append("\"ok\":").append(ok).append(',')
                append("\"imported\":").append(report.imported).append(',')
                append("\"pushed\":").append(report.pushed).append(',')
                append("\"in_sync\":").append(report.inSync).append(',')
                append("\"name\":").append(jsonString(got?.get("name"))).append(',')
                append("\"has_drive\":").append(store.has(hs.getValue("drive"))).append(',')
                append("\"child_peer\":").append(jsonString(store.peerId()))
                append("}")
            },
        )
    }

    private fun parseObject(raw: String): Map<String, String> {
        val body = raw.trim().removePrefix("{").removeSuffix("}")
        val out = mutableMapOf<String, String>()
        var i = 0
        while (i < body.length) {
            val keyStart = body.indexOf('"', i)
            if (keyStart < 0) break
            val keyEnd = body.indexOf('"', keyStart + 1)
            val colon = body.indexOf(':', keyEnd + 1)
            val valueStart = body.indexOf('"', colon + 1)
            val valueEnd = body.indexOf('"', valueStart + 1)
            out[body.substring(keyStart + 1, keyEnd)] = body.substring(valueStart + 1, valueEnd)
            i = valueEnd + 1
        }
        return out
    }

    private fun jsonString(value: String?): String =
        if (value == null) "null" else "\"${value.replace("\"", "\\\"")}\""
}
