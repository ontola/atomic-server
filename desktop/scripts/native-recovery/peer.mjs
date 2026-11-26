import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Actual Tauri/WebKit, native redb, signed Iroh sync and native HTTP image
// rendering. Only the invented source's read gate is controlled by the test.
export async function testPeer(ctx) {
  const sourceDir = join(ctx.runDir, 'peer-source');
  const executable = join(ctx.binDir, 'examples/native_late_file_peer');
  const source = await ctx.spawn(executable, [sourceDir, ctx.origin], {
    logName: 'peer-source',
  });

  try {
    const fixture = await ctx.wait('real peer ready', async () => {
      try {
        return JSON.parse(
          await readFile(join(sourceDir, 'ready.json'), 'utf8'),
        );
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    });

    const mode = async value => {
      const response = await fetch(
        `${ctx.peerPortalOrigin}/__acceptance/mode`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(value),
          signal: AbortSignal.timeout(5_000),
        },
      );
      assert.equal(response.status, 200);
    };

    // Initialize/sign in normally, then save genuine direct address hints while
    // redb is closed. This avoids public discovery without bypassing peer auth.
    await mode({ mode: 'signed-out' });
    await ctx.startApp('peer', { portalOrigin: ctx.peerPortalOrigin });
    await ctx.stopApp();
    await writeFile(
      join(ctx.profileData('peer'), 'NATIVE_PEER_ACCEPTANCE_ONLY'),
      JSON.stringify({
        purpose: 'native-peer-acceptance',
        nodeId: fixture.nodeId,
        drive: fixture.drive,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    await ctx.run(executable, [
      'seed-peer',
      ctx.profileData('peer'),
      sourceDir,
    ]);
    await ctx.startApp('peer', { portalOrigin: ctx.peerPortalOrigin });
    await mode({ mode: 'hold', holdMs: 60_000 });

    const literal = JSON.stringify(fixture);
    await ctx.app.launch(
      'peer-join',
      `var f=${literal};return await window.__TAURI__.core.invoke('fetch_workspace',{drive:f.drive,nodeId:f.nodeId});`,
    );
    await ctx.wait('real peer metadata', async () => {
      const hashes = await ctx.call(
        'peer-inventory',
        `return await window.__TAURI__.core.invoke('vault_file_hashes',{driveSubject:${JSON.stringify(fixture.drive)}});`,
      );

      return hashes.includes(fixture.hash);
    });
    const presence = () =>
      ctx.call(
        'peer-presence',
        `return await window.__TAURI__.core.invoke('vault_blob_present',{hash:${JSON.stringify(fixture.hash)}});`,
      );
    assert.equal(await presence(), false, 'source bytes must remain held');
    assert.equal(
      await ctx.app.evaluate('return !!window.store.clientDb;'),
      false,
      'the native test must not use browser ClientDb storage',
    );

    await ctx.instrument();
    await ctx.openFile(fixture);
    const inspect = () => ctx.inspectFile(fixture);
    const deadline = await ctx.wait(
      'actual 30-second recovery timeout',
      async () => {
        const evidence = await ctx.app.evaluate(
          'return window.__recoveryEvidence;',
        );

        return evidence.recoveries.find(
          item =>
            item.hash === fixture.hash && item.doneAt && item.value === false,
        );
      },
    );
    assert.ok(deadline.doneAt - deadline.at >= 30_000);
    const before = await inspect();
    assert.equal(await presence(), false);
    assert.ok(before.images.every(image => image.width === 0));
    await ctx.record('peer-before', before);
    await ctx.capture('peer-timeout');

    const releasedAt = Date.now();
    await writeFile(fixture.releaseFile, 'release invented peer file\n', {
      flag: 'wx',
    });
    const after = await ctx.wait(
      'same native preview refreshes after late peer file',
      async () => {
        const state = await inspect();

        return state.evidence.events.some(
          event => event.payload.hash === fixture.hash,
        ) &&
          state.images.some(
            image =>
              image.visible && image.width === 240 && image.height === 160,
          )
          ? state
          : false;
      },
      45_000,
    );
    const renderedAt = Date.now();
    const response = await fetch(
      `${ctx.origin}/download/files/${fixture.hash}`,
      {
        signal: AbortSignal.timeout(10_000),
      },
    );
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, await readFile(fixture.imageFile));
    assert.equal(await presence(), true);
    assert.equal(after.sameResource, true);
    assert.equal(after.sameProperties, true);
    assert.equal(after.sameVersion, true);
    assert.equal(after.url, before.url);
    assert.equal(before.samePage, true);
    assert.equal(after.samePage, true);
    assert.ok(
      Date.now() < deadline.doneAt + 60_000,
      'success must precede retry cooldown expiry',
    );
    const events = (await readFile(fixture.eventsFile, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    assert.ok(
      events.some(
        event => event.event === 'blob-get-started' && event.atMs < releasedAt,
      ),
    );
    assert.ok(
      events.some(
        event =>
          event.event === 'blob-get-released' && event.atMs >= releasedAt,
      ),
    );
    const result = {
      test: 'native late real-peer recovery',
      passed: true,
      deadlineMs: deadline.doneAt - deadline.at,
      nativeEventMs:
        after.evidence.events.find(event => event.payload.hash === fixture.hash)
          .at - releasedAt,
      observedRenderMs: renderedAt - releasedAt,
      bytes: bytes.length,
      exactBytes: true,
      unchangedResourceMetadataAndVersion: true,
      sameOpenView: true,
      recoveredDuringCooldown: true,
    };
    await ctx.record('peer-after', after);
    await ctx.record('peer-result', result);
    await ctx.capture('peer-recovered');

    return result;
  } finally {
    try {
      await ctx.stopApp();
    } finally {
      await ctx.stopProcess(source);
    }
  }
}
