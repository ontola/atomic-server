import { test, expect } from './fixtures';
import { nativeHost, serveEmbed } from './native-host-test-utils';

const nativeBinary = process.env.ATOMIC_NATIVE_EMBED_TEST_BINARY;

test('native Iroh receipts reach the embedded resource panel and disappear on departure', async ({
  page,
}) => {
  test.skip(
    !nativeBinary,
    'Requires the real Iroh integration-test binary and matching dist-embed build',
  );
  test.setTimeout(150_000);
  const host = await nativeHost({
    binary: nativeBinary!,
    testName: 'automatic_bulk_and_live_receipts_survive_receiver_reopen',
  });
  let assets: Awaited<ReturnType<typeof serveEmbed>> | undefined;

  try {
    assets = await serveEmbed();
    const { drive } = await host.ready;
    await page.exposeBinding(
      '__nativeTestCall',
      (_source, method: string, args: unknown[]) => host.call(method, args),
    );
    await page.addInitScript(() => {
      const bridge = window as unknown as {
        atomicHost: {
          call: (method: string, args: unknown[]) => Promise<unknown>;
        };
        __nativeTestCall: (method: string, args: unknown[]) => Promise<unknown>;
      };
      bridge.atomicHost = {
        call: (method, args) => bridge.__nativeTestCall(method, args),
      };
    });
    await page.setViewportSize({ width: 1440, height: 1300 });
    await page.goto(
      `${assets.url}/embed.html?subject=${encodeURIComponent(drive)}`,
    );
    const resourceIndicator = page
      .getByRole('button', { name: /^Copies and sync for Receipt C1:/ })
      .first();
    await expect(resourceIndicator).toHaveAttribute(
      'data-peer-sync-state',
      'confirmed',
      { timeout: 30_000 },
    );
    await resourceIndicator.click();
    const dialog = page.getByRole('dialog', { name: 'Copies & sync' });
    const peers = dialog.getByTestId('resource-peer-copies');
    await expect(dialog).toHaveCSS('opacity', '1');
    await expect(peers).toHaveAttribute('data-confirmed-count', '1');
    await expect(dialog.getByTestId('resource-content-local')).toHaveAttribute(
      'data-content-state',
      'confirmed',
    );
    await expect(peers.getByTestId('resource-content-peer')).toHaveAttribute(
      'data-content-state',
      'confirmed',
    );
    await expect(dialog.getByTestId('resource-content-local')).toHaveText(
      'File contents confirmed',
    );
    await expect(peers.getByTestId('resource-content-peer')).toHaveText(
      'File contents confirmed',
    );
    await expect(
      dialog.getByText('Resource details: No server configured', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      peers.getByText('Latest changes received', { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('native-iroh-desktop.png'),
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: 'Close copies and sync' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await resourceIndicator.click();
    await expect(dialog).toHaveCSS('opacity', '1');
    await peers.scrollIntoViewIfNeeded();
    await expect(peers).toHaveAttribute('data-confirmed-count', '1');
    await expect(dialog.getByTestId('resource-content-local')).toHaveAttribute(
      'data-content-state',
      'confirmed',
    );
    await expect(peers.getByTestId('resource-content-peer')).toHaveAttribute(
      'data-content-state',
      'confirmed',
    );
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
    await page.screenshot({
      path: test.info().outputPath('native-iroh-mobile.png'),
      animations: 'disabled',
    });
    // Reloading the renderer re-queries the still-live native host.
    await page.reload();
    await expect(resourceIndicator).toHaveAttribute(
      'data-peer-sync-state',
      'confirmed',
    );
    await resourceIndicator.click();
    await expect(peers).toHaveAttribute('data-confirmed-count', '1');
    await expect(dialog.getByTestId('resource-content-local')).toHaveAttribute(
      'data-content-state',
      'confirmed',
    );
    await expect(peers.getByTestId('resource-content-peer')).toHaveAttribute(
      'data-content-state',
      'confirmed',
    );
    await host.call('__test_close_peer');
    await expect(peers).toHaveAttribute('data-confirmed-count', '0', {
      timeout: 45_000,
    });
    await expect(peers).toHaveAttribute('data-peer-sync-state', 'unknown');
    await expect(peers.getByTestId('resource-content-peer')).toHaveCount(0);
    await page.reload();
    await expect(resourceIndicator).toBeVisible();
    await resourceIndicator.click();
    await expect(peers).toHaveAttribute('data-confirmed-count', '0');
    await expect(peers).toHaveAttribute('data-peer-sync-state', 'unknown');
    await expect(peers.getByTestId('resource-content-peer')).toHaveCount(0);
    expect(assets.requests).not.toContain('/server');
  } finally {
    await page.close();

    try {
      await host.close();
    } finally {
      await assets?.close();
    }
  }
});
