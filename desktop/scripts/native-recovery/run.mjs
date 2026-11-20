#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startControlledPortal } from '../native-late-file-acceptance.mjs';
import { RecoveryContext } from './support.mjs';
import { startStorage } from './storage.mjs';
import { testPeer } from './peer.mjs';
import { testVault } from './vault.mjs';

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
  console.info('Running actual native recovery from a late real peer.');
  const peer = await testPeer(ctx);
  console.info(JSON.stringify(peer));
  console.info('Starting the real Cloud Vault API and S3 storage.');
  await startStorage(ctx);
  console.info('Running actual native recovery with Vault as the only copy.');
  const vault = await testVault(ctx);
  console.info(JSON.stringify(vault));
  results = { peer, vault };
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
    platform: process.platform,
    arch: process.arch,
    ...results,
  });
  console.info('Both real native recovery tests passed unattended.');
}
