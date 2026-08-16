"""Iroh P2P — the product surface, not an optional extra.

`peer::start` is process-global, so two nodes must be two OS processes.
"""

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from atomic_data import Store, urls

CHILD = Path(__file__).parent / "iroh_peer_child.py"


def test_sync_with_requires_start_peer():
    store = Store.in_memory()
    store.setup("Ada")
    with pytest.raises(ValueError, match="start_peer"):
        store.sync_with("did:ad:node:" + "ab" * 32)


def test_known_peers_persist_locally():
    store = Store.in_memory()
    store.setup("Ada")
    store.add_peer("did:ad:node:" + "cd" * 32, name="Phone")
    peers = store.peers()
    assert len(peers) == 1
    assert peers[0].name == "Phone"
    assert peers[0].node_id.startswith("did:ad:node:")


def test_wait_for_times_out():
    store = Store.in_memory()
    store.setup("Ada")
    with pytest.raises(TimeoutError):
        store.wait_for("did:ad:does-not-change", timeout=0.2)


def test_start_peer_returns_node_uri():
    store = Store.in_memory()
    store.setup("Ada")
    store.device_name = "pytest-a"
    node = store.start_peer()
    assert node.startswith("did:ad:node:")
    assert store.peer_id == node
    # Idempotent.
    assert store.start_peer() == node


def test_two_process_iroh_sync(tmp_path):
    path_a = tmp_path / "a"
    path_b = tmp_path / "b"
    handshake = tmp_path / "handshake.json"
    done = tmp_path / "done.json"

    store = Store.open(str(path_a))
    setup = store.setup("Ada")
    store.device_name = "pytest-parent"
    node = store.start_peer()
    note = store.create(urls.FOLDER, name="From A")
    store.flush()
    handshake.write_text(
        json.dumps(
            {
                "node_id": node,
                "secret": setup.agent_secret,
                "drive": setup.drive_subject,
                "subject": note.subject,
                "name": "From A",
            }
        ),
        encoding="utf-8",
    )

    child = subprocess.Popen(
        [sys.executable, str(CHILD), str(handshake), str(path_b), str(done)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        deadline = time.time() + 90
        while time.time() < deadline and child.poll() is None and not done.exists():
            time.sleep(0.25)
        if not done.exists():
            child.kill()
            out, _ = child.communicate(timeout=10)
            pytest.fail(f"child did not finish Iroh sync:\n{out}")
        report = json.loads(done.read_text(encoding="utf-8"))
        assert report["ok"], report
        assert report["has_drive"]
        assert report["imported"] >= 1
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)
