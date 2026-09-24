// @vitest-environment jsdom
// @wc-ignore-file
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readInstallationReview,
  type DeclaredWriteTarget,
  type JSONValue,
  type PluginRoutesStatus,
} from '@tomic/react';
import { buildTheme } from '../../styling';
import {
  InstallationReviewDialog,
  type PendingInstallation,
} from './InstallationReviewDialog';
import inbox from '../../../../../testdata/plugin-routes/inbox/manifest.json';

const dialog = vi.hoisted(() => [{}, () => undefined, () => undefined, true]);

vi.mock('@components/Dialog', async original => {
  const Pass = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );

  return {
    ...(await original<typeof import('@components/Dialog')>()),
    Dialog: Object.assign(Pass, {
      Title: Pass,
      Content: Pass,
      Actions: Pass,
    }),
    useDialog: () => dialog,
  };
});
vi.mock('@components/JSONEditor', () => ({ JSONEditor: () => null }));
vi.mock('@components/datatypes/Markdown', () => ({ default: () => null }));
vi.mock('@views/Installation/ConfigReference', () => ({
  ConfigReference: () => null,
}));
vi.mock('@views/ResourceInline', () => ({
  ResourceInline: ({ subject }: { subject: string }) => <span>{subject}</span>,
}));
vi.mock('@tomic/react', async original => ({
  ...(await original<typeof import('@tomic/react')>()),
  useStore: () => ({ getServerUrl: () => 'https://atomic.test' }),
}));

afterEach(cleanup);

// #1754's fixture: `inbox-items` under `config:inbox`.
const TARGETS = inbox.http.writeTargets as DeclaredWriteTarget[];
const INBOX = 'https://atomic.test/inbox';

const node = (level: PluginRoutesStatus['level']): PluginRoutesStatus => ({
  compiled: true,
  level,
  routesOrigin: null,
  listeners: [],
  sidecars: [],
});

const pendingWith = (
  extra: Partial<PendingInstallation> = {},
): PendingInstallation => ({
  review: readInstallationReview({
    runtime: 'atomic-js/1',
    manifest: inbox as unknown as JSONValue,
    id: 'blake3:inbox',
  }),
  release: { url: 'blake3:inbox', id: 'blake3:inbox' },
  ...extra,
});

function renderReview(
  pending: PendingInstallation,
  level: PluginRoutesStatus['level'] = 'read-write',
) {
  const onInstall = vi.fn(async () => undefined);
  render(
    <ThemeProvider theme={buildTheme(false, '#336699')}>
      <InstallationReviewDialog
        pending={pending}
        onClose={() => undefined}
        onInstall={onInstall}
        pluginRoutes={node(level)}
      />
    </ThemeProvider>,
  );

  return onInstall;
}

const approval = () =>
  screen.getByTestId('route-write-approval') as HTMLInputElement;
const installButton = () => screen.getByRole('button', { name: 'Install' });

describe('the route write approval', () => {
  it('asks explicitly, unchecked, and installs without the grant when left so', async () => {
    const onInstall = renderReview(
      pendingWith({ currentConfig: { inbox: INBOX } }),
    );
    const section = screen.getByRole('region', { name: 'Route writes' });

    expect(section.textContent).toContain(
      'Let fixtures/inbox add items to inbox-items when other servers send them',
    );
    expect(
      screen.getByTestId('route-write-target-inbox-items').textContent,
    ).toContain(INBOX);
    expect(approval().checked).toBe(false);
    // Nothing to compare with on a first install.
    expect(screen.queryByTestId('route-write-new')).toBeNull();

    fireEvent.click(installButton());
    await vi.waitFor(() => expect(onInstall).toHaveBeenCalledOnce());
    expect(onInstall).toHaveBeenCalledWith(
      expect.anything(),
      { inbox: INBOX },
      ['storage'],
      undefined,
    );
  });

  it('passes the declared targets once approved', async () => {
    const onInstall = renderReview(
      pendingWith({ currentConfig: { inbox: INBOX } }),
    );

    fireEvent.click(approval());
    expect(approval().checked).toBe(true);
    fireEvent.click(installButton());

    await vi.waitFor(() => expect(onInstall).toHaveBeenCalledOnce());
    expect(onInstall).toHaveBeenCalledWith(
      expect.anything(),
      { inbox: INBOX },
      ['storage'],
      TARGETS,
    );
  });

  it('refuses to install an approval whose target the config does not name', () => {
    renderReview(pendingWith());

    expect(
      screen.getByTestId('route-write-target-inbox-items').textContent,
    ).toContain('which is not set');
    expect(installButton().hasAttribute('disabled')).toBe(false);
    fireEvent.click(approval());
    expect(screen.getByTestId('route-write-unresolved').textContent).toContain(
      'Set inbox in the config below',
    );
    expect(installButton().hasAttribute('disabled')).toBe(true);
  });

  it('is not offered below read-write', () => {
    renderReview(pendingWith(), 'read-only');
    expect(screen.queryByRole('region', { name: 'Route writes' })).toBeNull();
  });

  it('keeps an update approved when the grant already covers its targets', () => {
    renderReview(
      pendingWith({
        currentConfig: { inbox: INBOX },
        approvedRouteWrites: TARGETS,
      }),
    );
    expect(approval().checked).toBe(true);
    expect(screen.queryByTestId('route-write-new')).toBeNull();
  });

  it('asks again, unchecked, when an update widens the targets', () => {
    renderReview(
      pendingWith({
        currentConfig: { inbox: INBOX },
        approvedRouteWrites: [{ ...TARGETS[0], classes: [] }],
      }),
    );
    expect(approval().checked).toBe(false);
    expect(screen.getByTestId('route-write-new').textContent).toBe('New');
  });
});
