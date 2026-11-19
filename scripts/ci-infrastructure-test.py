#!/usr/bin/env python3
"""Exercise the real routing/gate shell and Docker preflight failure behavior."""

import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / ".github/workflows/main.yml").read_text()
BODY = (ROOT / ".github/workflows/main-ci.yml").read_text()
ENGINE_SPEC = importlib.util.spec_from_file_location("ci_engine", ROOT / "scripts/ci-dagger-engine.py")
ENGINE = importlib.util.module_from_spec(ENGINE_SPEC)
ENGINE_SPEC.loader.exec_module(ENGINE)


def job(source, name):
    return re.search(rf"^  {name}:\n([\s\S]*?)(?=^  \S|\Z)", source, re.M)[1]


def shell(source):
    body = re.search(r"^        run: \|\n((?:          .*\n|\n)*)", source, re.M)[1]
    return "\n".join(line[10:] if line.startswith("          ") else line for line in body.splitlines())


class WorkflowTests(unittest.TestCase):
    def run_shell(self, script, values):
        return subprocess.run(
            ["/bin/bash", "-euo", "pipefail", "-c", script],
            env={**os.environ, **values}, capture_output=True, text=True, timeout=5,
        )

    def test_actual_selection_shell_preserves_defaults_and_trust_boundary(self):
        cases = [
            ("push", "refs/heads/develop", "false", "default", "", "mancave"),
            ("push", "refs/heads/develop", "true", "github-hosted", "", "mancave"),
            ("push", "refs/tags/v0.41.0", "false", "default", "", "mancave"),
            ("push", "refs/tags/v0.41.0", "true", "github-hosted", '["ubuntu-latest"]', "hosted"),
            ("pull_request", "refs/heads/trekmeester/batch", "false", "self-hosted", '["self-hosted"]', "hosted"),
            ("pull_request_target", "refs/heads/trekmeester/batch", "true", "default", '["self-hosted"]', "hosted"),
        ]
        # Both supported inputs select hosted for trekmeester. Every other
        # manual ref stays hosted even when inputs are absent or overridden.
        for ref, reserved in [
            ("refs/heads/trekmeester/batch", True),
            ("refs/heads/codex/feature", False),
            ("refs/heads/develop", False),
            ("refs/heads/trekmeester", False),
            ("refs/heads/trekmeester/", False),
            ("refs/heads/trekmeester-other/batch", False),
            ("refs/tags/trekmeester/batch", False),
            ("refs/tags/v0.41.0", False),
            ("", False),
        ]:
            for requested, runner in [
                ("", ""), ("false", "default"), ("true", "default"),
                ("false", "github-hosted"), ("true", "github-hosted"),
                ("false", "self-hosted"),
            ]:
                for override in ["", '["self-hosted"]', '["ubuntu-latest"]']:
                    hosted = (
                        not reserved or requested == "true" or
                        runner == "github-hosted" or override == '["ubuntu-latest"]'
                    )
                    expected = "hosted" if hosted else "mancave"
                    cases.append(("workflow_dispatch", ref, requested, runner, override, expected))
        for event, ref, requested, runner, override, expected in cases:
            with self.subTest(event=event, ref=ref, requested=requested, runner=runner, override=override), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "output"
                result = self.run_shell(shell(job(MAIN, "pick")), {
                    "EVENT_NAME": event, "REF": ref, "HOSTED_INPUT": requested, "DISPATCH_RUNNER": runner,
                    "FORCE_RUNNER": override, "GITHUB_OUTPUT": str(output),
                })
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(output.read_text().strip(), f"host={expected}")

    def test_manual_image_publisher_also_reserves_mancave_for_trekmeester(self):
        source = (ROOT / ".github/workflows/publish-develop-image.yml").read_text()
        expression = re.search(r"runs-on: \$\{\{ (.+) \}\}", job(source, "publish"))[1]
        expression = expression.replace("!startsWith", "not startsWith").replace("&&", "and").replace("||", "or")
        for ref in ["refs/heads/codex/fix", "refs/heads/develop", "refs/tags/trekmeester/batch", "refs/heads/trekmeester-other/batch", "refs/heads/trekmeester/batch"]:
            for override in ["", '["self-hosted", "Linux", "X64"]', '["ubuntu-latest"]']:
                with self.subTest(ref=ref, override=override):
                    actual = eval(expression.replace("github.ref", repr(ref)).replace("vars.CI_RUNNER_OVERRIDE", repr(override)), {
                        "__builtins__": {}, "fromJSON": json.loads,
                        "startsWith": lambda value, prefix: value.lower().startswith(prefix.lower()),
                    })
                    expected = json.loads(override or '["self-hosted", "Linux", "X64"]') if ref == "refs/heads/trekmeester/batch" else ["ubuntu-latest"]
                    self.assertEqual(actual, expected)

    def test_actual_gate_requires_both_suites_for_every_trusted_runner(self):
        for event in ["push", "workflow_dispatch"]:
            for host in ["mancave", "hosted"]:
                for downstream in ["success", "failure", "cancelled", "skipped", ""]:
                    for selected in ["success", "failure", "cancelled", "skipped"]:
                        with self.subTest(event=event, host=host, downstream=downstream, selected=selected):
                            result = self.run_shell(shell(job(MAIN, "Main")), {
                                "EVENT_NAME": event, "SELECTED_HOST": host,
                                "MANCAVE_RESULT": selected if host == "mancave" else "skipped",
                                "HOSTED_RESULT": selected if host == "hosted" else "skipped",
                                "DOWNSTREAM_RESULT": downstream,
                            })
                            self.assertEqual(result.returncode == 0, selected == downstream == "success", result.stdout)

    def test_pr_gate_can_pass_without_private_downstream(self):
        for event in ["pull_request", "pull_request_target"]:
            result = self.run_shell(shell(job(MAIN, "Main")), {
                "EVENT_NAME": event, "SELECTED_HOST": "hosted",
                "MANCAVE_RESULT": "skipped", "HOSTED_RESULT": "success",
                "DOWNSTREAM_RESULT": "skipped",
            })
            self.assertEqual(result.returncode, 0, result.stdout)

    def test_selector_failure_cannot_skip_or_pass_the_required_gate(self):
        gate = job(MAIN, "Main")
        self.assertRegex(gate, r"(?m)^    if: always\(\)$")
        for event in ["push", "workflow_dispatch", "pull_request"]:
            result = self.run_shell(shell(gate), {
                "EVENT_NAME": event, "SELECTED_HOST": "",
                "MANCAVE_RESULT": "skipped", "HOSTED_RESULT": "skipped",
                "DOWNSTREAM_RESULT": "skipped",
            })
            self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_downstream_wiring_allows_only_trusted_events_on_either_runner(self):
        downstream = job(MAIN, "downstream-saas")
        condition = re.search(r"    if: >-\n((?:      .*\n)+)", downstream)[1].strip()
        expression = condition.replace("||", "or").replace("&&", "and")
        for event in ["push", "workflow_dispatch", "pull_request", "pull_request_target", "workflow_run"]:
            # The current condition is deliberately just an event allowlist.
            self.assertEqual(eval(expression.replace("github.event_name", repr(event)), {"__builtins__": {}}), event in ["push", "workflow_dispatch"])
        self.assertIn("needs.pick.outputs.host == 'hosted' && '[\"ubuntu-latest\"]'", downstream)
        self.assertIn("timeout-minutes: ${{ needs.pick.outputs.host == 'hosted' && 120 || 30 }}", downstream)
        for command in [
            "check-rust-alignment.py", "cargo check --locked --all-targets",
            "cargo clippy --locked --all-targets -- -D warnings",
            "cargo test --locked --all-targets",
            "cargo clippy --locked -p atomic-managed-node --all-targets -- -D warnings",
            "cargo test --locked -p atomic-managed-node", "git diff --exit-code -- Cargo.lock",
        ]:
            self.assertIn(command, downstream)
        self.assertNotIn("continue-on-error", downstream)
        rust_setup = downstream.split("- name: Install Rust", 1)[1].split("\n      -", 1)[0]
        self.assertIn("targets: wasm32-wasip2", rust_setup)
        self.assertIn('ATOMICSERVER_REQUIRE_PLUGIN_RUNTIME: "true"', downstream)
        for name in ["mancave", "github"]:
            self.assertIn("e2e-mode: full", job(MAIN, name))

    def test_preflight_precedes_registry_logins_and_diagnostics_need_dagger_failure(self):
        for name in ["ci", "images"]:
            body = job(BODY, name)
            self.assertLess(body.index("python3 scripts/ci-docker-preflight.py"), body.index("uses: docker/login-action"))
            self.assertIn("runner.environment == 'self-hosted' && vars.CI_DOCKER_BINARY || ''", body)
        self.assertIn("id: dagger-ci", job(BODY, "ci"))
        self.assertIn("if: failure() && steps.dagger-ci.outcome == 'failure'", BODY)
        self.assertIn("run: python3 scripts/ci-infrastructure-test.py", BODY)


class DockerPreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        self.environment = {
            **os.environ, "PATH": str(self.bin), "CI_DOCKER_BINARY": "",
            "RUNNER_TEMP": str(self.directory), "GITHUB_PATH": str(self.directory / "github-path"),
            "DOCKER_CALLS": str(self.directory / "calls"),
        }

    def tearDown(self):
        self.temp.cleanup()

    def docker(self, content):
        path = self.bin / "docker"
        path.write_text(f"#!{sys.executable}\nimport os,sys,time\n" + content)
        path.chmod(0o755)
        return path

    def run_preflight(self, timeout="1"):
        return subprocess.run(
            [sys.executable, str(ROOT / "scripts/ci-docker-preflight.py"), "--timeout-seconds", timeout],
            env=self.environment, capture_output=True, text=True, timeout=5,
        )

    def test_missing_or_broken_docker_fails_before_any_setup(self):
        for broken in [False, True]:
            if broken:
                (self.bin / "docker").symlink_to(self.directory / "missing-desktop-cli")
            result = self.run_preflight()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Docker CLI is missing or its symlink is broken", result.stderr)
            self.assertFalse((self.directory / "github-path").exists())

    def test_daemon_failure_is_reported_without_changing_path(self):
        self.docker("print('Cannot connect to daemon', file=sys.stderr)\nsys.exit(1)\n")
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Docker version failed", result.stderr)
        self.assertFalse((self.directory / "github-path").exists())

    def test_hung_daemon_is_bounded(self):
        self.docker("time.sleep(10)\n")
        result = self.run_preflight("0.1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not respond within 0.1s", result.stderr)

    def test_healthy_client_checks_server_and_keeps_path(self):
        self.docker("with open(os.environ['DOCKER_CALLS'], 'a') as f: f.write(sys.argv[1]+'\\n')\nprint('29.0.0')\n")
        result = self.run_preflight()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.directory / "calls").read_text(), "version\ninfo\n")
        self.assertFalse((self.directory / "github-path").exists())

    def test_only_explicit_verified_client_is_exported_for_following_actions(self):
        docker = self.docker("print('29.0.0')\n")
        alternate = self.directory / "verified-client"
        docker.rename(alternate)
        self.environment["CI_DOCKER_BINARY"] = str(alternate)
        result = self.run_preflight()
        self.assertEqual(result.returncode, 0, result.stderr)
        exported = Path((self.directory / "github-path").read_text().strip())
        self.assertEqual((exported / "docker").resolve(), alternate.resolve())
        self.assertEqual(exported.parent, self.directory)

    def test_invalid_configured_client_is_not_silently_ignored(self):
        self.docker("print('29.0.0')\n")
        self.environment["CI_DOCKER_BINARY"] = "relative/docker"
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("existing executable absolute path", result.stderr)


