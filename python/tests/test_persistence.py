"""File-backed store survives close + reopen.

redb holds an exclusive file lock for as long as any `Store` or `Resource`
handle is alive (both clone the same `Db`). Tests that reopen must drop
every handle first — a nested function is the reliable way to do that.
"""

from atomic_data import Store, urls


def test_reopen_reads_and_writes(tmp_path):
    path = str(tmp_path / "atomic-store")

    def write():
        store = Store.open(path)
        setup = store.setup("Ada")
        note = store.create(
            urls.PLAIN_TEXT,
            name="Persisted",
            description="on disk",
        )
        subject = note.subject
        secret = setup.agent_secret
        drive = setup.drive_subject
        store.flush()
        return subject, secret, drive

    subject, secret, drive = write()

    def edit():
        reopened = Store.open(path)
        assert reopened.agent() is None
        loaded = reopened.get(subject)
        assert loaded is not None
        assert loaded["name"] == "Persisted"
        assert loaded["description"] == "on disk"
        assert reopened.has(drive)

        agent = reopened.load_agent(secret)
        assert agent.subject.startswith("did:ad:agent:")
        assert agent.drive_needs_sync is False
        reopened.active_drive = drive

        loaded["description"] = "edited after reopen"
        loaded.save()
        reopened.flush()

    edit()

    again = Store.open(path)
    got = again.get(subject)
    assert got is not None
    assert got["description"] == "edited after reopen"


def test_context_manager_flushes(tmp_path):
    path = str(tmp_path / "ctx-store")

    def write():
        with Store.open(path) as store:
            store.setup("Ada")
            note = store.create(urls.FOLDER, name="Ctx")
            return note.subject

    subject = write()

    reopened = Store.open(path)
    got = reopened.get(subject)
    assert got is not None
    assert got["name"] == "Ctx"
