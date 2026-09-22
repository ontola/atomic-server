import { test, expect } from './fixtures';
import { before } from './test-utils';
import {
  enableAIForTesting,
  openAISidebar,
  setupAIRouteMocks,
} from './ai-mock';

test('push-to-talk transcribes, answers and speaks using a personal OpenRouter key without SaaS', async ({
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
  await page.route(
    /^https:\/\/openrouter\.ai\/api\/v1\/(audio\/.*|chat\/completions)$/,
    async route => {
      const path = new URL(route.request().url()).pathname;

      if (path === '/api/ai/voice/status') {
        await route.fulfill({
          json: { enabled: true, remaining_micros: 100000 },
        });

        return;
      }

      if (path.startsWith('/api/v1/audio/')) {
        const request = route.request().postDataJSON();
        request.kind = path.endsWith('/transcriptions')
          ? 'transcribe'
          : 'speak';
        actions.push(request.kind);
        expect(route.request().headers().authorization).toBe(
          'Bearer test-e2e-key',
        );
        if (request.kind === 'transcribe')
          expect(request.model).toBe('openai/whisper-large-v3');
        if (request.kind === 'transcribe')
          await route.fulfill({ json: { text: 'Hello from voice' } });
        else
          await route.fulfill({
            contentType: 'audio/mpeg',
            body: Buffer.from([1, 2]),
          });

        return;
      }

      if (path === '/api/v1/chat/completions') {
        expect(route.request().postDataJSON().provider).toEqual({ zdr: true });
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
            usage: {
              prompt_tokens: 5,
              completion_tokens: 10,
              total_tokens: 15,
            },
          },
        });

        return;
      }

      await route.fulfill({ status: 204 });
    },
  );
  await page.addInitScript(() => {
    localStorage.setItem('atomic.ai.openRouterZdr', JSON.stringify(true));
    localStorage.setItem(
      'atomic.ai.transcriptionModel',
      JSON.stringify('openai/whisper-large-v3'),
    );

    const state = { requests: 0, stops: 0, played: 0, level: 0 };
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
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createAnalyser() {
        return {
          fftSize: 512,
          getFloatTimeDomainData(samples: Float32Array) {
            samples.fill(state.level);
          },
          disconnect() {},
        };
      }
      async resume() {}
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
    class Recognition {
      processLocally = false;
      onresult?: (event: { results: { transcript: string }[][] }) => void;
      static async available() {
        return 'available';
      }
      start() {
        this.onresult?.({
          results: [[{ transcript: 'Live words while speaking' }]],
        });
      }
      abort() {}
    }
    Object.assign(window, { SpeechRecognition: Recognition });
    window.MediaRecorder = Recorder as unknown as typeof window.MediaRecorder;
    window.AudioContext = Context as unknown as typeof window.AudioContext;
    window.OfflineAudioContext =
      Offline as unknown as typeof window.OfflineAudioContext;
    window.Audio = Player as unknown as typeof window.Audio;
  });
  await page.route('**/api/ai/voice**', () => {
    throw new Error('BYOK voice must not call SaaS');
  });
  await page.route('https://openrouter.ai/api/v1/endpoints/zdr', route =>
    route.fulfill({
      json: { data: [{ model_id: '~google/gemini-flash-latest' }] },
    }),
  );
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
  const mic = page.getByRole('button', { name: 'Send recording', exact: true });
  await expect(
    page.getByText('Live words while speaking', { exact: true }),
  ).toBeVisible();
  const quiet = await mic.evaluate(
    el => getComputedStyle(el.querySelector('svg')!).transform,
  );
  await page.evaluate(
    () =>
      ((
        window as unknown as {
          __voice: {
            requests: number;
            stops: number;
            played: number;
            level?: number;
          };
        }
      ).__voice.level = 0.12),
  );
  await expect
    .poll(() =>
      mic.evaluate(el => getComputedStyle(el.querySelector('svg')!).transform),
    )
    .not.toBe(quiet);
  await expect
    .poll(() =>
      mic.evaluate(el =>
        Number(
          getComputedStyle(el.querySelector('svg')!).transform.match(
            /matrix\(([^,]+)/,
          )?.[1] ?? 1,
        ),
      ),
    )
    .toBeGreaterThan(1.3);
  await expect
    .poll(() =>
      mic.evaluate(el =>
        Number(getComputedStyle(el).color.match(/rgb\((\d+)/)?.[1]),
      ),
    )
    .toBeGreaterThan(180);
  await page.screenshot({ path: '/tmp/atomic-voice-feedback.png' });
  await mic.click();
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
