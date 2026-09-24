// A static stand-in for https://ontola.github.io/atomic-plugins/, so specs
// never depend on what is currently published there. It serves the same
// layout: `integrations/catalog.json` plus a `plugin.js` bundle per plugin
// under `integrations/<id>/`. The bundles are the existing test plugins in
// testdata/, served in place rather than copied.
//
//   node testdata/atomic-plugins-mock/serve.mjs [port]
//
// Playwright starts this (browser/e2e/playwright.config.ts) and seeds the
// app's catalog URL with it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const ASSETS = {
  '/integrations/catalog.json': [
    resolve(here, 'integrations/catalog.json'),
    'application/json',
  ],
  '/integrations/plugin-for-testing/plugin.js': [
    resolve(here, '../plugin-for-testing/plugin.js'),
    'text/javascript',
  ],
  '/integrations/plugin-sync/plugin.js': [
    resolve(here, '../plugin-sync/plugin.js'),
    'text/javascript',
  ],
};

// The SPA reads these cross-origin, from whichever origin serves it.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
};

export function createMockServer() {
  return createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end();

      return;
    }

    const asset = ASSETS[new URL(req.url ?? '/', 'http://x').pathname];

    if ((req.method !== 'GET' && req.method !== 'HEAD') || !asset) {
      res.writeHead(404, CORS).end();

      return;
    }

    const [path, contentType] = asset;
    res
      .writeHead(200, {
        ...CORS,
        'content-type': contentType,
        'cache-control': 'no-store',
      })
      .end(req.method === 'HEAD' ? undefined : await readFile(path));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 9893);
  createMockServer().listen(port, '127.0.0.1', () =>
    console.log(`atomic-plugins mock on http://127.0.0.1:${port}/`),
  );
}