class DaggerEngineTests(unittest.TestCase):
    def test_engine_is_stable_and_owned_by_repository_runner_and_version(self):
        first = ENGINE.configuration("ontola/atomic-server", "Mancave")
        self.assertEqual(first, ENGINE.configuration("ontola/atomic-server", "Mancave"))
        self.assertNotEqual(first, ENGINE.configuration("ontola/atomic-server", "Mancave-2"))
        self.assertNotEqual(first, ENGINE.configuration("ontola/atomic-saas", "Mancave"))
        # Hash the original identities, not sanitized strings that could collide.
        self.assertNotEqual(ENGINE.configuration("a/b", "a/b"), ENGINE.configuration("a/b", "a-b"))
        url = urlparse(first["_EXPERIMENTAL_DAGGER_RUNNER_HOST"])
        query = parse_qs(url.query)
        self.assertEqual(url.scheme, "image+docker")
        self.assertEqual(url.netloc + url.path, f"registry.dagger.io/engine:v{ENGINE.DAGGER_VERSION}")
        self.assertEqual(query["cleanup"], ["false"])
        self.assertEqual(first["DAGGER_LEAVE_OLD_ENGINE"], "true")
        for key, prefix in [("container", "atomic-ci-engine-"), ("volume", "atomic-ci-cache-")]:
            self.assertRegex(query[key][0], rf"^{prefix}[a-f0-9]{{16}}-v0\.21\.11$")
            self.assertFalse(query[key][0].startswith("dagger-engine-"))

    def test_missing_owner_cannot_silently_share_an_engine(self):
        for repository, runner in [("", "Mancave"), ("ontola/atomic-server", ""), (None, None)]:
            with self.assertRaises(ValueError):
                ENGINE.configuration(repository, runner)

    def test_configuration_exports_one_url_for_main_and_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "env"
            output.write_text("EXISTING_SETTING=keep\n")
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts/ci-dagger-engine.py")],
                env={**os.environ, "GITHUB_REPOSITORY": "ontola/atomic-server", "RUNNER_NAME": "Mancave", "GITHUB_ENV": str(output)},
                capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            actual = dict(line.split("=", 1) for line in output.read_text().splitlines())
            self.assertEqual(actual.pop("EXISTING_SETTING"), "keep")
            self.assertEqual(actual, ENGINE.configuration("ontola/atomic-server", "Mancave"))

    def test_every_action_uses_verified_pin_and_never_stops_shared_engines(self):
        invocations = re.findall(r"uses: dagger/dagger-for-github@8\.0\.0\n([\s\S]*?)(?=^      -|\Z)", BODY, re.M)
        self.assertEqual(len(invocations), 3)
        for invocation in invocations:
            self.assertIn(f'version: "{ENGINE.DAGGER_VERSION}"', invocation)
            self.assertIn('engine-stop: "false"', invocation)
            self.assertNotIn("_EXPERIMENTAL_DAGGER_RUNNER_HOST:", invocation)
        for name in ["ci", "images"]:
            body = job(BODY, name)
            self.assertEqual(body.count("python3 scripts/ci-dagger-engine.py"), 1)
            self.assertLess(body.index("python3 scripts/ci-dagger-engine.py"), body.index("uses: dagger/dagger-for-github"))


if __name__ == "__main__":
    unittest.main()
