import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bootstrapAccount,
  injectDeviceGrant,
  inspectVault,
  writePrivateState,
} from '../native-vault-acceptance.mjs';

const descriptionProperty = 'https://atomicdata.dev/properties/description';
const peerProperty = 'https://atomicdata.dev/properties/server/peers';

async function clickBackup(ctx) {
  const selector = await ctx.wait('Cloud Vault backup control', async () =>
    ctx.app.evaluate(`
      for (var id of ['vault-enable', 'vault-backup-now']) {
        var button = document.querySelector('[data-testid="'+id+'"]');
        if (button && !button.disabled) return id;
      }
      return null;
    `),
  );
  await ctx.app.evaluate(`
    document.querySelector('[data-testid="'+${JSON.stringify(selector)}+'"]')?.click();
    return true;
  `);
}

async function attachAccount(ctx, state, drive) {
  await ctx.app.evaluate(
    `store.setDrive(${JSON.stringify(drive)}); return true;`,
  );
  await ctx.navigate('/app/sync');
  await injectDeviceGrant(state, drive);
  await ctx.reload();
  const agent = await ctx.app.evaluate(
    'return store.getAgent()?.subject ?? null;',
  );
  assert.ok(
    agent,
    'Native agent must remain signed in after account attachment',
  );
  await ctx.wait('real signed native-agent link', async () => {
    const vault = await inspectVault(state);

    return vault.account.linked_agent === agent && vault;
  });
}

async function offline(ctx, command, fixture) {
  const output = await ctx.run(
    join(ctx.binDir, 'examples/native_vault_remove_blob'),
    [command, ctx.vaultDataDir, fixture.hash, fixture.drive],
  );
  const result = JSON.parse(output.trim());
  assert.equal(result.command, command);
  assert.equal(result.hash, fixture.hash);
  assert.equal(result.drive, fixture.drive);
  assert.equal(result.metadataAndHistoryUnchanged, true);
  assert.deepEqual(result.fingerprintsBefore, result.fingerprintsAfter);

  return result;
}

