#!/usr/bin/env python3
"""Keep CI engines and their state private to one repository/runner/version."""

import hashlib
import json
import os
import sys
from urllib.parse import urlencode

# This exact CLI/engine pair ran the repository's module in the audited CI runs.
# Keep the three dagger-for-github invocations in main-ci.yml on this version.
DAGGER_VERSION = "0.21.11"


def configuration(repository, runner):
    if not repository or not runner:
        raise ValueError("GITHUB_REPOSITORY and RUNNER_NAME must identify the engine owner")
    identity = hashlib.sha256(json.dumps([repository, runner]).encode()).hexdigest()[:16]
    suffix = f"{identity}-v{DAGGER_VERSION}"
    # Dagger's default GC and dagger-for-github's stop action scan dagger-engine-*.
    # Use a different prefix so older concurrent workflows cannot collect ours.
    container = f"atomic-ci-engine-{suffix}"
    volume = f"atomic-ci-cache-{suffix}"
    query = urlencode({"container": container, "volume": volume, "cleanup": "false"})
    return {
        "DAGGER_LEAVE_OLD_ENGINE": "true",
        "_EXPERIMENTAL_DAGGER_RUNNER_HOST": (
            f"image+docker://registry.dagger.io/engine:v{DAGGER_VERSION}?{query}"
        ),
    }


def main():
    values = configuration(os.environ.get("GITHUB_REPOSITORY"), os.environ.get("RUNNER_NAME"))
    output = os.environ.get("GITHUB_ENV")
    if not output:
        raise ValueError("GITHUB_ENV is required to share the engine with diagnostic steps")
    with open(output, "a", encoding="utf-8") as target:
        for name, value in values.items():
            target.write(f"{name}={value}\n")
    print(f"Dagger engine: {values['_EXPERIMENTAL_DAGGER_RUNNER_HOST']}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"::error::CI engine configuration: {error}", file=sys.stderr)
        sys.exit(1)
