/** A deferred retry selects completed failures, never a whole shard or suite. */
type JsonObject = Record<string, unknown>;

export type BrowserRetrySelection = {
  version: 1;
  kind: 'browser-deferred-retry-selection';
  sourceCommit: string;
  manifestSha256: string;
  shardIndex: number;
  shardCount: number;
  firstReportSha256: string;
  firstLastRunSha256: string;
  firstExitCodeSha256: string;
  failedTestIds: string[];
  excludedLastRunTestIds: string[];
};

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid browser retry ${label}`);
  }
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid browser retry ${label}`);
  return value;
}

function testId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('Invalid browser retry test ID');
  }
  return value;
}

function sameIds(actual: string[], expected: string[]): boolean {
  const sorted = [...expected].sort();
  return (
    actual.length === expected.length &&
    [...actual].sort().every((id, i) => id === sorted[i])
  );
}

function entries(report: JsonObject): { id: string; test: JsonObject }[] {
  const result: { id: string; test: JsonObject }[] = [];
  const seen = new Set<string>();
  function visit(suites: unknown): void {
    for (const raw of array(suites, 'suites')) {
      const suite = object(raw, 'suite');
      for (const rawSpec of array(suite.specs ?? [], 'specs')) {
        const spec = object(rawSpec, 'spec');
        const id = testId(spec.id);
        const tests = array(spec.tests, 'tests');
        // Playwright's JSON reporter merges projects into one spec and keeps
        // only its first ID. Refuse that ambiguity instead of widening a retry.
        if (tests.length !== 1 || seen.has(id)) {
          throw new Error(
            'Browser retry requires unique single-project test IDs',
          );
        }
        seen.add(id);
        result.push({ id, test: object(tests[0], 'test') });
      }
      visit(suite.suites ?? []);
    }
  }
  visit(report.suites);
  return result;
}

/** Inputs and hashes are checked before an executable image/service is used. */
export function validateBrowserRetryInput(input: {
  report: unknown;
  inventory: unknown;
  lastRun: unknown;
  receipt: unknown;
  exitCode: string;
  sourceCommit: string;
  manifestSha256: string;
  shardIndex: number;
  shardCount: number;
  reportSha256: string;
  lastRunSha256: string;
  exitCodeSha256: string;
}): BrowserRetrySelection {
  const report = object(input.report, 'report');
  const receipt = object(input.receipt, 'receipt');
  const lastRun = object(input.lastRun, 'last-run file');
  const config = object(report.config, 'report configuration');
  const shard = object(config.shard, 'original shard');
  const projects = array(config.projects, 'projects');
  const project = object(projects[0], 'project');
  if (
    projects.length !== 1 ||
    project.retries !== 0 ||
    typeof project.name !== 'string' ||
    !project.name
  ) {
    throw new Error(
      'Browser retry requires one project and zero immediate retries',
    );
  }
  if (shard.current !== input.shardIndex || shard.total !== input.shardCount) {
    throw new Error('Browser retry original shard differs');
  }
  if (
    array(report.errors, 'global errors').length ||
    input.exitCode.trim() !== '1'
  ) {
    throw new Error('Browser retry requires a completed failing test run');
  }
  const expected = {
    version: 1,
    kind: 'browser-first-pass',
    sourceCommit: input.sourceCommit,
    manifestSha256: input.manifestSha256,
    shardIndex: input.shardIndex,
    shardCount: input.shardCount,
    playwrightRetries: 0,
    reportSha256: input.reportSha256,
    lastRunSha256: input.lastRunSha256,
    exitCodeSha256: input.exitCodeSha256,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key] !== value) {
      throw new Error(`Browser retry original receipt ${key} differs`);
    }
  }
  const inventory = new Set(
    entries(object(input.inventory, 'inventory')).map(e => e.id),
  );
  const failed: string[] = [];
  const nativeFailures: string[] = [];
  for (const { id, test } of entries(report)) {
    if (!inventory.has(id) || test.projectName !== project.name) {
      throw new Error(
        'Browser retry report test differs from the bundle inventory/project',
      );
    }
    const results = array(test.results, 'test attempts').map(r =>
      object(r, 'attempt'),
    );
    if (results.some(r => r.status === 'interrupted')) {
      throw new Error('Browser retry refuses interrupted tests');
    }
    if (test.status === 'unexpected') {
      nativeFailures.push(id);
      if (
        test.expectedStatus === 'passed' &&
        results.length === 1 &&
        results[0].retry === 0 &&
        (results[0].status === 'failed' || results[0].status === 'timedOut')
      ) {
        failed.push(id);
      }
    } else if (test.status === 'skipped') {
      // This is Playwright 1.63's didNotRun rule. Serial-blocked tests can
      // appear in .last-run.json; they are not completed failures to retry.
      if (!results.length || test.expectedStatus !== 'skipped')
        nativeFailures.push(id);
    } else if (test.status !== 'expected') {
      throw new Error('Browser retry original test has an unsupported outcome');
    }
  }
  const originalIds = array(lastRun.failedTests, 'last-run IDs').map(testId);
  if (
    lastRun.status !== 'failed' ||
    new Set(originalIds).size !== originalIds.length ||
    !sameIds(originalIds, nativeFailures)
  ) {
    throw new Error(
      'Browser retry last-run IDs differ from the original report',
    );
  }
  if (!failed.length)
    throw new Error('Browser retry selection has no completed failures');
  return {
    version: 1,
    kind: 'browser-deferred-retry-selection',
    sourceCommit: input.sourceCommit,
    manifestSha256: input.manifestSha256,
    shardIndex: input.shardIndex,
    shardCount: input.shardCount,
    firstReportSha256: input.reportSha256,
    firstLastRunSha256: input.lastRunSha256,
    firstExitCodeSha256: input.exitCodeSha256,
    failedTestIds: failed.sort(),
    excludedLastRunTestIds: originalIds
      .filter(id => !failed.includes(id))
      .sort(),
  };
}

