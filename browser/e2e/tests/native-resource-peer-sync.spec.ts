import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test, expect } from './fixtures';

const nativeBinary = process.env.ATOMIC_NATIVE_EMBED_TEST_BINARY;
const embedDirectory = path.resolve(__dirname, '../../data-browser/dist-embed');

/** The normal dev-drive endpoint is a web-server fixture. This fixture instead
 * starts two real native databases and Iroh processes, then forwards the
 * embedded renderer's existing NativeChannel directly to the real EmbedHost.
 * Only process control and static asset serving belong to the test. */
async function nativeHost() {
  const child = spawn(
    nativeBinary!,
    [
      'automatic_bulk_and_live_receipts_survive_receiver_reopen',
      '--exact',
      '--nocapture',
      '--test-threads=1',
    ],
    {
      env: { ...process.env, ATOMIC_NATIVE_RENDERER_HOST: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    },
  );
  let log = '';
  let nextId = 0;
  let readyResolve!: (value: { drive: string; subject: string }) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<{ drive: string; subject: string }>(
    (resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    },
  );
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    log += `${line}\n`;
    // libtest may prefix the first message with the test name.
    const readyStart = line.indexOf('NATIVE_HOST_READY ');
    const replyStart = line.indexOf('NATIVE_HOST_REPLY ');

    if (readyStart >= 0) readyResolve(JSON.parse(line.slice(readyStart + 18)));
    if (replyStart < 0) return;
    const reply = JSON.parse(line.slice(replyStart + 18));
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    clearTimeout(request.timer);
    if (reply.ok) request.resolve(reply.value);
    else request.reject(new Error(reply.error));
  });
  child.stderr.on('data', chunk => {
    log += String(chunk);
  });

  const fail = (error: Error) => {
    readyReject(error);

    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }

    pending.clear();
  };

  child.on('error', fail);
  child.stdin.on('error', fail);
  const exited = new Promise<void>(resolve => {
    child.on('exit', (code, signal) => {
      fail(new Error(`Native fixture exited (${code ?? signal})`));
      resolve();
    });
  });
  const readyTimer = setTimeout(
    () => readyReject(new Error('Native Iroh fixture did not become ready')),
    45_000,
  );
  const call = (method: string, args: unknown[] = []) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Native fixture call timed out: ${method}`));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
    });

  const close = async () => {
    clearTimeout(readyTimer);

    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end(
        `${JSON.stringify({ method: '__test_stop', args: [] })}\n`,
      );
      const kill = setTimeout(() => {
        // This group contains only our fixture and its receiver child.
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      }, 5000);
      await exited;
      clearTimeout(kill);
    }

    lines.close();
    await test
      .info()
      .attach('native-iroh-host.log', { body: log, contentType: 'text/plain' });
    expect(child.exitCode, 'native fixture should stop cleanly').toBe(0);
  };

  return { ready: ready.finally(() => clearTimeout(readyTimer)), call, close };
}

async function serveEmbed() {
  const contentTypes: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
  };
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(
      new URL(request.url!, 'http://localhost').pathname,
    );
    requests.push(pathname);
    const file = path.resolve(embedDirectory, `.${pathname}`);

    if (!file.startsWith(`${embedDirectory}${path.sep}`)) {
      response.writeHead(403).end();

      return;
    }

    try {
      const body = await readFile(file);
      response
        .writeHead(200, {
          'Content-Type':
            contentTypes[path.extname(file)] ?? 'application/octet-stream',
        })
        .end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing embed server port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
  };
}

test('native Iroh receipts reach the embedded resource panel and disappear on departure', async ({
  page,
}) => {
  test.skip(
    !nativeBinary,
    'Requires the real Iroh integration-test binary and matching dist-embed build',
  );
  test.setTimeout(120_000);
  const host = await nativeHost();
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
    await expect(
      dialog.getByText('No server configured', { exact: true }),
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
    await host.call('__test_close_peer');
    await expect(peers).toHaveAttribute('data-confirmed-count', '0', {
      timeout: 45_000,
    });
    await expect(peers).toHaveAttribute('data-peer-sync-state', 'unknown');
    await page.reload();
    await expect(resourceIndicator).toBeVisible();
    await resourceIndicator.click();
    await expect(peers).toHaveAttribute('data-confirmed-count', '0');
    await expect(peers).toHaveAttribute('data-peer-sync-state', 'unknown');
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
