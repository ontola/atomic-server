// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as Sentry from '@sentry/react';
import { loroCall, type Store } from '@tomic/react';
import {
  addDiagnosticsToSentryEvents,
  buildFeedbackDiagnostics,
  type FeedbackDiagnosticsInput,
} from './feedbackDiagnostics';

const base: FeedbackDiagnosticsInput = {
  release: 'atomic-data-browser@0.40.0+abc123',
  desktop: false,
  serverUrl: 'http://localhost:9883',
  connected: true,
  capabilities: ['get-many', 'canonical-scheme'],
  outboxSize: 0,
  outboxBlocked: 0,
  outboxFailures: 0,
};

describe('buildFeedbackDiagnostics', () => {
  it('describes a healthy setup', () => {
    expect(buildFeedbackDiagnostics(base)).toEqual({
      appRelease: 'atomic-data-browser@0.40.0+abc123',
      desktop: false,
      server: 'http://localhost:9883',
      connected: true,
      outboxSize: 0,
      outboxBlocked: 0,
      outboxMaxFailures: 0,
      capabilityCount: 2,
      canonicalScheme: true,
      capabilities: 'canonical-scheme,get-many',
    });
  });

  it('reduces the server to scheme, host and port', () => {
    const tags = buildFeedbackDiagnostics({
      ...base,
      serverUrl: 'https://me:secret@node.example.com:8443/drive/x?token=1#y',
    });

    expect(tags.server).toBe('https://node.example.com:8443');
    expect(JSON.stringify(tags)).not.toMatch(/secret|token|drive\/x/);
  });

  it('shows a node too old for the atomic: scheme', () => {
    const tags = buildFeedbackDiagnostics({
      ...base,
      serverUrl: 'http://localhost:11870',
      connected: false,
      capabilities: [],
      outboxSize: 4,
      outboxFailures: 7,
    });

    expect(tags).toMatchObject({
      server: 'http://localhost:11870',
      connected: false,
      canonicalScheme: false,
      capabilityCount: 0,
      outboxSize: 4,
      outboxMaxFailures: 7,
    });
  });

  it('keeps errors short and free of urls and resource ids', () => {
    const tags = buildFeedbackDiagnostics({
      ...base,
      connected: false,
      connectionError:
        'Failed https://localhost:9883/secret/path for did:ad:abc123 and atomic:def',
      storageError: 'x'.repeat(500),
    });

    expect(tags.connectionError).toBe('Failed <url> for <id> and <id>');
    expect((tags.storageError as string).length).toBe(200);
  });

  it('drops a stale connection error while connected, and a bad server url', () => {
    const tags = buildFeedbackDiagnostics({
      ...base,
      serverUrl: 'not a url',
      connectionError: 'old',
    });

    expect(tags).not.toHaveProperty('connectionError');
    expect(tags).not.toHaveProperty('server');
  });
});

describe('diagnostics on every Sentry event', () => {
  const sent: Sentry.Event[] = [];
  const statusOf = (serverConnected: boolean) => () => ({
    serverUrl: 'http://localhost:11870/some/path?q=1',
    serverConnected,
    blockedCount: 0,
  });
  const store = (getSyncStatus: () => unknown) =>
    ({
      getSyncStatus,
      outbox: { pending: () => [{ failures: 3 }] },
      getDefaultWebSocket: () => ({ serverCapabilities: [] }),
    }) as unknown as Store;

  async function report(send: () => unknown): Promise<Sentry.Event> {
    sent.length = 0;
    send();
    await Sentry.flush(1000);

    return sent[0];
  }

  it('tags errors and feedback alike, and lets an explicit tag win', async () => {
    Sentry.init({
      dsn: 'https://public@example.com/1',
      integrations: [],
      transport: () => ({
        send: async envelope => {
          for (const [, item] of envelope[1])
            sent.push(item as unknown as Sentry.Event);

          return {};
        },
        flush: async () => true,
      }),
    });
    addDiagnosticsToSentryEvents(store(statusOf(false)));

    const error = await report(() =>
      Sentry.captureException(new Error('boom'), { tags: { server: 'own' } }),
    );

    expect(error.tags).toMatchObject({
      server: 'own',
      connected: false,
      outboxSize: 1,
      outboxMaxFailures: 3,
    });

    const feedback = await report(() =>
      Sentry.captureFeedback({ message: 'Problem' }),
    );

    expect(feedback.tags).toMatchObject({ server: 'http://localhost:11870' });
  });

  it('adds what the Loro call was doing, and the panic Rust logged', async () => {
    const trap = new WebAssembly.RuntimeError('unreachable');

    try {
      loroCall(
        'import',
        undefined,
        () => {
          throw trap;
        },
        4321,
      );
    } catch {
      // expected
    }

    Sentry.addBreadcrumb({
      category: 'console',
      message:
        'panicked at crates/loro-internal/src/x.rs:1:2:\nno key "https://example.com/secret" here\n\nStack:\nError',
    });

    const event = await report(() => Sentry.captureException(trap));

    expect(event.tags).toMatchObject({
      loroOp: 'import',
      loroBytes: 4321,
      wasmPanicAt: 'crates/loro-internal/src/x.rs:1:2',
      wasmPanic: 'no key "…" here',
    });
    expect(JSON.stringify(event.tags)).not.toContain('secret');
  });

  it('reports a blocked local storage as a warning', async () => {
    const blocked = Object.assign(new Error('blocked'), {
      name: 'StorageBlockedError',
    });

    expect((await report(() => Sentry.captureException(blocked))).level).toBe(
      'warning',
    );
  });

  it('still sends the event when reading the store throws', async () => {
    addDiagnosticsToSentryEvents(
      store(() => {
        throw new Error('store is gone');
      }),
    );

    expect(
      (await report(() => Sentry.captureException(new Error('boom')))).level,
    ).toBe('error');
  });
});
