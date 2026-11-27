#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startControlledPortal } from '../native-late-file-acceptance.mjs';
import { RecoveryContext } from './support.mjs';
import { startStorage } from './storage.mjs';
import { testPeer } from './peer.mjs';
import { testVault } from './vault.mjs';

const selectedCase = process.env.NATIVE_RECOVERY_CASE ?? 'both';
if (!['both', 'peer', 'vault'].includes(selectedCase)) {
  throw new Error('NATIVE_RECOVERY_CASE must be both, peer or vault');
}
const ctx = await new RecoveryContext().init();
let portal;
let results;
let failure;

try {
  portal = await startControlledPortal({
    port: 49238,
    mode: 'signed-out',
    holdMs: 60_000,
  });
  results = {};
  if (selectedCase !== 'vault') {
    console.info('Running actual native recovery from a late real peer.');
    results.peer = await testPeer(ctx);
    console.info(JSON.stringify(results.peer));
  }
  if (selectedCase !== 'peer') {
    console.info('Starting the real Cloud Vault API and S3 storage.');
    await startStorage(ctx);
    console.info('Running actual native recovery with Vault as the only copy.');
    results.vault = await testVault(ctx);
    console.info(JSON.stringify(results.vault));
  }
} catch (error) {
  failure = error;
} finally {
  try {
    await ctx.cleanup();
  } catch (error) {
    failure ??= error;
  }

  try {
    await portal?.close();
  } catch (error) {
    failure ??= error;
  }
}

if (failure) {
  // Raw exceptions can contain account credentials; keep them private.
  await writeFile(join(ctx.runDir, 'failure.txt'), String(failure.stack), {
    mode: 0o600,
  });
  await ctx.record('summary', {
    passed: false,
    selectedCase,
    reason: 'Native recovery setup, assertion or cleanup failed.',
    stage: ctx.stage,
    errorType: failure.name,
    errorCode: failure.code,
  });
  process.exitCode = 1;
  console.error(`Native recovery failed; private diagnostics: ${ctx.runDir}`);
} else {
  await ctx.record('summary', {
    passed: true,
    selectedCase,
    platform: process.platform,
    arch: process.arch,
    ...results,
  });
  console.info(
    selectedCase === 'both'
      ? 'Both real native recovery tests passed unattended.'
      : `Real native ${selectedCase} recovery passed unattended.`,
  );
}
