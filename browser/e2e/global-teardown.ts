import { readFileSync, rmSync } from 'node:fs';
import { PER_WORKER_PIDS_FILE } from './global-setup';

/** Kill the per-worker atomic-servers spawned in global-setup. */
export default async function globalTeardown(): Promise<void> {
  if (process.env.CI || process.env.ATOMIC_NO_PER_WORKER_SERVER) {
    return;
  }

  let pids: number[] = [];

  try {
    pids = JSON.parse(readFileSync(PER_WORKER_PIDS_FILE, 'utf8'));
  } catch {
    return; // nothing started
  }

  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }

  rmSync(PER_WORKER_PIDS_FILE, { force: true });
}