/** Missing first-pass files remain explicit nulls on startup/config failures. */
export const BROWSER_RUN_RECEIPT_SCRIPT = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const root = '/browser-results';
const hash = name => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(root + '/' + name)).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const receipt = {
  ...JSON.parse(process.argv[1]),
  reportSha256: hash('test-results.json'),
  lastRunSha256: hash('test-results/.last-run.json'),
  exitCodeSha256: hash('test-exit-code'),
};
fs.writeFileSync(root + '/browser-run.json', JSON.stringify(receipt, null, 2) + '\n');
`;

export const BROWSER_RETRY_RUN_SCRIPT =
  'set -o pipefail; ' +
  'export PLAYWRIGHT_JSON_OUTPUT_NAME=/test-results.json; ' +
  'pnpm exec playwright test --config=./playwright.config.ts --retries=0 ' +
  '--no-deps --last-failed --last-failed-file=/retry-last-run.json 2>&1 | tee /test-output.log; ' +
  'echo ${PIPESTATUS[0]} > /test-exit-code; exit 0';

export const BROWSER_RETRY_LIST_SCRIPT =
  'PLAYWRIGHT_JSON_OUTPUT_NAME=/retry-test-list.json ' +
  'pnpm exec playwright test --config=./playwright.config.ts --retries=0 ' +
  '--no-deps --last-failed --last-failed-file=/retry-last-run.json --list --reporter=json';

/** Playwright itself must resolve the exact selection before any test body. */
export const BROWSER_RETRY_LIST_CHECK_SCRIPT = String.raw`
const fs = require('node:fs');
const expected = JSON.parse(fs.readFileSync('/retry-last-run.json', 'utf8')).failedTests;
const report = JSON.parse(fs.readFileSync('/retry-test-list.json', 'utf8'));
const actual = [];
function visit(suites) {
  if (!Array.isArray(suites)) throw new Error('Invalid retry test-list suites');
  for (const suite of suites) {
    for (const spec of suite.specs || []) {
      if (spec.tests.length !== 1) throw new Error('Ambiguous retry test-list ID');
      actual.push(spec.id);
    }
    visit(suite.suites || []);
  }
}
visit(report.suites);
if (!Array.isArray(expected) || !expected.length ||
    !Array.isArray(report.errors) || report.errors.length ||
    report.config.shard != null ||
    report.config.projects.some(project => project.retries !== 0) ||
    new Set(actual).size !== actual.length ||
    JSON.stringify(actual.sort()) !== JSON.stringify([...expected].sort())) {
  throw new Error('Playwright retry test list differs from selected failed tests');
}
`;
