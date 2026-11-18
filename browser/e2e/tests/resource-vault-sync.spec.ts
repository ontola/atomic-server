import type { Page } from '@playwright/test';
import { managedDriveTest as test, expect } from './deployment-fixtures';
import {
  FRONTEND_URL,
  waitForClientDbFlush,
  waitForClientDbReady,
  waitForSynced,
} from './test-utils';

const ACCOUNT = 'resource-vault@example.com';
const PSEUDONYM = 'resource-vault-test';
type Reservation = {
  kind: 'checkpoint' | 'pack';
  size_bytes: number;
  key_epoch: number;
  checkpoint_n?: number;
  lane_device_pubkey?: string;
  segment?: number;
};

/** Only the HTTP control plane/object store is simulated. The app generates
 * its key, exports real OPFS resources, encrypts, and writes its own receipts. */
async function installVaultPortal(
  page: Page,
  onUploadFailure?: (url: string) => void,
) {
  const identity = await page.evaluate(() => ({
    drive: window.store.getDrive()!,
    agent: window.store.getAgent()!.subject,
  }));
  const enrollment = {
    id: 'resource-vault-enrollment',
    drive_subject: identity.drive,
    agent_subject: identity.agent,
    drive_pseudonym: PSEUDONYM,
    status: 'active',
    used_bytes: 0,
    quota_bytes: 5_000_000_000,
    last_backup_at: null as number | null,
    key_epoch: 1,
  };
  const state = {
    account: ACCOUNT,
    enrolled: false,
    keyEnvelope: '',
    mode: 'success' as 'success' | 'hold' | 'fail',
    held: [] as Array<() => void>,
    reservations: new Map<string, Reservation>(),
    uploaded: new Map<string, Buffer>(),
    confirmed: new Set<string>(),
    checkpoints: [] as Array<{
      checkpoint_n: number;
      coverage: Record<string, number>;
      checkpoint_object_id: string;
      created_at: number;
    }>,
    lanes: {} as Record<string, number>,
  };
  await page.route('**/api/me', route =>
    route.fulfill({ json: { email: state.account } }),
  );
  await page.route('**/api/sync-enrollments', route =>
    route.fulfill({ json: [] }),
  );
  await page.route('**/api/recovery-secret', route =>
    route.fulfill({
      json: {
        owner_email: state.account,
        agent_subject: identity.agent,
        drive_subject: identity.drive,
        wrappers: [],
      },
    }),
  );
  await page.route('**/api/cloud-vault/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const ownsVault = state.account === ACCOUNT;

    if (path.endsWith('/eligibility')) {
      await route.fulfill({ json: { can_enroll: ownsVault } });
    } else if (path.endsWith('/enroll')) {
      expect(route.request().postDataJSON().drive_subject).toBe(identity.drive);
      state.enrolled = true;
      await route.fulfill({ json: { enrollment } });
    } else if (path.endsWith('/drives')) {
      await route.fulfill({
        json: state.enrolled && ownsVault ? [enrollment] : [],
      });
    } else if (path.endsWith('/drive-status')) {
      await route.fulfill({
        json: {
          enabled: state.enrolled && ownsVault,
          is_yours: ownsVault,
          suspended: false,
          last_backup_at: enrollment.last_backup_at,
          backed_up_by: null,
        },
      });
    } else if (path.endsWith('/state')) {
      await route.fulfill({
        json: {
          enrollment,
          lanes: state.lanes,
          checkpoints: state.checkpoints,
          pending_uploads: state.reservations.size - state.confirmed.size,
          confirmed_objects: state.confirmed.size,
        },
      });
    } else if (path.endsWith('/key')) {
      if (method === 'PUT') {
        state.keyEnvelope = route.request().postDataJSON().envelope;
        await route.fulfill({ json: {} });
      } else if (state.keyEnvelope) {
        await route.fulfill({
          json: { envelope: state.keyEnvelope, key_epoch: 1 },
        });
      } else {
        await route.fulfill({ status: 204 });
      }
    } else if (path.endsWith('/upload-urls')) {
      const [reservation] = route.request().postDataJSON()
        .objects as Reservation[];
      const id = `object-${state.reservations.size + 1}`;
      state.reservations.set(id, reservation);
      const suffix =
        reservation.kind === 'checkpoint'
          ? `checkpoints/ckpt-${String(reservation.checkpoint_n).padStart(6, '0')}.loro`
          : `lanes/${reservation.lane_device_pubkey}/seg-${String(reservation.segment).padStart(6, '0')}.pack`;
      await route.fulfill({
        json: {
          uploads: [
            {
              object_id: id,
              object_key: `vault/${PSEUDONYM}/${suffix}`,
              url: `${new URL(FRONTEND_URL).origin}/test-vault-objects/${id}`,
              method: 'PUT',
              headers: [],
              size_bytes: reservation.size_bytes,
            },
          ],
        },
      });
    } else if (path.endsWith('/confirm-upload')) {
      for (const confirmation of route.request().postDataJSON().confirmations) {
        const bytes = state.uploaded.get(confirmation.object_id);
        expect(bytes?.length).toBe(confirmation.size_bytes);
        state.confirmed.add(confirmation.object_id);
        const reservation = state.reservations.get(confirmation.object_id)!;
        enrollment.used_bytes += bytes!.length;
        enrollment.last_backup_at = Math.floor(Date.now() / 1000);
        if (reservation.kind === 'pack')
          state.lanes[reservation.lane_device_pubkey!] = reservation.segment!;
      }

      await route.fulfill({ json: {} });
    } else if (path.endsWith('/checkpoint')) {
      const checkpoint = route.request().postDataJSON();
      expect(state.confirmed.has(checkpoint.checkpoint_object_id)).toBe(true);
      state.checkpoints.push({ ...checkpoint, created_at: Date.now() / 1000 });
      await route.fulfill({ json: {} });
    } else {
      throw new Error(`Unimplemented test Vault endpoint: ${method} ${path}`);
    }
  });
  await page.route('**/test-vault-objects/*', async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!;

    if (state.mode === 'hold') {
      await new Promise<void>(resolve => state.held.push(resolve));
    } else if (state.mode === 'fail') {
      onUploadFailure?.(route.request().url());
      await route.fulfill({
        status: 503,
        body: 'Deliberate test upload failure',
      });

      return;
    }

    const bytes = route.request().postDataBuffer()!;
    expect(bytes.length).toBe(state.reservations.get(id)!.size_bytes);
    expect(bytes.length).toBeGreaterThan(32);
    expect(bytes.includes(Buffer.from('Vault evidence canary'))).toBe(false);
    state.uploaded.set(id, bytes);
    await route.fulfill({ status: 200 });
  });

  return state;
}

