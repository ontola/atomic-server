import { managedTest as test, expect } from './deployment-fixtures';
import type { Page } from './fixtures';
import { FRONTEND_URL } from './test-utils';

const EMAIL = 'vault-first-backup@example.com';
const VAULT = 'first-backup-fixture';
const DESCRIPTION = 'https://atomicdata.dev/properties/description';

type Failure = 'enroll' | 'upload';

type Reservation = {
  size_bytes: number;
} & (
  | { kind: 'checkpoint'; checkpoint_n: number }
  | { kind: 'pack'; lane_device_pubkey: string; segment: number }
);

/** Mock only the account service and object storage. Uploads are sealed by
 * the real client, and confirming an object requires a successful PUT.
 */
async function mockVault(page: Page, failure: Failure) {
  const firstUpload = Promise.withResolvers<void>();
  const firstConfirmation = Promise.withResolvers<void>();
  const state = {
    failure: failure as Failure | null,
    enrollAttempts: 0,
    uploadAttempts: 0,
    confirmAttempts: 0,
    confirmed: 0,
    releaseFirstUpload: firstUpload.resolve,
    releaseFirstConfirmation: firstConfirmation.resolve,
  };
  const enrollment = {
    id: VAULT,
    drive_pseudonym: VAULT,
    drive_subject: '',
    agent_subject: '',
    status: 'active',
    quota_bytes: 5_000_000,
    used_bytes: 0,
    last_backup_at: null as number | null,
  };
  const reservations = new Map<string, Reservation>();
  const uploaded = new Set<string>();
  const lanes: Record<string, number> = {};
  const checkpoints: { checkpoint_n: number }[] = [];
  let envelope: string | null = null;
  let recovery: object | null = null;

  await page.route('**/api/me', route =>
    route.fulfill({ json: { email: EMAIL } }),
  );
  await page.route('**/api/auth/providers', route =>
    route.fulfill({ json: { assisted_recovery: true } }),
  );
  await page.route('**/api/recovery-secret/assisted-key', route =>
    route.fulfill({ json: { key: Buffer.alloc(32, 1).toString('base64') } }),
  );
  await page.route('**/api/recovery-secret', route => {
    if (route.request().method() === 'PUT') {
      recovery = {
        ...route.request().postDataJSON(),
        owner_email: EMAIL,
        created_at: 1,
        updated_at: 1,
      };
    }

    return recovery
      ? route.fulfill({ json: recovery })
      : route.fulfill({ status: 204 });
  });
  await page.route('**/api/cloud-vault/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(
      '/api/cloud-vault/',
      '',
    );

    switch (path) {
      case 'eligibility':
        return route.fulfill({ json: { can_enroll: true } });

      case 'enroll': {
        state.enrollAttempts++;

        if (state.failure === 'enroll') {
          return route.fulfill({
            status: 503,
            json: { error: 'Fixture refused Vault enrollment' },
          });
        }

        const { drive_subject, agent_subject } = request.postDataJSON();
        enrollment.drive_subject = drive_subject;
        enrollment.agent_subject = agent_subject;

        return route.fulfill({ json: { enrollment } });
      }

      case 'drives':
        return route.fulfill({
          json: enrollment.drive_subject ? [enrollment] : [],
        });
      case 'drive-status':
        return route.fulfill({
          json: enrollment.drive_subject
            ? {
                enabled: true,
                is_yours: true,
                suspended: false,
                last_backup_at: enrollment.last_backup_at,
                backed_up_by: null,
              }
            : { enabled: false },
        });
      case `${VAULT}/state`:
        return route.fulfill({
          json: {
            enrollment,
            lanes,
            checkpoints,
            pending_uploads: 0,
            confirmed_objects: state.confirmed,
          },
        });
      case `${VAULT}/key`:
        if (request.method() === 'PUT') {
          envelope = request.postDataJSON().envelope;

          return route.fulfill({ json: {} });
        }

        return envelope
          ? route.fulfill({ json: { envelope } })
          : route.fulfill({ status: 204 });

      case `${VAULT}/upload-urls`: {
        const [object] = request.postDataJSON().objects as Reservation[];
        const id = String(reservations.size + 1);
        reservations.set(id, object);
        const pad = (n: number) => String(n).padStart(6, '0');
        const key =
          object.kind === 'checkpoint'
            ? `checkpoints/ckpt-${pad(object.checkpoint_n)}.loro`
            : `lanes/${object.lane_device_pubkey}/seg-${pad(object.segment)}.pack`;

        return route.fulfill({
          json: {
            uploads: [
              {
                object_id: id,
                object_key: `vault/${VAULT}/${key}`,
                url: new URL(`/vault-fixture-objects/${id}`, FRONTEND_URL).href,
                method: 'PUT',
                headers: [],
              },
            ],
          },
        });
      }

      case `${VAULT}/confirm-upload`: {
        if (++state.confirmAttempts === 1) await firstConfirmation.promise;

        for (const { object_id, size_bytes } of request.postDataJSON()
          .confirmations) {
          expect(uploaded.has(object_id)).toBe(true);
          const object = reservations.get(object_id)!;
          expect(size_bytes).toBe(object.size_bytes);
          state.confirmed++;
          enrollment.used_bytes += size_bytes;
          if (object.kind === 'pack')
            lanes[object.lane_device_pubkey] = object.segment;
        }

        // Use a distinct time so a later failure cannot show "just now" in
        // place of the last confirmed backup time.
        enrollment.last_backup_at = Math.floor(Date.now() / 1000) - 3 * 3600;

        return route.fulfill({ json: {} });
      }

      case `${VAULT}/checkpoint`:
        checkpoints.push(request.postDataJSON());

        return route.fulfill({ json: {} });
      default:
        return route.fallback();
    }
  });
  await page.route('**/vault-fixture-objects/*', async route => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split('/').pop()!;
    expect(request.method()).toBe('PUT');
    expect(request.postDataBuffer()?.length).toBe(
      reservations.get(id)!.size_bytes,
    );

    if (++state.uploadAttempts === 1 && failure === 'upload') {
      await firstUpload.promise;
    }

    if (state.failure === 'upload') return route.fulfill({ status: 503 });

    uploaded.add(id);

    return route.fulfill({ status: 200 });
  });

  return state;
}

