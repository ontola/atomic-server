import { test, expect } from './fixtures';
import { before } from './test-utils';
import {
  enableAIForTesting,
  openAISidebar,
  setupAIRouteMocks,
} from './ai-mock';

test('push-to-talk transcribes, answers and speaks using credits without a personal API key', async ({
  page,
  browserDiagnostics,
}) => {
  browserDiagnostics.expect(
    'error',
    /Cannot update a component.*AppSettingsContextProvider DrivePage DrivePage/,
    'Existing DrivePage settings warning.',
    1,
    undefined,
    { optional: true },
  );
  await setupAIRouteMocks(page);
  await enableAIForTesting(page);
  const actions: string[] = [];
  await page.route('https://voice.atomic.test/api/**', async route => {
    const path = new URL(route.request().url()).pathname;

    if (path === '/api/ai/voice/status') {
      await route.fulfill({
        json: { enabled: true, remaining_micros: 100000 },
      });

      return;
    }

    if (path === '/api/ai/voice') {
      const request = route.request().postDataJSON();
      actions.push(request.kind);
      if (request.kind === 'transcribe')
        await route.fulfill({ json: { text: 'Hello from voice' } });
      else
        await route.fulfill({
          contentType: 'audio/mpeg',
          body: Buffer.from([1, 2]),
        });

      return;
    }

    if (path === '/api/ai/chat/completions') {
      actions.push('chat');
      await route.fulfill({
        json: {
          id: 'answer',
          object: 'chat.completion',
          created: 1,
          model: 'google/gemini-2.5-flash',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Hello! Your voice message reached Atomic.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        },
      });

      return;
    }

    await route.fulfill({ status: 204 });
  });
  await page.addInitScript(() => {
    // This test mocks audio; do not call the browser's native speech service.
    Object.defineProperty(window, 'SpeechRecognition', {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(window, 'webkitSpeechRecognition', {
      value: undefined,
      configurable: true,
    });
    localStorage.removeItem('atomic.ai.openrouter-api-key');
    Object.assign(window, {
      __ATOMIC_MANAGED__: { portalUrl: 'https://voice.atomic.test' },
    });
    const state = { requests: 0, stops: 0, played: 0 };
    (
      window as unknown as {
        __voice: {
          requests: number;
          stops: number;
          played: number;
          level?: number;
        };
      }
    ).__voice = state;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        state.requests++;

        return { getTracks: () => [{ stop: () => state.stops++ }] };
      },
    });
    class Recorder {
      state = 'inactive';
      mimeType = 'audio/webm';
      ondataavailable?: (event: { data: Blob }) => void;
      onstop?: () => void;
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['recording']) });
        this.onstop?.();
      }
    }
    class Context {
      async decodeAudioData() {
        return { duration: 1 };
      }
      async close() {}
    }
    class Offline {
      destination = {};
      createBufferSource() {
        return { buffer: null, connect() {}, start() {} };
      }
      async startRendering() {
        return { getChannelData: () => new Float32Array(16000) };
      }
    }
    class Player {
      onended?: () => void;
      onerror?: () => void;
      async play() {
        state.played++;
        queueMicrotask(() => this.onended?.());
      }
      pause() {}
    }
    window.MediaRecorder = Recorder as unknown as typeof window.MediaRecorder;
    window.AudioContext = Context as unknown as typeof window.AudioContext;
    window.OfflineAudioContext =
      Offline as unknown as typeof window.OfflineAudioContext;
    window.Audio = Player as unknown as typeof window.Audio;
  });
  await before({ page });
  await openAISidebar(page);
  await expect(
    page.getByRole('button', { name: 'Start voice message', exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __voice: {
              requests: number;
              stops: number;
              played: number;
              level?: number;
            };
          }
        ).__voice.requests,
    ),
  ).toBe(0);
  await page
    .getByRole('button', { name: 'Start voice message', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Send recording', exact: true })
    .press('Escape');
  expect(actions).toEqual([]);
  await page
    .getByRole('button', { name: 'Start voice message', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Send recording', exact: true })
    .click();
  await expect(
    page.getByText('Hello from voice', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Hello! Your voice message reached Atomic.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start voice message', exact: true }),
  ).toBeEnabled();
  expect(actions).toEqual(['transcribe', 'chat', 'speak']);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __voice: {
              requests: number;
              stops: number;
              played: number;
              level?: number;
            };
          }
        ).__voice.stops,
    ),
  ).toBeGreaterThan(0);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __voice: {
              requests: number;
              stops: number;
              played: number;
              level?: number;
            };
          }
        ).__voice.played,
    ),
  ).toBe(1);
  await page.screenshot({ path: '/tmp/atomic-push-to-talk.png' });
});