function indicatorFor(page: Page, name: string) {
  return page
    .locator('section')
    .filter({
      has: page.getByRole('heading', { name: 'Resources', exact: true }),
    })
    .getByRole('button', { name: new RegExp(`^Copies and sync for ${name}:`) });
}

async function waitForPanel(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Copies & sync' });
  await expect(dialog).toHaveCSS('opacity', '1');
  await expect(async () => {
    const before = await dialog.boundingBox();
    await page.evaluate(
      () =>
        new Promise<void>(resolve => requestAnimationFrame(() => resolve())),
    );
    expect(await dialog.boundingBox()).toEqual(before);
  }).toPass();

  return dialog;
}

async function saveName(page: Page, subject: string, name: string) {
  await page.evaluate(
    async args => {
      const resource = await window.store.getResource(args.subject);
      await resource.set(
        'https://atomicdata.dev/properties/name',
        args.name,
        false,
      );
      await resource.save();
    },
    { subject, name },
  );
  await waitForSynced(page);
  await waitForClientDbFlush(page, { required: true });
}

test('real encrypted backup restores scoped resource proof on reload and keeps file contents unverified', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1300 });
  await waitForClientDbReady(page);
  const portal = await installVaultPortal(page);
  await page.evaluate(async () => {
    await window.store.uploadFiles(
      [
        new File(['Vault evidence canary'], 'Vault evidence canary.txt', {
          type: 'text/plain',
        }),
      ],
      window.store.getDrive()!,
    );
  });
  await waitForSynced(page);
  await waitForClientDbFlush(page, { required: true });
  const listUrl = page.url();
  await page.goto(`${FRONTEND_URL}/app/sync`);
  await page.getByTestId('vault-enable').click();
  await expect(page.getByTestId('vault-backup-now')).toBeEnabled();
  await expect.poll(() => portal.checkpoints.length).toBe(1);
  expect(portal.uploaded.size).toBeGreaterThan(0);
  await page.goto(listUrl);
  const indicator = indicatorFor(page, 'Vault evidence canary.txt');
  await expect(indicator).toHaveAttribute('data-vault-sync-state', 'confirmed');
  await indicator.click();
  const panel = page.getByTestId('resource-sync-panel');
  await expect(
    panel.getByText('Latest changes backed up', { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText(
      'These confirmations cover file details. The file’s contents are not verified here.',
    ),
  ).toBeVisible();
  const receiptTime = await panel
    .getByText(/^Last confirmed backup:/)
    .textContent();
  await waitForPanel(page);
  await page.screenshot({
    path: test.info().outputPath('resource-vault-desktop.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await waitForClientDbFlush(page, { required: true });
  const uploadsBeforeReload = portal.uploaded.size;
  await page.reload();
  await expect(indicator).toHaveAttribute('data-vault-sync-state', 'confirmed');
  await indicator.click();
  await expect(panel.getByText(/^Last confirmed backup:/)).toHaveText(
    receiptTime!,
  );
  expect(portal.uploaded.size).toBe(uploadsBeforeReload);
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  await page
    .getByRole('button', { name: 'Show / hide sidebar', exact: false })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await indicator.click();
  const dialog = await waitForPanel(page);
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  await page.screenshot({
    path: test.info().outputPath('resource-vault-mobile.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await panel
    .getByRole('link', { name: 'Manage sync' })
    .scrollIntoViewIfNeeded();
  await expect(
    panel.getByRole('link', { name: 'Manage sync' }),
  ).toBeInViewport();
  await expect(
    panel.getByText(
      'These confirmations cover file details. The file’s contents are not verified here.',
    ),
  ).toBeInViewport();
  await waitForPanel(page);
  await page.screenshot({
    path: test.info().outputPath('resource-vault-mobile-footer.png'),
    fullPage: true,
    animations: 'disabled',
  });
  portal.account = 'another-vault-account@example.com';
  await page.reload();
  await expect(indicator).toHaveAttribute('data-vault-sync-state', 'unknown');
  await indicator.click();
  await expect(panel.getByText('Resource backup not confirmed')).toBeVisible();
  await expect(
    panel.getByText('Latest changes backed up', { exact: true }),
  ).toHaveCount(0);
});

test('an edit after encrypted export stays pending and failed upload cannot confirm it', async ({
  page,
  browserDiagnostics,
}) => {
  await waitForClientDbReady(page);
  const portal = await installVaultPortal(page, url => {
    browserDiagnostics.expect(
      'error',
      /^Failed to load resource:.*503/,
      'This exact encrypted upload is deliberately rejected by the test portal.',
      1,
      new RegExp(
        `/test-vault-objects/${new URL(url).pathname.split('/').at(-1)}$`,
      ),
    );
    browserDiagnostics.expect(
      'warning',
      /^\[cloud-vault\] backup failed Error: Vault upload failed \(503\)/,
      'An automatic backup may encounter the same deliberately failed upload.',
      1,
      /\/assets\/chunk_vaultAutoBackup-[^/]+\.js$/,
      { optional: true },
    );
  });
  const subject = await page.evaluate(async () => {
    const resource = await window.store.newResource({
      parent: window.store.getDrive(),
      isA: 'https://atomicdata.dev/classes/Folder',
      propVals: {
        'https://atomicdata.dev/properties/name': 'Vault evidence canary',
      },
    });
    await resource.save();

    return resource.subject;
  });
  await waitForSynced(page);
  await waitForClientDbFlush(page, { required: true });
  const listUrl = page.url();
  portal.mode = 'hold';
  await page.goto(`${FRONTEND_URL}/app/sync`);
  await page.getByTestId('vault-enable').click();
  await expect.poll(() => portal.held.length).toBe(1);
  expect(portal.confirmed.size).toBe(0);
  await saveName(page, subject, 'Vault evidence canary newer');
  portal.held.shift()!();
  await expect(page.getByTestId('vault-backup-now')).toBeEnabled();
  await expect.poll(() => portal.checkpoints.length).toBe(1);
  await page.goto(listUrl);
  const indicator = indicatorFor(page, 'Vault evidence canary newer');
  await expect(indicator).toHaveAttribute('data-vault-sync-state', 'pending');
  await indicator.click();
  const panel = page.getByTestId('resource-sync-panel');
  await expect(
    panel.getByText('Changes waiting for backup', { exact: true }),
  ).toBeVisible();
  const receiptTime = await panel
    .getByText(/^Last confirmed backup:/)
    .textContent();
  await waitForPanel(page);
  await page.screenshot({
    path: test.info().outputPath('resource-vault-newer-edit-pending.png'),
    animations: 'disabled',
    fullPage: true,
  });
  const confirmedBeforeFailure = portal.confirmed.size;
  portal.mode = 'fail';
  await page.goto(`${FRONTEND_URL}/app/sync`);
  await page.getByTestId('vault-backup-now').click();
  await expect(page.getByTestId('vault-backup-now')).toBeEnabled();
  await page.goto(listUrl);
  await expect(indicator).toHaveAttribute('data-vault-sync-state', 'pending');
  await indicator.click();
  await expect(
    panel.getByText('Changes waiting for backup', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText(/^Last confirmed backup:/)).toHaveText(
    receiptTime!,
  );
  expect(portal.confirmed.size).toBe(confirmedBeforeFailure);
});
