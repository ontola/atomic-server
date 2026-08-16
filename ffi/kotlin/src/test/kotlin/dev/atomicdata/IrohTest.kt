package dev.atomicdata

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.TestMethodOrder

@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class IrohTest {
    @Test
    @Order(1)
    fun syncWithRequiresStartPeer() {
        val store = Store.inMemory()
        store.setup("Ada")
        val err =
            assertFailsWith<AtomicSdkException> {
                store.syncWith("did:ad:node:" + "ab".repeat(32), null)
            }
        assertContains(err.message ?: "", "startPeer")
    }

    @Test
    @Order(2)
    fun knownPeersPersistLocally() {
        val store = Store.inMemory()
        store.setup("Ada")
        store.addPeer("did:ad:node:" + "cd".repeat(32), "Phone")
        val peers = store.peers()
        assertEquals(1, peers.size)
        assertEquals("Phone", peers[0].name)
        assertTrue(peers[0].nodeId.startsWith("did:ad:node:"))
    }

    @Test
    @Order(3)
    fun waitForTimesOut() {
        val store = Store.inMemory()
        store.setup("Ada")
        val err =
            assertFailsWith<AtomicSdkException> {
                store.waitFor("did:ad:does-not-change", 0.2)
            }
        assertContains(err.message ?: "", "timed out")
    }

    @Test
    @Order(4)
    fun twoProcessIrohSync() {
        // startPeer is process-global. This must be the only test in this
        // JVM that starts Iroh, and it must own the store the node serves.
        val tmp = Files.createTempDirectory("atomic-ffi-iroh")
        val pathA = tmp.resolve("a").toString()
        val pathB = tmp.resolve("b").toString()
        val handshake = tmp.resolve("handshake.json")
        val done = tmp.resolve("done.json")

        val store = Store.open(pathA)
        val setup = store.setup("Ada")
        store.setDeviceName("junit-parent")
        val node = store.startPeer()
        assertTrue(node.startsWith("did:ad:node:"))
        assertEquals(node, store.peerId())
        val note = store.create(Urls.FOLDER, "From A", null, null)
        store.flush()
        handshake.toFile().writeText(
            """
            {"node_id":"$node","secret":"${setup.agentSecret}","drive":"${setup.driveSubject}","subject":"${note.subject()}","name":"From A"}
            """.trimIndent(),
        )

        val child = spawnChild(handshake, pathB, done)
        try {
            val deadline = System.currentTimeMillis() + 90_000
            while (
                System.currentTimeMillis() < deadline && child.isAlive && !Files.exists(done)
            ) {
                Thread.sleep(250)
            }
            if (!Files.exists(done)) {
                child.destroyForcibly()
                val out = child.inputStream.bufferedReader().readText()
                throw AssertionError("child did not finish Iroh sync:\n$out")
            }
            val report = done.toFile().readText()
            assertTrue("\"ok\":true" in report, report)
            assertTrue("\"has_drive\":true" in report, report)
            val imported = Regex("\"imported\":(\\d+)").find(report)?.groupValues?.get(1)?.toInt()
            assertTrue((imported ?: 0) >= 1, report)
        } finally {
            if (child.isAlive) {
                child.destroyForcibly()
                child.waitFor()
            }
        }
    }

    private fun spawnChild(handshake: Path, storePath: String, done: Path): Process {
        val java = ProcessHandle.current().info().command().orElse("java")
        val cp = System.getProperty("java.class.path")
        val jna = System.getProperty("jna.library.path")
        val javaLib = System.getProperty("java.library.path")
        return ProcessBuilder(
                java,
                "-Djna.library.path=$jna",
                "-Djava.library.path=$javaLib",
                "-cp",
                cp,
                "dev.atomicdata.IrohPeerChild",
                handshake.toString(),
                storePath,
                done.toString(),
            )
            .redirectErrorStream(true)
            .start()
    }
}
