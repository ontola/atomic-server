package dev.atomicdata

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class StoreTest {
    private fun memoryStore(): Store {
        val store = Store.inMemory()
        store.setup("Test agent")
        return store
    }

    @Test
    fun setupCreatesAgentAndDrive() {
        val store = Store.inMemory()
        assertNull(store.agent())
        assertNull(store.activeDrive())

        val info = store.setup("Ada")
        assertTrue(info.agentSubject.startsWith("did:ad:agent:"))
        assertTrue(info.driveSubject.startsWith("did:ad:"))
        assertTrue(info.agentSecret.isNotEmpty())
        assertEquals(info.driveSubject, store.activeDrive())
        assertTrue(store.has(info.driveSubject))
        assertEquals(1, store.drives().size)
    }

    @Test
    fun createReadUpdate() {
        val store = memoryStore()
        val note = store.create(
            Urls.PLAIN_TEXT,
            "Hello",
            null,
            mapOf("description" to "first draft"),
        )
        assertTrue(note.subject().startsWith("did:ad:"))
        assertEquals("Hello", note.get("name"))
        assertEquals("first draft", note.get("description"))
        assertTrue(note.contains(Urls.PARENT))

        note.set("description", "second draft")
        note.setName("Hello again")
        note.save()

        val got = store.get(note.subject())
        assertNotNull(got)
        assertEquals("Hello again", got.get("name"))
        assertEquals("second draft", got.get("description"))
    }

    @Test
    fun queryByParentAndClass() {
        val store = memoryStore()
        val drive = store.activeDrive()!!
        val folder = store.create(Urls.FOLDER, "Alpha", null, null)
        val text = store.create(
            Urls.PLAIN_TEXT,
            "Beta",
            null,
            mapOf("description" to "body"),
        )
        store.create(
            Urls.PLAIN_TEXT,
            "Gamma",
            null,
            mapOf("description" to "body"),
        )

        val names = store.query(drive, null, null, null, null, 0u).mapNotNull { it.name() }
        assertContains(names, "Alpha")
        assertContains(names, "Beta")
        assertContains(names, "Gamma")

        val folders = store.query(drive, Urls.FOLDER, null, null, null, 0u)
        assertEquals(1, folders.size)
        assertEquals(folder.subject(), folders[0].subject())

        val texts = store.query(null, Urls.PLAIN_TEXT, null, null, null, 0u)
        val subjects = texts.map { it.subject() }
        assertContains(subjects, text.subject())
        assertFalse(subjects.contains(folder.subject()))
    }

    @Test
    fun destroyResourceRemovesIt() {
        val store = memoryStore()
        val folder = store.create(Urls.FOLDER, "Tmp", null, null)
        val subject = folder.subject()
        folder.destroyResource()
        assertFalse(store.has(subject))
        assertNull(store.get(subject))
    }

    @Test
    fun deleteRemovesResource() {
        val store = memoryStore()
        val folder = store.create(Urls.FOLDER, "ephemeral", null, null)
        val subject = folder.subject()
        store.delete(subject)
        assertNull(store.get(subject))
    }

    @Test
    fun missingGetReturnsNull() {
        val store = memoryStore()
        assertNull(store.get("did:ad:does-not-exist"))
    }

    @Test
    fun createRequiresParentOrDrive() {
        val store = Store.inMemory()
        store.createAgent("No drive")
        val err = assertFailsWith<AtomicSdkException> {
            store.create(Urls.FOLDER, "orphan", null, null)
        }
        assertContains(err.message ?: "", "parent or an active drive")
    }

    @Test
    fun independentInMemoryStores() {
        val a = Store.inMemory()
        val b = Store.inMemory()
        val setupA = a.setup("A")
        b.setup("B")
        val note = a.create(Urls.FOLDER, "only-in-a", null, null)
        assertNull(b.get(note.subject()))
        assertNotNull(a.get(setupA.driveSubject))
    }

    @Test
    fun toJsonIncludesSubject() {
        val store = memoryStore()
        val note = store.create(Urls.FOLDER, "serial", null, null)
        val json = note.toJson()
        assertContains(json, note.subject())
        assertContains(json, "serial")
    }

    @Test
    fun reopenFileStore() {
        val dir = Files.createTempDirectory("atomic-ffi-kt")
        val path = dir.toAbsolutePath().toString()

        val (subject, secret, drive) = run {
            val store = Store.open(path)
            val setup = store.setup("Ada")
            val note = store.create(
                Urls.PLAIN_TEXT,
                "Persisted",
                null,
                mapOf("description" to "on disk"),
            )
            val result = Triple(note.subject(), setup.agentSecret, setup.driveSubject)
            store.flush()
            note.close()
            store.close()
            result
        }

        run {
            val store = Store.open(path)
            val loaded = store.get(subject)
            assertNotNull(loaded)
            assertEquals("Persisted", loaded.get("name"))
            assertEquals("on disk", loaded.get("description"))
            assertTrue(store.has(drive))
            store.loadAgent(secret)
            store.setActiveDrive(drive)
            loaded.set("description", "edited after reopen")
            loaded.save()
            store.flush()
            loaded.close()
            store.close()
        }

        val store = Store.open(path)
        val got = store.get(subject)
        assertNotNull(got)
        assertEquals("edited after reopen", got.get("description"))
        store.close()
    }

    @Test
    fun bundledSchemaIsLocal() {
        val store = Store.inMemory()
        assertTrue(store.has(Urls.NAME))
        val prop = store.get(Urls.NAME)
        assertNotNull(prop)
        assertTrue(prop.get("shortname") != null || prop.get("name") != null)
        prop.close()
        store.close()
    }

    @Test
    fun searchRequiresServer() {
        val store = Store.inMemory()
        val err = assertFailsWith<AtomicSdkException> { store.search("folder", null) }
        assertContains(err.message ?: "", "server")
        store.close()
    }

    @Test
    fun serverGetterSetter() {
        val store = Store.inMemory()
        assertNull(store.server())
        store.setServer("https://atomicdata.dev")
        assertEquals("https://atomicdata.dev", store.server())
        store.close()

        val withServer = Store.inMemory("https://example.com")
        assertEquals("https://example.com", withServer.server())
        withServer.close()
    }

    @Test
    fun getFetchesHttpSchemaResource() {
        val store = Store.inMemory()
        val subject = "https://atomicdata.dev"
        assertFalse(store.has(subject))
        val resource = store.get(subject)
        org.junit.jupiter.api.Assumptions.assumeTrue(
            resource != null,
            "https://atomicdata.dev not reachable",
        )
        assertTrue(resource!!.subject().startsWith("https://"))
        assertTrue(store.has(subject))
        resource.close()
        store.close()
    }
}
