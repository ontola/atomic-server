"""File-backed store survives close + reopen."""

from atomic_data import Store, urls


def test_reopen_reads_and_writes(tmp_path):
    path = tmp_path / "atomic-store"

    store = Store.open(str(path))
    setup = store.setup("Ada")
    note = store.create(
        urls.PLAIN_TEXT,
        name="Persisted",
        description="on disk",
    )
    subject = note.subject
    store.flush()
    del store

    reopened = Store.open(str(path))
    # Agent is in-memory only; the graph is on disk.
    assert reopened.agent() is None
    loaded = reopened.get(subject)
    assert loaded is not None
    assert loaded["name"] == "Persisted"
    assert loaded["description"] == "on disk"
    assert reopened.has(setup.drive_subject)

    agent = reopened.load_agent(setup.agent_secret)
    assert agent.subject == setup.agent_subject
    assert agent.drive_needs_sync is False
    reopened.active_drive = setup.drive_subject

    loaded["description"] = "edited after reopen"
    loaded.save()
    reopened.flush()
    del reopened

    again = Store.open(str(path))
    got = again.get(subject)
    assert got is not None
    assert got["description"] == "edited after reopen"


def test_context_manager_flushes(tmp_path):
    path = tmp_path / "ctx-store"
    subject = None
    with Store.open(str(path)) as store:
        store.setup("Ada")
        note = store.create(urls.FOLDER, name="Ctx")
        subject = note.subject

    reopened = Store.open(str(path))
    assert reopened.get(subject) is not None
    assert reopened.get(subject)["name"] == "Ctx"
