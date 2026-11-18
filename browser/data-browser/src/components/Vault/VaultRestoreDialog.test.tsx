// @vitest-environment jsdom
// @wc-ignore-file
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { afterEach, expect, it, vi } from 'vitest';
import { DialogGlobalContextProvider } from '../Dialog/DialogGlobalContextProvider';
import { RootWelcomeLayoutProvider } from '../../context/RootWelcomeLayoutContext';
import { VaultPanel } from './VaultPanel';
import { buildTheme } from '../../styling';
import type { UseVaultBackup } from '../../helpers/managed/useVaultBackup';
import type { VaultSnapshotUsage } from '../../helpers/managed/vault';

const usageMock = vi.hoisted(() => vi.fn());

vi.mock('../../helpers/managed/vault', async importOriginal => ({
  ...(await importOriginal<typeof import('../../helpers/managed/vault')>()),
  getVaultUsage: usageMock,
}));

const theme = buildTheme(false, '#1b50d8');
const snap = (id: string, created_at: number): VaultSnapshotUsage => ({
  id,
  created_at,
  bytes: 10,
  is_latest: false,
});
// Newest first, as the control plane lists them.
const FOUR = [
  snap('s4', 1_760_000_000),
  snap('s3', 1_750_000_000),
  snap('s2', 1_740_000_000),
  snap('s1', 1_730_000_000),
];

function vault(): UseVaultBackup {
  return {
    status: {
      state: 'on',
      enrollment: {
        status: 'active',
        used_bytes: 1,
        quota_bytes: 100,
        drive_pseudonym: 'p',
        last_backup_at: null,
      },
      details: { confirmed_objects: 4 },
    },
    busy: false,
    error: null,
    restore: vi.fn(async () => ({})),
    restoreProgress: null,
    refresh: vi.fn(),
  } as unknown as UseVaultBackup;
}

function show(v = vault()) {
  render(
    <ThemeProvider theme={theme}>
      <RootWelcomeLayoutProvider>
        <DialogGlobalContextProvider>
          <VaultPanel vault={v} />
        </DialogGlobalContextProvider>
      </RootWelcomeLayoutProvider>
    </ThemeProvider>,
  );

  return v;
}

/**
 * Wait for the restore dialog, then read its radios.
 *
 * Opening it is a resolved promise and a few effects, so it is the waiting that
 * must not depend on speed: `findAllByRole` over the whole page recomputes the
 * accessibility tree on every poll, a few hundred ms each in jsdom, and on a
 * loaded CI runner that alone ran past its 1 s. Waiting on the open <dialog>
 * is a plain selector, and the radios are then read from that small subtree.
 */
async function openRadios() {
  await waitFor(() => expect(usageMock).toHaveBeenCalled());
  await waitFor(() =>
    expect(document.querySelector('dialog[open]')).toBeTruthy(),
  );

  return dialog().queryAllByRole('radio') as HTMLInputElement[];
}

const dialog = () => {
  const all = document.querySelectorAll('dialog');

  return within(all[all.length - 1] as HTMLElement);
};

// jsdom has no modal <dialog>; opening one is all these tests need from it.
HTMLDialogElement.prototype.showModal = function showModal() {
  this.setAttribute('open', '');
};

HTMLDialogElement.prototype.close = function close() {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};

afterEach(() => {
  cleanup();
  usageMock.mockReset();
});

it('offers a choice of snapshots, newest preselected, and warns before restoring', async () => {
  usageMock.mockResolvedValue({ snapshots: FOUR });
  const v = show();

  fireEvent.click(screen.getByTestId('vault-restore'));

  const radios = await openRadios();
  expect(radios).toHaveLength(4);
  expect(radios.map(r => r.checked)).toEqual([true, false, false, false]);
  expect(v.restore).not.toHaveBeenCalled();

  const warning = screen.getByTestId('vault-restore-warning').textContent;
  expect(warning).toContain('Changes made after that moment will be lost');
  expect(warning).toContain(
    new Date(1_760_000_000 * 1000).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
  );

  // Choosing an older one updates the moment named in the warning.
  fireEvent.click(radios[2]);
  expect(screen.getByTestId('vault-restore-warning').textContent).toContain(
    new Date(1_740_000_000 * 1000).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
  );

  fireEvent.click(dialog().getByText('Restore'));
  await waitFor(() => expect(v.restore).toHaveBeenCalledWith('s2'));
});

it('restores nothing when the dialog is cancelled', async () => {
  usageMock.mockResolvedValue({ snapshots: FOUR });
  const v = show();

  fireEvent.click(screen.getByTestId('vault-restore'));
  expect(await openRadios()).toHaveLength(4);
  fireEvent.click(dialog().getByText('Cancel'));

  await waitFor(() =>
    expect(document.querySelector('input[type=radio]')).toBeNull(),
  );
  expect(v.restore).not.toHaveBeenCalled();
});

it('with one snapshot only asks to confirm', async () => {
  usageMock.mockResolvedValue({ snapshots: [FOUR[0]] });
  const v = show();

  fireEvent.click(screen.getByTestId('vault-restore'));
  expect(await openRadios()).toHaveLength(0);
  expect(v.restore).not.toHaveBeenCalled();

  fireEvent.click(dialog().getByText('Restore'));
  await waitFor(() => expect(v.restore).toHaveBeenCalledWith('s4'));
});

it('keeps the plain restore when the control plane lists no snapshots', async () => {
  usageMock.mockResolvedValue({});
  const v = show();

  fireEvent.click(screen.getByTestId('vault-restore'));
  await waitFor(() => expect(v.restore).toHaveBeenCalledWith(undefined));
});

it('after a snapshot restore, says which files could not be brought back', async () => {
  usageMock.mockResolvedValue({ snapshots: FOUR });
  const v = vault();
  v.restore = vi.fn(async () => ({
    packsRead: 1,
    resourcesRestored: 2,
    tombstonesApplied: 0,
    objectsSkipped: 0,
    objectsUnreadable: 0,
    reverted: 2,
    blobs: { restored: 1, present: 0, missing: 1, unreadable: 0 },
  }));
  show(v);

  fireEvent.click(screen.getByTestId('vault-restore'));
  const radios = await openRadios();
  fireEvent.click(radios[1]);
  fireEvent.click(dialog().getByText('Restore'));

  // The snapshot path reports files like every other restore: a restore that
  // left a file behind must not read as a clean one.
  await waitFor(() => expect(v.restore).toHaveBeenCalledWith('s3'));
  await waitFor(() =>
    expect(screen.getByTestId('vault-notice').textContent).toContain(
      '1 file is not in the backup',
    ),
  );
});
