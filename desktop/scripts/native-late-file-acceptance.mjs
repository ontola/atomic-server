#!/usr/bin/env node
/**
 * Diagnostic helper for an isolated native acceptance app (Node 26+).
 * Does not launch an app, replace its Store, emit file events, or write blobs.
 *
 * node desktop/scripts/native-late-file-acceptance.mjs eval script.js
 * node desktop/scripts/native-late-file-acceptance.mjs launch setup async.js
 * node desktop/scripts/native-late-file-acceptance.mjs poll setup 90000
 * node desktop/scripts/native-late-file-acceptance.mjs screenshot /tmp/native.png
 * node desktop/scripts/native-late-file-acceptance.mjs portal 49238 45000
 *
 * Bridge URL/window can be set with NATIVE_BRIDGE_URL/NATIVE_WINDOW_LABEL.
 * Script files contain function bodies (use `return` to expose a result).
 * launch stores asynchronous results in window.__acceptance[key]; status/poll
 * read only that result so a >5s operation does not time out the bridge IPC.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export class NativeBridge {
  #socket;
  #pending = new Map();

  constructor(socket, windowLabel) {
    this.#socket = socket;
    this.windowLabel = windowLabel;
    socket.addEventListener('message', event => {
      let message;

      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      const pending = this.#pending.get(message.id);
      if (!pending) return; // Ignore broadcasts and late responses.
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.data);
      else
        pending.reject(
          new Error(message.error ?? 'Native bridge command failed.'),
        );
    });
    socket.addEventListener('close', () =>
      this.#rejectPending('Native bridge closed.'),
    );
    socket.addEventListener('error', () =>
      this.#rejectPending('Native bridge connection failed.'),
    );
  }

  static async connect({
    url = process.env.NATIVE_BRIDGE_URL ?? 'ws://127.0.0.1:9223',
    windowLabel = process.env.NATIVE_WINDOW_LABEL ?? 'main',
    timeoutMs = 10_000,
  } = {}) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'ws:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    )
      throw new Error('The diagnostic bridge must use a loopback ws:// URL.');
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`Native bridge did not open within ${timeoutMs}ms.`));
      }, timeoutMs);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolveOpen();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('Could not open native bridge.'));
        },
        { once: true },
      );
    });

    return new NativeBridge(socket, windowLabel);
  }

  #rejectPending(message) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }

    this.#pending.clear();
  }

  command(command, args = {}, { timeoutMs = 15_000 } = {}) {
    if (this.#socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('Native bridge is not open.'));
    const id = randomUUID();

    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            `Native bridge command ${command} timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolveResult, reject, timer });

      try {
        this.#socket.send(JSON.stringify({ id, command, args }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(script) {
    // The bridge already flattens execution success into its WS envelope.
    // A caller's returned object may itself have success/data fields.
    return await this.command('execute_js', {
      windowLabel: this.windowLabel,
      script,
    });
  }

  launch(key, script) {
    return this.evaluate(`
      window.__acceptance = window.__acceptance || {};
      if (window.__acceptance[${JSON.stringify(key)}]?.status === 'pending')
        throw new Error('Acceptance task is already pending.');
      var task = { status: 'pending', startedAt: Date.now() };
      window.__acceptance[${JSON.stringify(key)}] = task;
      Promise.resolve().then(async function () { ${script}\n }).then(
        value => { task.value = value === undefined ? null : value; task.status = 'done'; task.finishedAt = Date.now(); },
        error => { task.error = String(error?.stack || error); task.status = 'failed'; task.finishedAt = Date.now(); }
      );
      return { key: ${JSON.stringify(key)}, status: 'started' };
    `);
  }

  status(key) {
    return this.evaluate(
      `return window.__acceptance?.[${JSON.stringify(key)}] ?? null;`,
    );
  }

  async poll(key, { timeoutMs = 90_000, intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = await this.status(key);
      if (result?.status === 'failed') throw new Error(result.error);
      if (result?.status === 'done') return result;
      await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    }

    throw new Error(
      `Acceptance task ${key} did not finish within ${timeoutMs}ms.`,
    );
  }

  async screenshot(outputFile, { maxWidth = 1200 } = {}) {
    const capture = await this.command(
      'capture_native_screenshot',
      {
        windowLabel: this.windowLabel,
        format: 'png',
        maxWidth,
      },
      { timeoutMs: 30_000 },
    );
    const match = /^data:image\/png;base64,([\s\S]+)$/.exec(
      capture?.dataUrl ?? '',
    );
    if (!match)
      throw new Error('Native screenshot did not return a PNG data URL.');
    const file = resolve(outputFile);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(match[1], 'base64'));

    return {
      file,
      imageWidth: capture.imageWidth,
      imageHeight: capture.imageHeight,
    };
  }

  close() {
    this.#rejectPending('Native bridge closed by acceptance helper.');
    this.#socket.close();
  }
}

/** Test-only portal: let the genuine account fetch outlive the 30s recovery. */
export async function startControlledPortal({
  port = 0,
  host = '127.0.0.1',
  holdMs = 45_000,
  mode = 'hold',
  account = { email: 'native-acceptance@example.invalid' },
} = {}) {
  const validModes = new Set(['hold', 'account', 'signed-out']);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host))
    throw new Error('Acceptance portal must bind loopback.');
  if (!validModes.has(mode) || !Number.isFinite(holdMs) || holdMs < 0)
    throw new Error('Invalid portal mode or hold duration.');
  const pending = new Map();
  let requests = 0;

  const replyAccount = (response, selectedMode = mode) => {
    response.writeHead(selectedMode === 'account' ? 200 : 401, {
      'Content-Type': 'application/json',
    });
    response.end(
      JSON.stringify(
        selectedMode === 'account'
          ? account
          : { error: 'No test account session.' },
      ),
    );
  };

  const release = () => {
    for (const [response, timer] of pending) {
      clearTimeout(timer);
      replyAccount(response);
    }

    pending.clear();
  };

  const status = () => ({ mode, holdMs, requests, pending: pending.size });
  const server = createServer(async (request, response) => {
    // Credentials require an explicit origin. Reflect only native/local test origins.
    const origin = request.headers.origin;

    if (
      origin &&
      /^(tauri:\/\/localhost|https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?)$/.test(
        origin,
      )
    ) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Vary', 'Origin');
    }

    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader(
      'Access-Control-Allow-Headers',
      request.headers['access-control-request-headers'] ??
        'Content-Type, Authorization',
    );
    response.setHeader('Cache-Control', 'no-store');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();

      return;
    }

    const pathname = new URL(request.url, 'http://localhost').pathname;

    if (pathname === '/api/me' && request.method === 'GET') {
      requests++;

      if (mode !== 'hold') {
        replyAccount(response);

        return;
      }

      const timer = setTimeout(() => {
        pending.delete(response);
        replyAccount(response);
      }, holdMs);
      pending.set(response, timer);
      response.on('close', () => {
        clearTimeout(timer);
        pending.delete(response);
      });

      return;
    }

    if (pathname === '/__acceptance/mode' && request.method === 'POST') {
      try {
        let body = '';

        for await (const chunk of request) {
          body += chunk;
          if (body.length > 4096) throw new Error('Body too large.');
        }

        const next = JSON.parse(body);
        if (!validModes.has(next.mode))
          throw new Error('Expected hold, account, or signed-out mode.');
        if (
          next.holdMs !== undefined &&
          (!Number.isFinite(next.holdMs) || next.holdMs < 0)
        )
          throw new Error('Invalid holdMs.');
        mode = next.mode;
        holdMs = next.holdMs ?? holdMs;
      } catch (error) {
        response.writeHead(400);
        response.end(JSON.stringify({ error: error.message }));

        return;
      }
    } else if (
      pathname === '/__acceptance/release' &&
      request.method === 'POST'
    )
      release();
    else if (
      !(pathname === '/__acceptance/status' && request.method === 'GET')
    ) {
      response.writeHead(404);
      response.end();

      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(status()));
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();

  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`,
    status,
    close: async () => {
      for (const [response, timer] of pending) {
        clearTimeout(timer);
        response.destroy();
      }

      pending.clear();
      const closed = new Promise((resolveClose, reject) =>
        server.close(error => (error ? reject(error) : resolveClose())),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}

async function main([mode, first, second]) {
  if (mode === 'portal') {
    const portal = await startControlledPortal({
      port: Number(first ?? 49238),
      holdMs: Number(second ?? 45_000),
    });
    process.stdout.write(
      `${JSON.stringify({ portal: portal.url, ...portal.status() })}\n`,
    );
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.once(signal, () => {
        void portal.close();
      });

    return;
  }

  if (
    !['eval', 'launch', 'status', 'poll', 'screenshot'].includes(mode) ||
    !first ||
    (mode === 'launch' && !second)
  )
    throw new Error(
      'Usage: native-late-file-acceptance.mjs eval FILE | launch KEY FILE | status KEY | poll KEY [TIMEOUT_MS] | screenshot FILE | portal [PORT] [HOLD_MS]',
    );
  const bridge = await NativeBridge.connect();

  try {
    let result;
    if (mode === 'eval')
      result = await bridge.evaluate(await readFile(first, 'utf8'));
    else if (mode === 'launch')
      result = await bridge.launch(first, await readFile(second, 'utf8'));
    else if (mode === 'status') result = await bridge.status(first);
    else if (mode === 'poll')
      result = await bridge.poll(first, {
        timeoutMs: Number(second ?? 90_000),
      });
    else result = await bridge.screenshot(first);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    bridge.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
