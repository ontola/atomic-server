// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, expect, it, vi } from 'vitest';
import { streamText, generateText } from 'ai';
import { createHostedModel, enableHostedAI, getHostedAIStatus } from './ai';
import { managedFetch } from './api';
import { getManagedAccount } from './session';

vi.mock('./api', () => ({
  hasManagedApi: () => true,
  getManagedDeviceToken: () => null,
  managedFetch: vi.fn(),
}));
vi.mock('./session', () => ({ getManagedAccount: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it('does not ask for a balance without an authenticated account', async () => {
  vi.mocked(getManagedAccount).mockResolvedValue(null);
  expect(await getHostedAIStatus()).toBeUndefined();
  expect(managedFetch).not.toHaveBeenCalled();
});

it('sends explicit consent and reports a rejected request', async () => {
  vi.mocked(managedFetch).mockResolvedValue(
    new Response('{}', { status: 403 }),
  );
  await expect(enableHostedAI()).rejects.toThrow('Could not enable');
  expect(managedFetch).toHaveBeenCalledWith(
    '/ai/consent',
    expect.objectContaining({ body: '{"accepted":true}' }),
  );
});

it('uses the authenticated control plane without sending the placeholder provider key', async () => {
  vi.mocked(managedFetch).mockResolvedValue(
    new Response(JSON.stringify({ error: 'Account credits exhausted' }), {
      status: 402,
    }),
  );
  const result = streamText({
    model: createHostedModel('google/gemini-2.5-flash'),
    prompt: 'Hello',
    maxRetries: 0,
    onError: () => {},
  });
  await expect(result.text).rejects.toThrow();
  expect(managedFetch).toHaveBeenCalledTimes(1);
  const [path, init] = vi.mocked(managedFetch).mock.calls[0];
  expect(path).toBe('/ai/chat/completions');
  expect(new Headers(init?.headers).has('Authorization')).toBe(false);
});

it('supports non-streaming title generation using the same account endpoint', async () => {
  vi.mocked(managedFetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        id: 'gen-title',
        object: 'chat.completion',
        created: 1,
        model: 'google/gemini-2.5-flash',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'My notes' },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          cost: 0.00001,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    ),
  );
  const result = await generateText({
    model: createHostedModel('google/gemini-2.5-flash'),
    prompt: 'Title',
    maxRetries: 0,
  });
  expect(result.text).toBe('My notes');
  expect(managedFetch).toHaveBeenCalledWith(
    '/ai/chat/completions',
    expect.any(Object),
  );
});
