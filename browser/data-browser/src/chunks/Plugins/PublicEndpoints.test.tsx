// @vitest-environment jsdom
// @wc-ignore-file
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AtomicError,
  checkHostFeatures,
  ErrorType,
  PROBLEM_MARKER,
  hostFeatureMessage,
  HostFeatureUnavailableError,
  readInstallationReview,
  validateManifest,
  type JSONValue,
  type PluginRoutesStatus,
} from '@tomic/react';
import { buildTheme } from '../../styling';
import { PublicEndpoints } from './PublicEndpoints';
import { InstallationReviewDialog } from './InstallationReviewDialog';
import activitypub from '../../../../../testdata/plugin-manifest/v3-activitypub.json';

// The dialog's chrome needs a real <dialog> and the app's providers; what is
// under test is its content and its Install button.
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
    // Stable, like the real hook's: the dialog's reset effect depends on
    // `show`, so a new function per render would clear a refusal right after
    // it is shown, and the assertions below would race that.
    useDialog: () => dialog,
  };
});
vi.mock('@components/JSONEditor', () => ({ JSONEditor: () => null }));
vi.mock('@components/datatypes/Markdown', () => ({ default: () => null }));
vi.mock('@views/Installation/ConfigReference', () => ({
  ConfigReference: () => null,
}));
vi.mock('@tomic/react', async original => ({
  ...(await original<typeof import('@tomic/react')>()),
  useStore: () => ({ getServerUrl: () => 'https://atomic.test' }),
}));

afterEach(cleanup);

// Shared with server/src/plugins/manifest_http.rs and the lib's tests.
const manifest = validateManifest(activitypub);
const http = manifest.http!;

const node = (level: PluginRoutesStatus['level']): PluginRoutesStatus => ({
  compiled: true,
  level,
  routesOrigin: null,
  listeners: [],
  sidecars: [],
});

const withTheme = (children: React.ReactNode) => (
  <ThemeProvider theme={buildTheme(false, '#336699')}>{children}</ThemeProvider>
);

describe('PublicEndpoints', () => {
  it('lists every public surface in words, and the level it needs', () => {
    render(
      withTheme(
        <PublicEndpoints
          http={http}
          pluginRoutes={node('read-write')}
          serverUrl='https://atomic.test'
        />,
      ),
    );
    const section = screen.getByRole('region', { name: 'Public endpoints' });
    const text = section.textContent!;

    expect(text).toContain(
      'Anyone on the internet can call these endpoints; this plugin decides what they may see.',
    );
    expect(text).toContain('https://atomic.test/_routes/<installation>/');
    expect(text).toContain('becomes the plugin’s public identity');
    expect(screen.getByTestId('gate-level').textContent).toContain(
      '--plugin-routes read-write',
    );

    // Each route: methods, path, who may call, as whom it answers.
    expect(screen.getByText('GET, HEAD /users/{name}')).toBeTruthy();
    expect(text).toContain('Anyone can call it, without signing in.');
    expect(screen.getByText('POST /users/{name}/inbox')).toBeTruthy();
    expect(text).toContain('Other servers sign their requests');
    expect(screen.getByText('PUT, DELETE /files/{*rest}')).toBeTruthy();
    expect(text).toContain('The plugin answers as the caller');
    expect(text).toContain('Can send requests to other servers: deliver');

    expect(screen.getByText('/.well-known/nodeinfo')).toBeTruthy();
    expect(text).toContain('Only this plugin answers this address');
    expect(text).toContain('config:inboxTable');
    expect(text).toContain('actor-key');
    expect(text).toContain('Signs deliveries to other fediverse servers');
    expect(text).toContain('Bearer tokens this plugin issues to apps');
  });

  it('names the address under the routes origin', () => {
    render(
      withTheme(
        <PublicEndpoints
          http={{ ...http, mount: 'installation-origin' }}
          pluginRoutes={{
            ...node('read-write'),
            routesOrigin: 'https://routes.example.net',
          }}
          serverUrl='https://atomic.test'
        />,
      ),
    );

    expect(
      screen.getByText('https://<installation>.routes.example.net/'),
    ).toBeTruthy();
  });
});

describe('InstallationReviewDialog', () => {
  const pending = {
    review: readInstallationReview({
      runtime: 'atomic-js/1',
      manifest: manifest as unknown as JSONValue,
      id: 'blake3:abc',
    }),
    release: { url: 'blake3:abc', id: 'blake3:abc' },
    title: 'ActivityPub',
  };
  const installButton = () => screen.getByRole('button', { name: 'Install' });

  it('shows the endpoints and refuses up front when the level is too low', () => {
    const onInstall = vi.fn();
    render(
      withTheme(
        <InstallationReviewDialog
          pending={pending}
          onClose={() => undefined}
          onInstall={onInstall}
          pluginRoutes={node('read-only')}
        />,
      ),
    );
    const refusal = checkHostFeatures(http, node('read-only'))!;

    expect(
      screen.getByRole('region', { name: 'Public endpoints' }),
    ).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      hostFeatureMessage(refusal).replaceAll('`', ''),
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'start AtomicServer with --plugin-routes read-write',
    );
    expect(installButton().hasAttribute('disabled')).toBe(true);
  });

  it('shows the server’s 409 refusal instead of a generic error', async () => {
    const problem = checkHostFeatures(http, node('off'))!;
    const onInstall = vi.fn(async () => {
      throw new HostFeatureUnavailableError(problem);
    });
    render(
      withTheme(
        <InstallationReviewDialog
          pending={pending}
          onClose={() => undefined}
          onInstall={onInstall}
          // The review believed the gates were open; the server disagreed.
          pluginRoutes={node('read-write')}
        />,
      ),
    );

    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(installButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      hostFeatureMessage(problem).replaceAll('`', ''),
    );
    expect(onInstall).toHaveBeenCalledOnce();
    expect(installButton().hasAttribute('disabled')).toBe(true);
  });

  it('shows a refused Installation commit inline too', async () => {
    const problem = checkHostFeatures(http, node('read-only'))!;
    // What the WS `ERROR` frame (or the `/commit` Error resource) carries:
    // the sentence, then the typed problem.
    const message =
      hostFeatureMessage(problem) +
      PROBLEM_MARKER +
      JSON.stringify({ ...problem, detail: hostFeatureMessage(problem) });
    const onInstall = vi.fn(async () => {
      throw new AtomicError(message, ErrorType.Server);
    });
    render(
      withTheme(
        <InstallationReviewDialog
          pending={pending}
          onClose={() => undefined}
          onInstall={onInstall}
          pluginRoutes={node('read-write')}
        />,
      ),
    );

    fireEvent.click(installButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      hostFeatureMessage(problem).replaceAll('`', ''),
    );
    expect(installButton().hasAttribute('disabled')).toBe(true);
  });
});
