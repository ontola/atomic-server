#!/usr/bin/env python3
"""Execute the actual MinIO Docker RUN using isolated fake git/go, no network."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

DOCKERFILE = Path(__file__).resolve().parents[2] / 'native-recovery.Dockerfile'
PIN = '07c3a429bfed433e49018cb0f78a52145d4bedeb'


class MinioBootstrapTests(unittest.TestCase):
    def run_bootstrap(self, failures=0, mutate=False, fail_build=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tools = root / 'bin'
            tools.mkdir()
            git = tools / 'git'
            git.write_text('''#!/bin/sh
case "$1" in
init) mkdir -p "$2"; printf 'module fixture\\n' > "$2/go.mod"; printf 'pinned checksums\\n' > "$2/go.sum" ;;
rev-parse) echo ''' + PIN + ''' ;;
diff) test "$(cat go.sum)" = 'pinned checksums' ;;
esac
''')
            go = tools / 'go'
            go.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$CONTROL/events"
if [ "$1 $2" = 'mod download' ]; then
  count=$(cat "$CONTROL/attempts" 2>/dev/null || echo 0)
  count=$((count + 1)); echo "$count" > "$CONTROL/attempts"
  if [ "$count" -le "$FAILURES" ]; then exit 47; fi
  touch "$CONTROL/downloaded"
  if [ "$MUTATE" = 1 ]; then echo changed > go.sum; fi
else
  test -f "$CONTROL/downloaded" || exit 73
  if [ "$FAIL_BUILD" = 1 ]; then exit 75; fi
fi
''')
            sleep = tools / 'sleep'
            sleep.write_text('#!/bin/sh\nexit 0\n')
            for path in (git, go, sleep):
                path.chmod(0o700)
            run = DOCKERFILE.read_text().split('RUN ', 1)[1].split('\n\n', 1)[0]
            run = run.replace('\\\n', '').replace('/src', str(root / 'src'))
            env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ['PATH'],
                       CONTROL=str(root), FAILURES=str(failures), MUTATE=str(int(mutate)),
                       FAIL_BUILD=str(int(fail_build)))
            result = subprocess.run(['/bin/sh', '-c', run], env=env,
                                    capture_output=True, text=True, timeout=5)
            events = (root / 'events').read_text().splitlines() if (root / 'events').exists() else []
            return result.returncode, events

    def test_dependency_download_precedes_one_build(self):
        code, events = self.run_bootstrap()
        self.assertEqual(code, 0)
        self.assertEqual(events[0], 'mod download')
        self.assertEqual(sum(event.startswith('build ') for event in events), 1)

    def test_two_transient_download_failures_recover_without_retrying_build(self):
        code, events = self.run_bootstrap(failures=2)
        self.assertEqual(code, 0)
        self.assertEqual(events[:3], ['mod download'] * 3)
        self.assertEqual(sum(event.startswith('build ') for event in events), 1)

    def test_persistent_failure_stops_after_three_attempts_without_build(self):
        code, events = self.run_bootstrap(failures=9)
        self.assertNotEqual(code, 0)
        self.assertEqual(events, ['mod download'] * 3)

    def test_build_failure_is_not_retried_or_hidden(self):
        code, events = self.run_bootstrap(fail_build=True)
        self.assertEqual(code, 75)
        self.assertEqual(events[0], 'mod download')
        self.assertEqual(sum(event.startswith('build ') for event in events), 1)

    def test_changed_module_checksums_cannot_reach_build(self):
        code, events = self.run_bootstrap(mutate=True)
        self.assertNotEqual(code, 0)
        self.assertEqual(events, ['mod download'])


if __name__ == '__main__':
    unittest.main()
