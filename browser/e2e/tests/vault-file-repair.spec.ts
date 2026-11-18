import { standaloneTest as test, expect } from './deployment-fixtures';
import { before, FRONTEND_URL } from './test-utils';

test.beforeEach(before);

function materializedResource(json: string | null) {
  if (json === null) return null;

  // Empty runtime containers can change snapshot serialization on navigation
  // without creating operations. Check causal history via version vectors.
  return Object.fromEntries(
    Object.entries(JSON.parse(json)).filter(
      ([property]) =>
        property !== 'https://atomicdata.dev/properties/loroUpdate',
    ),
  );
}

for (const recovery of ['manual', 'open'] as const) {
  test(`recovers missing encrypted file contents without restoring drive history (${recovery})`, async ({
    page,
    browserDiagnostics,
  }) => {
    const origin = new URL(FRONTEND_URL).origin;
    const fixture = await page.evaluate(async () => {
      const buildFixture = async () => {
        const store = window.store;
        const db = store.getClientDb()!;
        const drive = store.getDrive()!;
        const wasmUrl = '/wasm/atomic_wasm.js';
        const wasm = await import(/* @vite-ignore */ wasmUrl);
        await wasm.default();
        const source = await wasm.ClientDb.newInMemory(null);
        const bytes = new TextEncoder().encode('The missing photo contents.');
        const hashBytes = await db.blake3Hash(bytes);
        const hash = Array.from(hashBytes)
          .map(byte => byte.toString(16).padStart(2, '0'))
          .join('');
        const key = wasm.vaultGenerateKey();
        const agent = store.getAgent()!;
        const signature =
          agent.vaultProof ?? (await agent.signBytes(wasm.vaultProofMessage()));
        const encoded = signature.replace(/-/g, '+').replace(/_/g, '/');
        const proof = Uint8Array.from(atob(encoded), letter =>
          letter.charCodeAt(0),
        );
        const envelope = wasm.vaultWrapKey(key, proof);
        await source.putBlob(hashBytes, bytes);
        const plan = await source.vaultBlobOpen(hash, key, 1);
        const chunk = Array.from(
          await source.vaultBlobChunk(hash, key, 1, 0),
        ) as number[];
        await source.vaultBlobClose();
        source.free();
        const file = 'atomic:vault-file-repair-test';
        await db.putResource(
          JSON.stringify({
            '@id': file,
            'https://atomicdata.dev/properties/isA': [
              'https://atomicdata.dev/classes/File',
            ],
            'https://atomicdata.dev/properties/parent': drive,
            'https://atomicdata.dev/properties/internalId': hash,
            'https://atomicdata.dev/properties/blob': 'atomic:blob:' + hash,
            'https://atomicdata.dev/properties/name': 'Current file name',
            'https://atomicdata.dev/properties/filename': 'recovered-note.txt',
            'https://atomicdata.dev/properties/mimetype': 'text/plain',
            'https://atomicdata.dev/properties/filesize': bytes.length,
            'https://atomicdata.dev/properties/downloadURL':
              location.origin + '/download/files/' + hash,
          }),
        );

        return {
          drive,
          file,
          hash,
          envelope,
          chunk,
          blobId: plan.blobId,
          fileBefore: await db.getResource(file),
          missing: (await db.getBlob(hashBytes)) === null,
        };
      };

      // Imports run from a nonce-bearing module, as the production app does.
      return new Promise<Awaited<ReturnType<typeof buildFixture>>>(
        (resolve, reject) => {
          window.addEventListener(
            'file-repair-fixture',
            event => {
              const detail = (
                event as CustomEvent<{
                  result: Awaited<ReturnType<typeof buildFixture>>;
                  error?: string;
                }>
              ).detail;
              if (detail.error) reject(new Error(detail.error));
              else resolve(detail.result);
            },
            { once: true },
          );
          const script = document.createElement('script');
          script.type = 'module';
          script.nonce =
            document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce ??
            '';
          script.textContent =
            '(' +
            buildFixture.toString() +
            ")().then(result => window.dispatchEvent(new CustomEvent('file-repair-fixture', {detail:{result}})), error => window.dispatchEvent(new CustomEvent('file-repair-fixture', {detail:{error:String(error)}})));";
          script.onerror = () =>
            reject(new Error('Could not load the file repair fixture.'));
          document.head.append(script);
        },
      );
    });
    expect(fixture.missing).toBe(true);
    const pseudonym = 'file-repair-vault';
    const enrollment = {
      id: 'file-repair-enrollment',
      status: 'active',
      drive_subject: fixture.drive,
      drive_pseudonym: pseudonym,
      used_bytes: fixture.chunk.length,
      quota_bytes: 100_000_000,
      last_backup_at: Date.now(),
      key_epoch: 1,
    };
    const objectKey = `vault/${pseudonym}/blobs/${fixture.blobId}/000000`;
    await page.addInitScript(portalUrl => {
      Object.assign(window, { __ATOMIC_MANAGED__: { portalUrl } });
    }, origin);
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let json: unknown = [];
      if (path === '/api/me') json = { email: 'repair@example.com' };
      if (path === '/api/cloud-vault/drives') json = [enrollment];
      if (path.endsWith('/state'))
        json = {
          enrollment,
          lanes: {},
          checkpoints: [],
          pending_uploads: 0,
          confirmed_objects: 1,
        };
      if (path.endsWith('/key'))
        json = { envelope: fixture.envelope, key_epoch: 1 };
      if (path.endsWith('/objects'))
        json = [
          {
            object_id: 'repair-object',
            object_key: objectKey,
            kind: 'blob',
            size_bytes: fixture.chunk.length,
          },
        ];
      if (path.endsWith('/download-urls'))
        json = {
          downloads: [
            {
              object_id: 'repair-object',
              object_key: objectKey,
              url: origin + '/repair-file-object',
            },
          ],
        };
      await route.fulfill({ json });
    });
    await page.route('**/repair-file-object', route =>
      route.fulfill({
        contentType: 'application/octet-stream',
        body: Buffer.from(fixture.chunk),
      }),
    );
    const baseline = await page.evaluate(async ({ drive, file }) => {
      const db = window.store.getClientDb()!;

      return {
        versions: await db.getVersionVectorsForSubjects([drive, file]),
        resource: await db.getResource(drive),
      };
    }, fixture);

    if (recovery === 'open') {
      browserDiagnostics.expect(
        'error',
        /^Failed to load resource:.*404/,
        'The file starts without bytes on this device or its server.',
        4,
        /\/download\/files\//,
        { optional: true },
      );
      await page.goto(
        `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(fixture.file)}`,
      );
      await expect(page.locator('pre')).toHaveText(
        'The missing photo contents.',
        { timeout: 30_000 },
      );
      await expect(page.getByTestId('vault-recover-files')).toHaveCount(0);
    } else {
      await page.goto(`${FRONTEND_URL}/app/sync`);
      await expect(page.getByTestId('vault-recover-files')).toBeVisible();
      await page.getByTestId('vault-recover-files').click();
      await expect(
        page.getByTestId('vault-file-recovery-result'),
      ).toContainText('1');
    }

    const result = await page.evaluate(async ({ drive, file, hash }) => {
      const db = window.store.getClientDb()!;
      const hashBytes = Uint8Array.from(hash.match(/../g)!, part =>
        parseInt(part, 16),
      );

      return {
        contents: new TextDecoder().decode(
          (await db.getBlob(hashBytes)) ?? new Uint8Array(),
        ),
        versions: await db.getVersionVectorsForSubjects([drive, file]),
        resource: await db.getResource(drive),
        fileAfter: await db.getResource(file),
      };
    }, fixture);
    expect(result.contents).toBe('The missing photo contents.');
    expect(result.versions).toEqual(baseline.versions);
    expect(materializedResource(result.resource)).toEqual(
      materializedResource(baseline.resource),
    );
    expect(materializedResource(result.fileAfter)).toEqual(
      materializedResource(fixture.fileBefore),
    );

    if (process.env.ATOMIC_FILE_REPAIR_SCREENSHOT) {
      await expect(
        page.locator('#boot-splash:not(.boot-splash-leaving)'),
      ).toHaveCount(0);

      if (recovery === 'open') {
        await page.screenshot({
          path: process.env.ATOMIC_FILE_REPAIR_SCREENSHOT.replace(
            /\.png$/,
            '-automatic.png',
          ),
          animations: 'disabled',
        });

        return;
      }

      await page.getByTestId('vault-recover-files').scrollIntoViewIfNeeded();
      await page.getByTestId('vault-panel').screenshot({
        path: process.env.ATOMIC_FILE_REPAIR_SCREENSHOT,
        animations: 'disabled',
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Show / hide sidebar' }).click();
      await expect
        .poll(
          async () =>
            (await page.getByTestId('vault-panel').boundingBox())?.width ?? 0,
        )
        .toBeGreaterThan(300);
      await page.getByTestId('vault-panel').screenshot({
        path: process.env.ATOMIC_FILE_REPAIR_SCREENSHOT.replace(
          /\.png$/,
          '-mobile.png',
        ),
        animations: 'disabled',
      });
    }
  });
}
