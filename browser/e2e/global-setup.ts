import type { FullConfig } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-worker atomic-server isolation.
 *
 * The e2e flake under multiple local workers was a *shared-server*
 * concurrency issue: two workers committing to one atomic-server race the
 * parent-before-child rights check (a child commit reaches the rights walk
 * before its parent's genesis is materialized → spurious 401 → the outbox
 * can't drain in time → timeout). One worker is green because there's a single
 * commit stream; the problem only appears with concurrent streams on one box.
 *
 * Fix: give each Playwright worker its **own** atomic-server (own port + data
 * dir). Each worker then drives a single commit stream — the green 1-worker
 * condition — so the race never opens. The shared vite frontend stays as-is;
 * each browser context is pointed at its worker's server via `localStorage`
 * (see `before()` in `test-utils.ts`).
 *
 * CI is untouched: it runs `workers: 1` against its own (dagger-provided)
 * server, so we skip spawning there entirely.
 */

export const PER_WORKER_BASE_PORT = 9884;
export const PER_WORKER_PIDS_FILE = join(__dirname, '.per-worker-servers.json');

function resolveServerBinary(): string {
  const candidates = [
    join(__dirname, '..', '..', 'target', 'release', 'atomic-server'),
    join(process.cwd(), '..', '..', 'target', 'release', 'atomic-server'),
    join(process.cwd(), 'target', 'release', 'atomic-server'),
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  throw new Error(
    `atomic-server binary not found. Tried:\n${candidates.join('\n')}`,
  );
}

async function waitForServer(port: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/`);

      if (res.status > 0) return;
    } catch {
      // not up yet
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`atomic-server on port ${port} did not become ready`);
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  // CI runs a single worker against its own server — nothing to isolate.
  if (process.env.CI || process.env.ATOMIC_NO_PER_WORKER_SERVER) {
    return;
  }

  const binary = resolveServerBinary();
  const workers = config.workers ?? 1;
  const logDir = join(__dirname, '.per-worker-logs');
  mkdirSync(logDir, { recursive: true });
  const pids: number[] = [];

  for (let i = 0; i < workers; i++) {
    const port = PER_WORKER_BASE_PORT + i;
    const dir = join('/tmp', `atomic-e2e-worker-${i}`);
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-cache`, { recursive: true, force: true });
    const logFd = openSync(join(logDir, `worker-${i}.log`), 'w');

    const proc = spawn(binary, [], {
      env: {
        ...process.env,
        ATOMIC_PORT: String(port),
        ATOMIC_DATA_DIR: dir,
        ATOMIC_CACHE_DIR: `${dir}-cache`,
        ATOMICSERVER_SKIP_JS_BUILD: 'true',
      },
      stdio: ['ignore', logFd, logFd],
      detached: false,
    });

    proc.on('error', err => {
      // eslint-disable-next-line no-console
      console.error(`[per-worker-server] spawn failed for port ${port}:`, err);
    });

    if (proc.pid) pids.push(proc.pid);
  }

  await Promise.all(
    Array.from({ length: workers }, (_, i) =>
      waitForServer(PER_WORKER_BASE_PORT + i),
    ),
  );

  writeFileSync(PER_WORKER_PIDS_FILE, JSON.stringify(pids));
  // eslint-disable-next-line no-console
  console.log(
    `[per-worker-server] started ${workers} atomic-server(s) on ports ${PER_WORKER_BASE_PORT}..${PER_WORKER_BASE_PORT + workers - 1} (binary: ${binary})`,
  );
}
