import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test, expect } from './fixtures';

const embedDirectory = path.resolve(__dirname, '../../data-browser/dist-embed');

/** Starts the selected test-owned native database/protocol host and forwards
 * the embedded renderer's existing NativeChannel directly to real EmbedHost.
 * Iroh and WebRTC fixtures share process control and static asset serving;
 * transport, authentication, storage and receipts remain production code. */
export async function nativeHost(options: {
  binary: string;
  testName: string;
  ignored?: boolean;
}) {
  const child = spawn(
    options.binary,
    [
      options.testName,
      ...(options.ignored ? ['--ignored'] : []),
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
  let becameReady = false;
  let startupFailure: string | undefined;
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

    if (readyStart >= 0) {
      becameReady = true;
      readyResolve(JSON.parse(line.slice(readyStart + 18)));
    }

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
    if (!becameReady) startupFailure ??= error.message;
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
    () => fail(new Error('Native fixture did not become ready')),
    // Database bootstrap plus the initial 30s byte-receipt retry precede readiness.
    75_000,
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
    await test.info().attach('native-host.log', {
      body: `${JSON.stringify({ becameReady, startupFailure, exitCode: child.exitCode, signalCode: child.signalCode })}\n${log}`,
      contentType: 'text/plain',
    });
    expect(child.exitCode, 'native fixture should stop cleanly').toBe(0);
  };

  return { ready: ready.finally(() => clearTimeout(readyTimer)), call, close };
}

export async function serveEmbed() {
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

    if (pathname === '/test-carrier.html') {
      response
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end('<!doctype html><title>Native WebRTC transport carrier</title>');

      return;
    }

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