/** A genuine backup and selective restore, exercised in the actual native UI. */
export async function testVault(ctx) {
  const unique = randomUUID();
  const image = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#17394a"/><circle cx="500" cy="85" r="48" fill="#ffd46b"/><path d="M0 310L160 150L320 310L440 210L640 360H0Z" fill="#60bea9"/><text x="34" y="56" font-family="Arial" font-size="25" fill="white">Recovered from real Cloud Vault</text><text x="34" y="334" font-family="Arial" font-size="17" fill="white">${unique}</text></svg>`;
  const expected = Buffer.from(image);
  const sentinel = `Newer local description retained during file recovery: ${unique}`;
  const state = await bootstrapAccount(
    ctx.vaultOrigin,
    `native-recovery-${unique}@example.test`,
  );
  await writePrivateState(join(ctx.runDir, 'vault-session.json'), state);
  await writeFile(join(ctx.runDir, 'vault-original.svg'), expected, {
    mode: 0o600,
  });

  try {
    await ctx.startApp('vault', { portalOrigin: ctx.vaultOrigin });
    await ctx.wait('native identity sync settled before fixture creation', () =>
      ctx.app.evaluate(
        `var s=store.getSyncStatus();return s.serverConnected&&!s.syncInProgress&&s.pendingDirtyCount===0&&s.blockedCount===0;`,
      ),
    );
    // Onboarding can first cache a public/partial Agent. Build the fixture on
    // the complete signed HTTP state, with no local writes to discard.
    await ctx.call(
      'vault-agent-hydration',
      `
      var agent=await store.fetchResourceFromServer(store.getAgent().subject,{noWebSocket:true,forceOverride:true,setLoading:true});
      if(!agent.isReady()||agent.error)throw new Error('Native fixture Agent did not hydrate');
      return true;
    `,
    );
    const fixture = await ctx.call(
      'vault-upload',
      `
      if (store.clientDb) throw new Error('Expected the embedded native database');
      var drive = await store.createDrive('Unattended native Vault recovery', {personal:false});
      store.setDrive(drive.subject);
      var files = await store.uploadFiles([
        new File([${JSON.stringify(image)}], 'vault-only.svg', {type:'image/svg+xml'})
      ], drive.subject);
      if (files.length !== 1) throw new Error('Expected one genuine native upload');
      var file = await store.getResource(files[0]);
      var hash = file.getEntries().map(entry => entry[1]).find(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value));
      if (!hash) throw new Error('Uploaded file has no content hash');
      return {drive:drive.subject,file:file.subject,storedFile:'internal:/files/'+hash,hash};
    `,
    );

    await attachAccount(ctx, state, fixture.drive);
    await clickBackup(ctx);
    const enrollment = await ctx.wait(
      'confirmed real native file backup',
      async () => {
        const vault = await inspectVault(state);
        const drive = vault.drives.find(item => item.drive === fixture.drive);

        return (
          drive?.last_backup_at &&
          drive.objects?.some(item => item.kind === 'blob') &&
          drive.state?.checkpoints?.length > 0 &&
          drive
        );
      },
    );
    const blobs = enrollment.objects.filter(item => item.kind === 'blob');
    assert.equal(
      blobs.length,
      1,
      'This invented SVG must occupy one encrypted S3 chunk',
    );
    const blob = blobs[0];
    assert.equal(blob.size_bytes, expected.length + 46);
    assert.ok(
      !blob.object_key.includes(fixture.hash),
      'S3 keys must hide the plain content hash',
    );
    const objectPath =
      '/' +
      ctx.s3.bucket +
      '/' +
      blob.object_key.split('/').map(encodeURIComponent).join('/');
    const sealed = await ctx.s3.request('GET', objectPath);
    assert.equal(sealed.status, 200);
    assert.equal(sealed.body.length, expected.length + 46);
    assert.equal(
      sealed.body.includes(expected),
      false,
      'Real S3 must contain sealed bytes',
    );
    assert.equal(sealed.body.includes(Buffer.from('<svg')), false);
    await ctx.record('vault-backed-up', {
      drive: fixture.drive,
      hash: fixture.hash,
      plainBytes: expected.length,
      sealedBytes: sealed.body.length,
      checkpointCount: enrollment.state.checkpoints.length,
      encryptedObjectKey: blob.object_key,
      realS3Verified: true,
    });

    await ctx.call(
      'vault-sentinel',
      `
      var file = await store.getResource(${JSON.stringify(fixture.file)});
      await file.set(${JSON.stringify(descriptionProperty)}, ${JSON.stringify(sentinel)});
      await file.save();
      return true;
    `,
    );

    // Fault injection is confined to the feature-gated native fixture. Keep
    // the app alive so cold-start cache projection work is outside this test.
    // The photo has never been opened, so its bytes cannot be supplied by a
    // decoded-image cache after the real native backend removes the blob.
    await ctx.navigate('/app/sync');
    const beforeLoss = await ctx.call(
      'vault-metadata-before-loss',
      `
      var file=await store.getResource(${JSON.stringify(fixture.file)});
      return {entries:file.getEntries().sort((a,b)=>a[0].localeCompare(b[0])),
        version:[...file.getLoroDoc().oplogVersion().toJSON()].sort()};
    `,
    );
    await ctx.instrument();
    await writeFile(
      join(ctx.vaultDataDir, 'NATIVE_VAULT_ACCEPTANCE_ONLY'),
      JSON.stringify({
        purpose: 'native-vault-acceptance',
        hash: fixture.hash,
        drive: fixture.drive,
        file: fixture.storedFile,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    const nativeFixture = operation =>
      ctx.call(
        `vault-fixture-${operation}`,
        `
      return await window.__TAURI__.core.invoke('native_recovery_fixture',
        ${JSON.stringify({ drive: fixture.drive, hash: fixture.hash, operation })});
    `,
      );
    const foreignHash =
      (fixture.hash[0] === '0' ? '1' : '0') + fixture.hash.slice(1);
    await assert.rejects(
      ctx.call(
        'vault-fixture-refuses-other-file',
        `
      return await window.__TAURI__.core.invoke('native_recovery_fixture',
        ${JSON.stringify({ operation: 'arm', drive: fixture.drive, hash: foreignHash })});
    `,
      ),
    );
    assert.equal(
      await ctx.call(
        'vault-original-blob-preserved',
        `
      return await window.__TAURI__.core.invoke('vault_blob_present',{hash:${JSON.stringify(fixture.hash)}});
    `,
      ),
      true,
      'An invalid fixture request must leave the real file intact',
    );
    const removed = await nativeFixture('arm');
    assert.equal(removed.blobPresent, false);
    assert.equal(removed.blobBytesBefore, expected.length);
    assert.equal(removed.metadataAndHistoryUnchanged, true);
    assert.deepEqual(removed.fingerprintsBefore, removed.fingerprintsAfter);
    await ctx.record('vault-controlled-loss', removed);
    const absent = await fetch(`${ctx.origin}/download/files/${fixture.hash}`);
    assert.equal(absent.status, 404);
    await absent.arrayBuffer();
    const server = await fetch(`${ctx.origin}/server`, {
      headers: { Accept: 'application/ad+json' },
    });
    assert.equal(server.status, 200);
    const peerInventory = (await server.json())[peerProperty] ?? [];
    assert.deepEqual(
      peerInventory,
      [],
      'The native app must have no real or remembered peers',
    );
    await ctx.record('vault-missing-preflight', {
      present: false,
      downloadStatus: absent.status,
      peers: peerInventory,
    });

    await ctx.openFile(fixture);
    let baseline;
    let before;
    let gateWaiting = false;

    try {
      await ctx.wait(
        'real S3 download reached native restore gate',
        async () => {
          const status = await nativeFixture('status');
          assert.equal(
            status.timedOut,
            false,
            'The controlled restore must not time out',
          );

          return status.waiting;
        },
        25_000,
      );
      gateWaiting = true;
      // The production restore validates every drive member. Hydrate that
      // same native reference set before hashing, rather than ignore cache
      // differences or include unrelated first-read projection work.
      await ctx.call(
        'vault-native-references',
        `
        return await window.__TAURI__.core.invoke('vault_file_hashes', {driveSubject:${JSON.stringify(fixture.drive)}});
      `,
      );
      // The native restore is paused after the genuine S3 download, before
      // production decryption and storage. UI hydration has completed now;
      // measure all drive rows and the same resource while the blob is absent.
      baseline = await nativeFixture('snapshot');
      before = await ctx.call(
        'vault-current-resource-before-store',
        `
        var file = await store.getResource(${JSON.stringify(fixture.file)});
        return {entries:file.getEntries().sort((a,b)=>a[0].localeCompare(b[0])),
          version:[...file.getLoroDoc().oplogVersion().toJSON()].sort()};
      `,
      );
      assert.equal(
        before.entries.find(([key]) => key === descriptionProperty)?.[1],
        sentinel,
      );
      const held = await ctx.inspectFile(fixture);
      assert.ok(
        held.images.every(preview => preview.width === 0),
        'The missing file must not render from a browser cache',
      );
      await ctx.record('vault-before-native-store', {
        boundary:
          'after actual S3 download, immediately before real native restore',
        resource: before,
        fingerprints: baseline,
        view: held,
      });
      await nativeFixture('release');
      gateWaiting = false;
    } finally {
      // An assertion failure must not leave an owned native restore waiting.
      if (gateWaiting) await nativeFixture('release');
    }

    const after = await ctx.wait(
      'automatic native Vault preview recovery',
      async () => {
        const snapshot = await ctx.inspectFile(fixture);

        return (
          snapshot.images.some(
            preview =>
              preview.visible &&
              preview.width === 640 &&
              preview.height === 360,
          ) &&
          snapshot.evidence.recoveries.some(
            item =>
              item.hash === fixture.hash && item.doneAt && item.value === true,
          ) &&
          snapshot
        );
      },
    );
    assert.equal(after.clientDb, false);
    for (const invariant of [
      'sameResource',
      'sameProperties',
      'sameVersion',
      'samePage',
    ])
      assert.equal(after[invariant], true, invariant);
    const current = await ctx.call(
      'vault-current-resource-after-store',
      `
      var file = await store.getResource(${JSON.stringify(fixture.file)});
      return {entries:file.getEntries().sort((a,b)=>a[0].localeCompare(b[0])),
        version:[...file.getLoroDoc().oplogVersion().toJSON()].sort()};
    `,
    );
    assert.deepEqual(
      current,
      before,
      'Every current file value, including lastCommit, and full Loro version must survive native repair',
    );
    assert.deepEqual(
      current,
      beforeLoss,
      'Controlled loss and recovery must preserve every file value and version',
    );
    const downloaded = await fetch(
      `${ctx.origin}/download/files/${fixture.hash}`,
    );
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), expected);
    const count = command =>
      after.evidence.ipc.filter(item => item.command === command).length;
    assert.ok(
      count('vault_request_missing_files') >= 1,
      'Native recovery first asks existing peers',
    );
    assert.equal(count('vault_blob_restore'), 1);
    assert.equal(
      count('vault_import'),
      0,
      'Missing-file repair must not restore resource history',
    );
    const downloads = after.evidence.network.filter(
      item =>
        item.origin === new URL(ctx.s3.origin).origin &&
        item.path === objectPath &&
        item.method === 'GET',
    );
    assert.equal(
      downloads.length,
      1,
      'The open native preview must download the actual S3 object once',
    );
    assert.equal(downloads[0].status, 200);
    assert.ok(
      after.evidence.events.some(event => event.payload?.hash === fixture.hash),
    );
    const liveAfter = await nativeFixture('snapshot');
    assert.equal((await nativeFixture('status')).timedOut, false);
    await ctx.record('vault-after-native-store', {
      resource: current,
      fingerprints: liveAfter,
      view: after,
    });
    assert.deepEqual(
      liveAfter.drive,
      baseline.drive,
      'Native repair must preserve all persisted drive Resources, full LoroSnapshots and signed Envelopes exactly',
    );
    await ctx.capture('vault-recovered');
    await ctx.stopApp();
    const persisted = await offline(ctx, 'inspect', fixture);
    await ctx.record('vault-offline-after', persisted);
    assert.equal(persisted.blobPresent, true);
    assert.equal(persisted.blobBytesBefore, expected.length);
    assert.deepEqual(
      persisted.fingerprintsAfter.drive,
      baseline.drive,
      'The same exact drive state must remain durable after native shutdown',
    );
    const recovery = after.evidence.recoveries.find(
      item => item.hash === fixture.hash && item.value === true,
    );
    const result = {
      test: 'native-real-vault-recovery',
      passed: true,
      exactBytes: true,
      byteLength: expected.length,
      sealedBytes: sealed.body.length,
      noPeers: true,
      recoveryMs: recovery.doneAt - recovery.at,
      s3Downloads: downloads.length,
      nativeBlobRestores: count('vault_blob_restore'),
      historyImports: count('vault_import'),
      sameResource: after.sameResource,
      sameProperties: after.sameProperties,
      sameVersion: after.sameVersion,
      samePage: after.samePage,
      persistedDriveUnchanged: true,
      previewSize: [640, 360],
    };
    await ctx.record('vault-result', result);

    return result;
  } finally {
    await ctx.stopApp();
  }
}
