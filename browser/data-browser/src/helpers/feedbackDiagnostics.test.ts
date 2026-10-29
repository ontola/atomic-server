import { describe, expect, it } from 'vitest';
import {
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
      blocked: 0,
      failures: 0,
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
      failures: 7,
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
