"""Local read / write / query against an in-memory atomic_lib store."""

import json

import pytest

from atomic_data import Store, urls


@pytest.fixture
def store():
    s = Store.in_memory()
    s.setup("Test agent")
    return s


def test_setup_creates_agent_and_drive():
    store = Store.in_memory()
    assert store.agent() is None
    assert store.active_drive is None

    info = store.setup("Ada")

    assert info.agent_subject.startswith("did:ad:agent:")
    assert info.drive_subject.startswith("did:ad:")
    assert info.agent_secret
    assert store.active_drive == info.drive_subject
    agent = store.agent()
    assert agent is not None
    assert agent.subject == info.agent_subject
    assert store.has(info.drive_subject)


def test_create_read_update(store):
    note = store.create(
        urls.PLAIN_TEXT,
        name="Hello",
        description="first draft",
    )
    assert note.subject.startswith("did:ad:")
    assert note["name"] == "Hello"
    assert note["description"] == "first draft"
    assert urls.PARENT in note
    assert note[urls.IS_A] == [urls.PLAIN_TEXT]

    note["description"] = "second draft"
    note["name"] = "Hello again"
    note.save()

    got = store.get(note.subject)
    assert got is not None
    assert got["name"] == "Hello again"
    assert got["description"] == "second draft"


def test_shortname_and_url_keys(store):
    note = store.create(urls.FOLDER, name="Docs")
    note.set(urls.DESCRIPTION, "folder")
    note.save()

    got = store.get(note.subject)
    assert got["description"] == "folder"
    assert got[urls.DESCRIPTION] == "folder"
    assert got.get("missing") is None
    assert got.get("missing", "fallback") == "fallback"


def test_value_types_roundtrip(store):
    note = store.create(urls.PLAIN_TEXT, name="types")
    note["description"] = "text"
    note.set("https://example.com/properties/count", 7)
    note.set("https://example.com/properties/flag", True)
    note.set("https://example.com/properties/ratio", 1.5)
    note.set("https://example.com/properties/tags", ["did:ad:a", "did:ad:b"])
    note.set("https://example.com/properties/payload", {"k": 1})
    note.save()

    got = store.get(note.subject)
    assert got["https://example.com/properties/count"] == 7
    assert got["https://example.com/properties/flag"] is True
    assert got["https://example.com/properties/ratio"] == 1.5
    assert got["https://example.com/properties/tags"] == ["did:ad:a", "did:ad:b"]
    assert got["https://example.com/properties/payload"] == {"k": 1}


def test_query_by_parent_and_class(store):
    drive = store.active_drive
    a = store.create(urls.FOLDER, name="Alpha")
    b = store.create(urls.PLAIN_TEXT, name="Beta")
    store.create(urls.PLAIN_TEXT, name="Gamma")

    children = store.query(parent=drive)
    names = {c.name for c in children}
    assert {"Alpha", "Beta", "Gamma"} <= names

    folders = store.query(parent=drive, class_url=urls.FOLDER)
    assert {f.subject for f in folders} == {a.subject}

    texts = store.query(class_url=urls.PLAIN_TEXT)
    subjects = {t.subject for t in texts}
    assert b.subject in subjects
    assert a.subject not in subjects


def test_delete_removes_resource(store):
    # Folder has no extra required props; destroy/save validate schema.
    note = store.create(urls.FOLDER, name="ephemeral")
    subject = note.subject
    assert store.get(subject) is not None

    store.delete(subject)
    assert store.get(subject) is None


def test_resource_destroy(store):
    note = store.create(urls.FOLDER, name="bye")
    subject = note.subject
    note.destroy()
    assert store.get(subject) is None


def test_to_dict_and_json(store):
    note = store.create(urls.PLAIN_TEXT, name="serial")
    as_dict = note.to_dict()
    assert as_dict["@id"] == note.subject
    assert as_dict[urls.NAME] == "serial"

    parsed = json.loads(note.to_json())
    assert parsed["@id"] == note.subject
    assert parsed[urls.NAME] == "serial"


def test_missing_get_returns_none(store):
    assert store.get("did:ad:does-not-exist") is None


def test_create_requires_parent_or_drive():
    store = Store.in_memory()
    store.create_agent("No drive")
    with pytest.raises(ValueError, match="parent or an active drive"):
        store.create(urls.FOLDER, name="orphan")


def test_independent_in_memory_stores():
    a = Store.in_memory()
    b = Store.in_memory()
    setup_a = a.setup("A")
    b.setup("B")
    note = a.create(urls.PLAIN_TEXT, name="only-in-a")
    assert b.get(note.subject) is None
    assert a.get(setup_a.drive_subject) is not None


def test_bundled_schema_is_local():
    store = Store.in_memory()
    assert store.has(urls.NAME)
    prop = store.get(urls.NAME)
    assert prop is not None
    assert prop.get("shortname") or prop.get("name")


def test_search_requires_server():
    store = Store.in_memory()
    with pytest.raises(ValueError, match="server"):
        store.search("folder")


def test_server_getter_setter():
    store = Store.in_memory()
    assert store.server is None
    store.server = "https://atomicdata.dev"
    assert store.server == "https://atomicdata.dev"
    with_server = Store.in_memory(server="https://example.com")
    assert with_server.server == "https://example.com"


def test_get_fetches_http_schema_resource():
    """Unknown https:// subjects are loaded with HTTP GET (schema fetch)."""
    store = Store.in_memory()
    subject = "https://atomicdata.dev"
    assert not store.has(subject)
    resource = store.get(subject)
    if resource is None:
        pytest.skip("https://atomicdata.dev not reachable")
    assert resource.subject.startswith("https://")
    assert store.has(subject)


def test_save_remote_posts_over_http(store):
    store.server = "http://127.0.0.1:1"
    note = store.create(urls.FOLDER, name="remote")
    with pytest.raises(RuntimeError):
        note.save_remote()
