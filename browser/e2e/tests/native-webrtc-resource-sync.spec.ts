import { test, expect } from './fixtures';
import { nativeHost, serveEmbed } from './native-host-test-utils';
import { startNativeCarrier } from './native-webrtc-carrier';
import { SIGNALING, signalingRoom } from './resource-peer-test-utils';
import {
  before,
  getDevDriveSecret,
  waitForClientDbFlush,
  waitForClientDbReady,
  waitForSynced,
} from './test-utils';

const nativeBinary = process.env.ATOMIC_NATIVE_WEBRTC_TEST_BINARY;
test.beforeEach(before);

test('native WebRTC confirms resource details and exact attachment bytes through a real data channel', async ({
  page,
  context,
}) => {
  test.skip(
    !nativeBinary,
    'Requires the native WebRtcPeerLink test host and matching web/embedded assets',
  );
  test.setTimeout(180_000);
  await waitForClientDbReady(page);
  await waitForSynced(page);
  const drive = await page.evaluate(() => window.store.getDrive()!);
  const agent = await page.evaluate(() => window.store.getAgent()!.subject!);
  const secret = await getDevDriveSecret(page);
  await expect
    .poll(
      () =>
        page.evaluate(async subject => {
          try {
            await window.store.makeDriveLocal(subject);

            return true;
          } catch (error) {
            if (
              error instanceof Error &&
              error.message ===
                'Wait for changes to finish syncing before disconnecting.'
            )
              return false;
            throw error;
          }
        }, drive),
      { timeout: 20_000 },
    )
    .toBe(true);
  await waitForClientDbFlush(page, { required: true });
  const relay = signalingRoom();
  await relay.install(context);
  const host = await nativeHost({
    binary: nativeBinary!,
    testName: 'native_webrtc_renderer_host',
    ignored: true,
  });
  let assets: Awaited<ReturnType<typeof serveEmbed>> | undefined;
  const carrier = await context.newPage();
  const renderer = await context.newPage();

  try {
    await host.ready;
    await host.call('__test_initialize', [secret]);
    assets = await serveEmbed();
    await page.evaluate(
      url => localStorage.setItem('peer-signaling-url', url),
      SIGNALING,
    );
    await expect.poll(relay.roomId, { timeout: 20_000 }).toBeTruthy();
    await startNativeCarrier(carrier, host, {
      url: assets.url,
      room: relay.roomId()!,
      drive,
      agent,
    });
    await expect
      .poll(() => host.call('__test_drive_ready', [drive]), { timeout: 30_000 })
      .toBe(true);
    const target = (await host.call('__test_create_file', [drive])) as {
      subject: string;
      file: string;
      hash: string;
      content: string;
    };
    await expect
      .poll(() => carrier.evaluate(() => window.nativeCarrier.held.length), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    await renderer.exposeBinding(
      '__nativeTestCall',
      (_source, method: string, args: unknown[]) => host.call(method, args),
    );
    await renderer.addInitScript(() => {
      const bridge = window as unknown as {
        atomicHost: { call(method: string, args: unknown[]): Promise<unknown> };
        __nativeTestCall(method: string, args: unknown[]): Promise<unknown>;
      };
      bridge.atomicHost = {
        call: (method, args) => bridge.__nativeTestCall(method, args),
      };
    });
    await renderer.setViewportSize({ width: 1440, height: 1400 });
    await renderer.goto(
      `${assets.url}/embed.html?subject=${encodeURIComponent(drive)}`,
    );
    const indicator = renderer
      .getByRole('button', {
        name: /^Copies and sync for Native WebRTC evidence:/,
      })
      .first();
    await expect(indicator).toHaveAttribute(
      'data-peer-sync-state',
      'confirmed',
      { timeout: 30_000 },
    );
    await indicator.click();
    const dialog = renderer.getByRole('dialog', { name: 'Copies & sync' });
    const peers = dialog.getByTestId('resource-peer-copies');
    await expect(peers).toHaveAttribute('data-confirmed-count', '0');
    await expect(
      peers.getByText('Latest changes received', { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByTestId('resource-content-local')).toHaveText(
      'File contents confirmed',
    );
    await expect(
      peers.getByTestId('resource-content-peer'),
    ).not.toHaveAttribute('data-content-state', 'confirmed');
    await expect(dialog).toHaveCSS('opacity', '1');
    await renderer.screenshot({
      path: test.info().outputPath('native-webrtc-details-before-bytes.png'),
      animations: 'disabled',
    });
    await carrier.evaluate(() => window.nativeCarrier.release());
    await expect(peers).toHaveAttribute('data-confirmed-count', '1', {
      timeout: 45_000,
    });
    await expect(peers.getByTestId('resource-content-peer')).toHaveText(
      'File contents confirmed',
    );
    await expect
      .poll(
        () =>
          page.evaluate(subject => {
            const resource = window.store.getResourceLoading(subject);

            return window.store
              .getResourceAttachmentSyncStatus(resource)
              .peers.filter(peer => peer.state === 'confirmed').length;
          }, target.subject),
        { timeout: 30_000 },
      )
      .toBe(1);
    const readBrowserBytes = (hash: string) =>
      page.evaluate(async value => {
        const bytes = await window.store
          .getClientDb()!
          .getBlob(
            Uint8Array.from(
              value.match(/../g)!.map(byte => Number.parseInt(byte, 16)),
            ),
          );

        return bytes ? new TextDecoder().decode(bytes) : null;
      }, hash);
    expect(await readBrowserBytes(target.hash)).toBe(target.content);
    await renderer.screenshot({
      path: test.info().outputPath('native-webrtc-complete-desktop.png'),
      animations: 'disabled',
    });
    await renderer.reload();
    await indicator.click();
    await expect(peers).toHaveAttribute('data-confirmed-count', '1');
    await carrier.evaluate(() => window.nativeCarrier.hold());
    const replacementContent = 'Replaced native WebRTC file contents';
    const replacement = (await host.call('__test_replace_file', [
      target.file,
      replacementContent,
    ])) as { hash: string };
    await expect
      .poll(() => carrier.evaluate(() => window.nativeCarrier.held.length), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    // NoPush is the real minimal embedded host. Reload re-reads its current Db
    // after the native edit, independently of any cached renderer descriptor.
    await renderer.reload();
    await indicator.click();
    await expect(peers).toHaveAttribute('data-confirmed-count', '0');
    await expect(
      peers.getByTestId('resource-content-peer'),
    ).not.toHaveAttribute('data-content-state', 'confirmed');
    await carrier.evaluate(() => window.nativeCarrier.release());
    await expect(peers).toHaveAttribute('data-confirmed-count', '1', {
      timeout: 45_000,
    });
    expect(await readBrowserBytes(replacement.hash)).toBe(replacementContent);
    await dialog.getByRole('button', { name: 'Close copies and sync' }).click();
    await renderer.setViewportSize({ width: 390, height: 844 });
    await indicator.click();
    await expect(dialog).toHaveCSS('opacity', '1');
    await peers.scrollIntoViewIfNeeded();
    await expect(peers.getByTestId('resource-content-peer')).toHaveText(
      'File contents confirmed',
    );
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
    await renderer.screenshot({
      path: test.info().outputPath('native-webrtc-complete-mobile.png'),
      animations: 'disabled',
    });
    await carrier.evaluate(() => window.nativeCarrier.close());
    await expect(peers).toHaveAttribute('data-confirmed-count', '0');
    await expect(peers).toHaveAttribute('data-peer-sync-state', 'unknown');
    await expect(peers.getByTestId('resource-content-peer')).toHaveCount(0);
    expect(await carrier.evaluate(() => window.nativeCarrier.errors)).toEqual(
      [],
    );
    expect(assets.requests).not.toContain('/server');
  } finally {
    const carrierState = await carrier
      .evaluate(() => ({
        errors: window.nativeCarrier?.errors,
        heldByteResponses: window.nativeCarrier?.held.length,
      }))
      .catch(error => ({ unavailable: String(error) }));
    await test.info().attach('native-webrtc-carrier.json', {
      body: JSON.stringify(carrierState, null, 2),
      contentType: 'application/json',
    });
    await carrier.evaluate(() => window.nativeCarrier?.close()).catch(() => {});
    await renderer.close();
    await carrier.close();
    relay.dispose();

    try {
      await host.close();
    } finally {
      await assets?.close();
    }
  }
});
