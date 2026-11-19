#!/usr/bin/env python3
"""Check Docker before registry login or Dagger; never repair shared services."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def check(timeout_seconds=20):
    configured = os.environ.get("CI_DOCKER_BINARY")
    if configured:
        binary = Path(configured)
        if not binary.is_absolute() or not binary.is_file() or not os.access(binary, os.X_OK):
            raise RuntimeError("CI_DOCKER_BINARY must name an existing executable absolute path")
        docker = str(binary.resolve())
    else:
        docker = shutil.which("docker")
        if not docker:
            raise RuntimeError(
                "Docker CLI is missing or its symlink is broken in the runner service PATH. "
                "Repair that PATH, or explicitly configure CI_DOCKER_BINARY to a working client."
            )

    for args in [
        ["version", "--format", "{{.Client.Version}} / {{.Server.Version}}"],
        ["info", "--format", "{{.ServerVersion}}"],
    ]:
        try:
            result = subprocess.run(
                [docker, *args], capture_output=True, text=True,
                timeout=timeout_seconds, check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(f"Docker {args[0]} did not respond within {timeout_seconds:g}s") from error
        if result.returncode:
            raise RuntimeError(
                f"Docker {args[0]} failed ({result.returncode}): "
                f"{(result.stderr or result.stdout).strip()[:2000]}"
            )
        print(f"Docker {args[0]}: {result.stdout.strip()}")

    # Export only a successfully checked, explicitly selected client. The link
    # belongs to this job; system binaries, Docker contexts and services stay put.
    if configured:
        github_path = os.environ.get("GITHUB_PATH")
        runner_temp = os.environ.get("RUNNER_TEMP")
        if not github_path or not runner_temp:
            raise RuntimeError("Configured Docker client needs GITHUB_PATH and RUNNER_TEMP")
        directory = Path(tempfile.mkdtemp(prefix="atomic-ci-docker-", dir=runner_temp))
        (directory / "docker").symlink_to(docker)
        with open(github_path, "a", encoding="utf-8") as output:
            output.write(f"{directory}\n")

    free = shutil.disk_usage(os.environ.get("RUNNER_TEMP", ".")).free / 1024**3
    print(f"Runner temporary filesystem: {free:.1f} GiB free")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout-seconds", type=float, default=20)
    options = parser.parse_args()
    if options.timeout_seconds <= 0 or options.timeout_seconds > 60:
        parser.error("timeout must be greater than zero and no more than 60 seconds")
    try:
        check(options.timeout_seconds)
    except (OSError, RuntimeError) as error:
        print(f"::error::CI infrastructure preflight: {error}", file=sys.stderr)
        sys.exit(1)