async function editWorkspace(page: Page, value: string) {
  await page.evaluate(
    async ({ property, description }) => {
      const store = window.store;
      const drive = await store.getResource(store.getDrive()!);
      await drive.set(property, description);
      await drive.save();
      await store.getClientDb()!.flush();
    },
    { property: DESCRIPTION, description: value },
  );
}

test.use({ serviceWorkers: 'block' });

for (const failure of ['upload', 'enroll'] as const) {
  test(`a managed signup can recover from a failed first Vault ${failure}`, async ({
    page,
    browserDiagnostics,
  }) => {
    test.slow();
    browserDiagnostics.expect(
      'warning',
      /^Service Worker registration blocked by Playwright$/,
      'The same-origin test service responses are intercepted by Playwright.',
      3,
      undefined,
      { optional: true },
    );
    browserDiagnostics.expect(
      'error',
      /^Failed to load resource:.*503/,
      'The test rejects Vault enrollment or the storage PUT until retry.',
      5,
      /\/api\/cloud-vault\/enroll$|\/vault-fixture-objects\/\d+$/,
      { optional: true },
    );
    browserDiagnostics.expect(
      'warning',
      /^\[cloud-vault\] backup failed.*(?:Vault upload failed \(503\)|Fixture refused Vault enrollment)/,
      'Automatic backup logs each of the test’s deliberate failures.',
      5,
      undefined,
      { optional: true },
    );

    const vault = await mockVault(page, failure);
    const status = page.getByTestId('vault-first-backup-status');
    const retry = status.getByRole('button', { name: 'Retry backup' });
    const canary = 'Edited before the first Cloud Vault backup';

    try {
      await page.goto(
        `${FRONTEND_URL}/app/welcome?from_portal=true&email=${encodeURIComponent(EMAIL)}`,
      );
      await page
        .getByRole('button', { name: 'Save and continue', exact: true })
        .click({ timeout: 30_000 });
      await expect(page).toHaveURL(/\/app\/show\?subject=/, {
        timeout: 30_000,
      });
      await expect(status).toContainText(
        'This workspace has no confirmed Cloud Vault copy.',
      );
      await editWorkspace(page, canary);

      if (failure === 'upload') {
        // Enter and edit the local workspace while the first upload is
        // still pending, then fail that PUT.
        await expect.poll(() => vault.uploadAttempts).toBe(1);
        await expect(status).toContainText('hasn’t completed the first backup');
        vault.releaseFirstUpload();
      } else {
        await expect.poll(() => vault.enrollAttempts).toBeGreaterThan(0);
        expect(vault.uploadAttempts).toBe(0);
      }

      await expect(status).toContainText(
        'The first Cloud Vault backup failed.',
      );
      expect(vault.confirmAttempts).toBe(0);
      await page.reload();
      await expect(status).toContainText(
        'The first Cloud Vault backup failed.',
        { timeout: 30_000 },
      );
      expect(
        await page.evaluate(async property => {
          const store = window.store;
          const drive = await store.getResource(store.getDrive()!);

          return drive.get(property);
        }, DESCRIPTION),
      ).toBe(canary);
      await expect(retry).toBeEnabled();

      if (
        failure === 'upload' &&
        process.env.ATOMIC_VAULT_FIRST_BACKUP_SCREENSHOT
      ) {
        await page.screenshot({
          path: process.env.ATOMIC_VAULT_FIRST_BACKUP_SCREENSHOT,
        });
      }

      vault.failure = null;
      await retry.click();
      await expect.poll(() => vault.confirmAttempts).toBe(1);
      await expect(status).toBeVisible();
      expect(vault.confirmed).toBe(0);
      vault.releaseFirstConfirmation();
      await expect(status).toBeHidden();
      expect(vault.confirmed).toBe(1);

      if (failure === 'upload') {
        await page.goto(`${FRONTEND_URL}/app/sync`);
        const summary = page.getByTestId('vault-summary');
        await expect(summary).toContainText(/Backed up \d+h ago/);
        const lastSuccessful = await summary.innerText();
        vault.failure = 'upload';
        await editWorkspace(page, 'Edited after the first Cloud Vault backup');
        await page.getByTestId('vault-backup-now').click();
        await expect(page.getByTestId('vault-error')).toContainText(
          'Vault upload failed (503)',
        );
        await expect(summary).toHaveText(lastSuccessful);
        expect(vault.confirmed).toBe(1);
      }
    } finally {
      vault.releaseFirstUpload();
      vault.releaseFirstConfirmation();
    }
  });
}
