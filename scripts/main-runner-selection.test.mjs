import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(
  new URL('../.github/workflows/main.yml', import.meta.url),
  'utf8',
);
const pick = workflow.match(/^  pick:\n([\s\S]*?)(?=^  \S)/m)?.[1];
const body = pick?.match(/^        run: \|\n((?:          .*\n|\n)*)/m)?.[1];
assert.ok(body, 'Runner selection must remain directly executable in the test');
const shell = body
  .split('\n')
  .map(line => line.replace(/^ {10}/, ''))
  .join('\n');

for (const [name, event, input, override, expected] of [
  ['push retains the default self-hosted lane', 'push', 'false', '', 'mancave'],
  [
    'ordinary dispatch retains the default lane',
    'workflow_dispatch',
    'false',
    '',
    'mancave',
  ],
  [
    'explicit dispatch selects hosted without a repository override',
    'workflow_dispatch',
    'true',
    '',
    'hosted',
  ],
  [
    'dispatch without the new input remains compatible',
    'workflow_dispatch',
    '',
    '',
    'mancave',
  ],
  [
    'push cannot opt in through a dispatch-only input',
    'push',
    'true',
    '',
    'mancave',
  ],
  [
    'repository hosted override still works',
    'workflow_dispatch',
    'false',
    '["ubuntu-latest"]',
    'hosted',
  ],
  [
    'PRs cannot select private self-hosted runners',
    'pull_request',
    'false',
    '["self-hosted"]',
    'hosted',
  ],
  [
    'PR target events cannot select private self-hosted runners',
    'pull_request_target',
    'false',
    '["self-hosted"]',
    'hosted',
  ],
]) {
  test(name, () => {
    const temp = mkdtempSync(join(tmpdir(), 'atomic-runner-selection-'));
    const output = join(temp, 'output');
    try {
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', shell], {
        encoding: 'utf8',
        env: {
          ...process.env,
          EVENT_NAME: event,
          HOSTED_INPUT: input,
          FORCE_RUNNER: override,
          GITHUB_OUTPUT: output,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, 'utf8').trim(), `host=${expected}`);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

test('both runner paths retain full E2E coverage', () => {
  for (const name of ['mancave', 'github']) {
    const job = workflow.match(
      new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\S)`, 'm'),
    )?.[1];
    assert.match(job, /e2e-mode: full/);
  }
});
