import { test, expect } from '@playwright/test';
import { before } from './test-utils';

/**
 * Regression test: after creating a fresh dev-drive and refreshing the
 * page, no `/query?...` request — over WS or HTTP — should carry a
 * `drive=<server-origin>` filter. The old fallback in CollectionBuilder
 * defaulted `drive` to the server URL string (e.g. `http://localhost:9883`)
 * when the caller didn't `setDrive(...)`. The server then filters
 * `drive == "http://localhost:9883"`, which never matches any real
 * resource (resources are scoped by drive DID), so every default-drive
 * query returned zero rows — wasted work that the user noticed in their
 * console: tons of `/query?drive=http%3A%2F%2Flocalhost%3A9883&...`
 * requests on `/app/sync` after a hard refresh.
 *
 * Note: most `/query` traffic flows over the WebSocket (the store
 * prefers `ws.fetch(subject)` when the socket is open, see
 * `store.ts:1441`), so the regression has to listen for WS frames in
 * addition to HTTP GETs.
 */
test.describe('query GETs after refresh', () => {
  test.beforeEach(before);

  test('no /query request uses the server origin as a drive filter', async ({
    page,
  }) => {
    const badRequests: string[] = [];

    const isBad = (url: string) => {
      if (!url.includes('/query?')) return false;
      try {
        const u = new URL(url, 'http://placeholder');
        const drive = u.searchParams.get('drive');
        if (!drive) return false;
        // Valid: did:ad:... DID. Invalid: any HTTP(S) URL string.
        return !drive.startsWith('did:ad:');
      } catch {
        return false;
      }
    };

    page.on('request', req => {
      if (req.method() !== 'GET') return;
      if (isBad(req.url())) badRequests.push('HTTP ' + req.url());
    });

    page.on('websocket', ws => {
      ws.on('framesent', frame => {
        // WS v2 frames are text — `GET <url>` for a fetch. The full URL
        // appears verbatim; scan each whitespace-separated token.
        const payload = frame.payload?.toString() ?? '';
        for (const word of payload.split(/\s+/)) {
          if (isBad(word)) badRequests.push('WS ' + word);
        }
      });
    });

    // Hard refresh — this is the bootstrap path where useCollection /
    // useChildren hooks build their CollectionBuilders.
    await page.reload({ waitUntil: 'domcontentloaded' });

    await page.waitForFunction(
      () => (window as any).store?.getSyncStatus()?.serverConnected === true,
      undefined,
      { timeout: 30000 },
    );
    // Idle window: let any deferred queries land.
    await page.waitForTimeout(2000);

    expect(
      badRequests,
      'Found /query requests with non-DID drive filter. Drive filter must ' +
        'be a did:ad:... DID, never a server-origin URL:\n' +
        badRequests.map(u => '  ' + u).join('\n'),
    ).toEqual([]);
  });
});
