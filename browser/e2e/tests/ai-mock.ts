import { Page } from '@playwright/test';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const TEST_MODEL = '~google/gemini-flash-latest';

const IS_A = 'https://atomicdata.dev/properties/isA';
const PARENT = 'https://atomicdata.dev/properties/parent';
const NAME = 'https://atomicdata.dev/properties/name';
const DESCRIPTION = 'https://atomicdata.dev/properties/description';
const BOOKMARK_CLASS = 'https://atomicdata.dev/class/Bookmark';
const BOOKMARK_URL_PROP = 'https://atomicdata.dev/property/url';

/**
 * Builds a non-streaming OpenAI-format chat completion JSON response body.
 * Used for generateText calls (e.g. title generation, follow-up questions),
 * which use doGenerate (not doStream) and expect a plain JSON response.
 * The content is a JSON string that satisfies both structured-output schemas
 * used in the app (title: string, prompt: string).
 */
function buildJSONCompletionBody(): string {
  return JSON.stringify({
    id: 'chatcmpl-test-gen',
    object: 'chat.completion',
    created: 1234567890,
    model: TEST_MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({
            title: 'Test Chat',
            prompt: 'What else would you like to know?',
          }),
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

function buildSSEBody(text: string): string {
  const id = 'chatcmpl-test';
  const chunk = (delta: object) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      model: TEST_MODEL,
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`;

  return [
    chunk({ role: 'assistant', content: '' }),
    chunk({ content: text }),
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      model: TEST_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

/**
 * Builds an SSE body that streams a single tool call, then finishes.
 * The AI SDK collects the incremental argument chunks into a complete call.
 */
function buildToolCallSSE(
  toolName: string,
  args: object,
  toolCallId = `call_${toolName}`,
): string {
  const id = 'chatcmpl-tool-test';
  const chunk = (data: object) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: 1234567890,
      model: TEST_MODEL,
      ...data,
    })}\n\n`;

  return [
    chunk({
      choices: [
        { index: 0, delta: { role: 'assistant', content: null }, finish_reason: null },
      ],
    }),
    chunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: toolCallId, type: 'function', function: { name: toolName, arguments: '' } },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    chunk({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
          finish_reason: null,
        },
      ],
    }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ].join('');
}

export type ToolCallMockState = {
  driveUrl: string;
  createdSubject: string;
};

/**
 * Registers route mocks for a tool-call scenario: the AI creates a resource,
 * edits it, reads it back, then returns a final text response.
 *
 * Returns a mutable state object. Set `state.driveUrl` after newDrive() and
 * before sending the first chat message so the create_resource call uses the
 * correct parent URL.
 */
export async function setupAIToolCallMocks(page: Page): Promise<ToolCallMockState> {
  const state: ToolCallMockState = { driveUrl: '', createdSubject: '' };
  let streamingCallCount = 0;

  await page.route(`${OPENROUTER_BASE}/models**`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            id: TEST_MODEL,
            name: 'Gemini Flash',
            description: '',
            architecture: {
              input_modalities: ['text', 'image'],
              output_modalities: ['text'],
            },
            pricing: { prompt: 0, completion: 0, web_search: 0 },
            supported_parameters: ['temperature'],
          },
        ],
      }),
    }),
  );

  await page.route(`${OPENROUTER_BASE}/chat/completions**`, async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const isStreaming = body?.stream === true;

    if (!isStreaming) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: buildJSONCompletionBody(),
      });

      return;
    }

    const callIndex = streamingCallCount++;
    const messages = (body.messages as Array<{ role: string; content: string }>) ?? [];

    if (callIndex === 0) {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: buildToolCallSSE(
          'create_resource',
          {
            jsonAD: JSON.stringify({
              [IS_A]: [BOOKMARK_CLASS],
              [PARENT]: state.driveUrl,
              [NAME]: 'AI Test Bookmark',
              [BOOKMARK_URL_PROP]: 'https://example.com',
            }),
          },
          'call_create_1',
        ),
      });
    } else if (callIndex === 1) {
      // Extract the subject from the create_resource tool result
      const toolMessages = messages.filter(m => m.role === 'tool');
      const lastToolContent = toolMessages[toolMessages.length - 1]?.content ?? '';
      const match = /subject (\S+)$/.exec(lastToolContent);

      if (match) {
        state.createdSubject = match[1];
      }

      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: buildToolCallSSE(
          'edit_atomic_resource',
          {
            subject: state.createdSubject,
            property: DESCRIPTION,
            value: 'Updated by AI',
          },
          'call_edit_1',
        ),
      });
    } else if (callIndex === 2) {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: buildToolCallSSE(
          'get_atomic_resource',
          { subjects: [state.createdSubject], includeCommitData: false },
          'call_get_1',
        ),
      });
    } else {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: buildSSEBody('Done! I created, edited, and read back the resource.'),
      });
    }
  });

  await page.route(`${OPENROUTER_BASE}/credits**`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { total_credits: 100, usage: 0 } }),
    }),
  );

  return state;
}

/** Register page.route() intercepts for all OpenRouter endpoints. Must be called before page.goto(). */
export async function setupAIRouteMocks(
  page: Page,
  options: { chatResponse?: string } = {},
) {
  const response = options.chatResponse ?? 'This is a mock AI response.';

  await page.route(`${OPENROUTER_BASE}/models**`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            id: TEST_MODEL,
            name: 'Gemini Flash',
            description: '',
            architecture: {
              input_modalities: ['text', 'image'],
              output_modalities: ['text'],
            },
            pricing: { prompt: 0, completion: 0, web_search: 0 },
            supported_parameters: ['temperature'],
          },
        ],
      }),
    }),
  );

  await page.route(`${OPENROUTER_BASE}/chat/completions**`, async route => {
    // streamText sends stream:true (doStream); generateText omits it (doGenerate).
    // The two require different response formats: SSE vs plain JSON.
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const isStreaming = body?.stream === true;

    if (isStreaming) {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: buildSSEBody(response),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: buildJSONCompletionBody(),
      });
    }
  });

  await page.route(`${OPENROUTER_BASE}/credits**`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { total_credits: 100, usage: 0 } }),
    }),
  );
}

/**
 * Register an addInitScript that pre-populates localStorage with AI settings.
 * Must be called before page.goto().
 */
export async function enableAIForTesting(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('atomic.ai.enabled', JSON.stringify(true));
    localStorage.setItem(
      'atomic.ai.openrouter-api-key',
      JSON.stringify('test-e2e-key'),
    );
    localStorage.setItem(
      'atomic.ai.enabledProviders',
      JSON.stringify(['openrouter']),
    );
    localStorage.setItem('atomic.aiSidebar.open', JSON.stringify(true));
    localStorage.setItem(
      'atomic.sidebar-panels',
      JSON.stringify(['aichats']),
    );
  });
}
