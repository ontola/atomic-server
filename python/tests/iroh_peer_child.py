"""Second OS process for the Iroh P2P test. Invoked by test_iroh.py."""

import json
import sys

from atomic_data import Store


def main() -> None:
    handshake_path, store_path, done_path = sys.argv[1:4]
    hs = json.loads(open(handshake_path, encoding="utf-8").read())
    store = Store.open(store_path)
    loaded = store.load_agent(hs["secret"])
    if loaded.drive_needs_sync:
        # Expected: this process has the agent but not the drive genesis yet.
        pass
    store.start_peer()
    report = store.sync_with(hs["node_id"], drive=hs["drive"])
    got = store.get(hs["subject"])
    open(done_path, "w", encoding="utf-8").write(
        json.dumps(
            {
                "ok": bool(got) and got["name"] == hs["name"],
                "imported": report.imported,
                "pushed": report.pushed,
                "name": got["name"] if got else None,
                "has_drive": store.has(hs["drive"]),
            }
        )
    )


if __name__ == "__main__":
    main()
