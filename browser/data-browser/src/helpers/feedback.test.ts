import { describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react';
import { errorFeedbackMessage, submitFeedback } from './feedback';
import type { Store } from '@tomic/react';
vi.mock('@sentry/react', () => ({ isEnabled: vi.fn(), sendFeedback: vi.fn() }));
describe('feedback delivery', () => {
  it('rejects disabled reporting', async () => {
    vi.mocked(Sentry.isEnabled).mockReturnValue(false);
    await expect(submitFeedback('Problem', '')).rejects.toThrow();
    expect(Sentry.sendFeedback).not.toHaveBeenCalled();
  });
  it('preserves failed delivery for retry', async () => {
    vi.mocked(Sentry.isEnabled).mockReturnValue(true);
    vi.mocked(Sentry.sendFeedback).mockRejectedValue(new Error('offline'));
    await expect(submitFeedback('Problem', '')).rejects.toThrow('offline');
  });
  it('sends supplied text without replay or a private resource URL', async () => {
    vi.mocked(Sentry.isEnabled).mockReturnValue(true);
    vi.mocked(Sentry.sendFeedback).mockResolvedValue('receipt');
    await expect(
      submitFeedback(' Problem ', ' person@example.com '),
    ).resolves.toBe('receipt');
    expect(Sentry.sendFeedback).toHaveBeenLastCalledWith(
      {
        message: 'Problem',
        email: 'person@example.com',
        url: '',
        source: 'sidebar',
      },
      { includeReplay: false },
    );
  });
  it('rejects blank feedback', async () => {
    await expect(submitFeedback(' ', '')).rejects.toThrow();
  });
  it('labels an error report separately and keeps the visible error editable', async () => {
    vi.mocked(Sentry.isEnabled).mockReturnValue(true);
    vi.mocked(Sentry.sendFeedback).mockResolvedValue('receipt');
    const message = errorFeedbackMessage(
      new Error('Drive did:ad:example is not enrolled for sync on this node.'),
    );
    expect(message).toContain('is not enrolled for sync on this node');
    expect(message).not.toContain('http');
    await submitFeedback(message, '', 'error');
    expect(Sentry.sendFeedback).toHaveBeenLastCalledWith(
      {
        message,
        email: undefined,
        url: '',
        source: 'error',
      },
      { includeReplay: false },
    );
  });
  it('attaches setup diagnostics as tags, and still sends if reading them fails', async () => {
    vi.mocked(Sentry.isEnabled).mockReturnValue(true);
    vi.mocked(Sentry.sendFeedback).mockResolvedValue('receipt');
    const store = {
      getSyncStatus: () => ({
        serverUrl: 'http://localhost:11870/some/path?q=1',
        serverConnected: false,
        serverConnectionError: 'closed',
        blockedCount: 1,
      }),
      outbox: { pending: () => [{ failures: 2 }, {}] },
      getDefaultWebSocket: () => ({ serverCapabilities: [] }),
    } as unknown as Store;
    await submitFeedback('Problem', '', 'sidebar', store);
    const params = vi.mocked(Sentry.sendFeedback).mock.lastCall![0];
    expect(params.url).toBe('');
    expect(params.tags).toMatchObject({
      server: 'http://localhost:11870',
      connected: false,
      connectionError: 'closed',
      outboxSize: 2,
      blocked: 1,
      failures: 2,
      canonicalScheme: false,
      desktop: false,
    });
    await submitFeedback('Problem', '', 'sidebar', {} as unknown as Store);
    expect(
      vi.mocked(Sentry.sendFeedback).mock.lastCall![0].tags,
    ).toBeUndefined();
  });
});
