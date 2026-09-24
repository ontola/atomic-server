import { describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react';
import { errorFeedbackMessage, submitFeedback } from './feedback';
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
});

it('includes diagnostics only when explicitly supplied', async () => {
  vi.mocked(Sentry.isEnabled).mockReturnValue(true);
  vi.mocked(Sentry.sendFeedback).mockResolvedValue('receipt');
  await submitFeedback('Problem', '', 'sidebar', '{"events":[]}');
  expect(Sentry.sendFeedback).toHaveBeenLastCalledWith(
    expect.objectContaining({
      message: 'Problem',
    }),
    {
      includeReplay: false,
      attachments: [
        {
          filename: 'diagnostics.json',
          contentType: 'application/json',
          data: '{"events":[]}',
        },
      ],
    },
  );
  await submitFeedback('Problem', '');
  expect(Sentry.sendFeedback).toHaveBeenLastCalledWith(
    expect.objectContaining({ message: 'Problem' }),
    { includeReplay: false },
  );
});

it('keeps large diagnostics intact outside the message', async () => {
  vi.mocked(Sentry.isEnabled).mockReturnValue(true);
  const diagnostics = JSON.stringify({
    events: Array(500).fill({ code: 'save-persisted' }),
  });
  await submitFeedback('Problem', '', 'sidebar', diagnostics);
  const [feedback, hint] = vi.mocked(Sentry.sendFeedback).mock.calls.at(-1)!;
  expect(feedback.message).toBe('Problem');
  expect(hint?.attachments?.[0]?.data).toBe(diagnostics);
});

it('accepts the message boundary and rejects oversized text before sending', async () => {
  vi.mocked(Sentry.isEnabled).mockReturnValue(true);
  await submitFeedback('a'.repeat(4096), '');
  vi.mocked(Sentry.sendFeedback).mockClear();
  await expect(submitFeedback('a'.repeat(4097), '')).rejects.toThrow('4096');
  expect(Sentry.sendFeedback).not.toHaveBeenCalled();
});
