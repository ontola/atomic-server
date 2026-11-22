// @wc-ignore-file
import { asSchema, tool, type ToolSet } from 'ai';
import { z } from 'zod';

export const RUN_CODE = 'run_code';
const TIMEOUT_MS = 30_000;
const MAX_TOOL_CALLS = 50;
const MAX_RESULT_CHARS = 100_000;

export type ToHost =
  | { type: 'call'; id: number; name: string; args: unknown }
  | { type: 'done'; json: string; logs: string[] }
  | { type: 'error'; message: string; logs: string[] };

export type ToFrame =
  | { type: 'run'; source: string; toolNames: string[] }
  | { type: 'result'; id: number; value?: unknown; error?: string };

/** The part of a `Worker` that `runCode` uses (tests pass a fake). */
export interface CodeFrame {
  onmessage: ((e: { data: ToHost }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
  postMessage(m: ToFrame): void;
  terminate(): void;
}

export type CodeResult =
  | { result: unknown; logs?: string[] }
  | { error: string; logs?: string[] };

/** No `allow-same-origin`: the frame cannot reach the app's storage or DOM. */
export const FRAME_SANDBOX = 'allow-scripts';

/**
 * A hidden sandboxed iframe, behind the `Worker` surface `runCode` uses. It
 * loads `public/code-frame.html` by URL: a `srcdoc` frame would inherit the
 * app's CSP and block the frame's own script.
 */
const defaultFrame = (): CodeFrame => {
  const iframe = document.createElement('iframe');
  const channel = new MessageChannel();
  let ready = false;
  const queue: ToFrame[] = [];

  const worker: CodeFrame = {
    onmessage: null,
    onerror: null,
    postMessage: m => {
      if (ready) channel.port1.postMessage(m);
      else queue.push(m);
    },
    terminate: () => {
      window.removeEventListener('message', listener);
      channel.port1.close();
      iframe.remove();
    },
  };

  // The frame's own document loads once. A second load means the script
  // navigated it (CSP cannot forbid that); the new page must get nothing more.
  let loads = 0;

  iframe.addEventListener('load', () => {
    if (++loads > 1)
      worker.onerror?.({ message: 'The script navigated its frame' });
  });

  // The frame's first message (`ready`) is the only one taken from the window:
  // it is answered with a private port, and everything after travels on that.
  // A page the script navigates to cannot get the port, so it is never heard.
  const listener = (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow || e.data?.type !== 'ready') return;

    window.removeEventListener('message', listener);
    channel.port1.onmessage = m => worker.onmessage?.({ data: m.data });
    ready = true;
    iframe.contentWindow?.postMessage({ type: 'port' }, '*', [channel.port2]);
    queue.splice(0).forEach(worker.postMessage);
  };

  window.addEventListener('message', listener);
  iframe.style.display = 'none';
  iframe.setAttribute('sandbox', FRAME_SANDBOX);
  iframe.src = `${window.location.origin}/code-frame.html`;
  document.body.appendChild(iframe);

  return worker;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function callTool(
  tools: ToolSet,
  name: string,
  args: unknown,
  id: number,
) {
  const { execute, inputSchema } = tools[name] ?? {};

  if (!execute) throw new Error(`Unknown tool: ${name}`);

  // The SDK validates a model's tool input before `execute`; the script's
  // arguments get the same check (and the schema's defaults and transforms).
  const checked = await asSchema(inputSchema).validate?.(args);

  if (checked && !checked.success) throw checked.error;

  let out = await execute((checked ? checked.value : args) as never, {
    toolCallId: `${RUN_CODE}-${id}`,
    messages: [],
  });

  if (out && typeof out === 'object' && Symbol.asyncIterator in out) {
    for await (const v of out as AsyncIterable<unknown>) out = v;
  }

  return JSON.parse(JSON.stringify(out ?? null));
}

/** Runs [source] in a fresh frame, answering its tool calls with [tools]. Never throws. */
export function runCode(
  source: string,
  tools: ToolSet,
  createFrame: () => CodeFrame = defaultFrame,
  timeoutMs = TIMEOUT_MS,
): Promise<CodeResult> {
  return new Promise(resolve => {
    let worker: CodeFrame;
    let calls = 0;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (r: CodeResult) => {
      clearTimeout(timer);
      worker?.terminate();
      resolve(r);
    };

    try {
      worker = createFrame();
    } catch (e) {
      return resolve({ error: message(e) });
    }

    timer = setTimeout(
      () => finish({ error: `Timed out after ${timeoutMs / 1000}s` }),
      timeoutMs,
    );

    worker.onerror = e => finish({ error: e.message ?? 'The script crashed' });

    worker.onmessage = async ({ data }) => {
      if (data.type === 'call') {
        const reply = (r: { value?: unknown; error?: string }) =>
          worker.postMessage({ type: 'result', id: data.id, ...r });

        if (++calls > MAX_TOOL_CALLS)
          return reply({
            error: `At most ${MAX_TOOL_CALLS} tool calls per run_code`,
          });

        try {
          reply({
            value: await callTool(tools, data.name, data.args, data.id),
          });
        } catch (e) {
          reply({ error: message(e) });
        }
      } else {
        const logs = data.logs.length ? { logs: data.logs } : {};

        if (data.type === 'error') finish({ error: data.message, ...logs });
        else if (data.json.length > MAX_RESULT_CHARS)
          finish({
            error: `Result is ${data.json.length} characters; the limit is ${MAX_RESULT_CHARS}. Return less (filter or summarise).`,
            ...logs,
          });
        else finish({ result: JSON.parse(data.json), ...logs });
      }
    };

    worker.postMessage({ type: 'run', source, toolNames: Object.keys(tools) });
  });
}

/**
 * Adds `run_code`: the model writes a script that calls the other tools, so
 * dependent steps and large results stay out of the conversation. Each tool
 * keeps its own authority and review flow, because the script calls the very
 * same `execute`.
 */
export function withCodeMode(tools: ToolSet): ToolSet {
  const callable = Object.fromEntries(
    Object.entries(tools).filter(([n, t]) => n !== RUN_CODE && t.execute),
  );
  const names = Object.keys(callable);

  if (names.length < 2) return tools;

  return {
    ...tools,
    [RUN_CODE]: tool({
      description: `Run a short async JavaScript function body that calls the other tools and post-processes their results, in one step. Inside it, \`tools.<name>(args)\` returns a Promise of that tool's normal result (same arguments as the tool itself); an error thrown by a tool rejects the promise. Use Promise.all for independent calls. \`return\` a JSON-serialisable value: that is the result you get back; console.log output is returned as \`logs\`. There is no network, DOM or store access, calls are capped at ${MAX_TOOL_CALLS}, the result at ${MAX_RESULT_CHARS / 1000} KB, and the run at ${TIMEOUT_MS / 1000}s. Available tools: ${names.join(', ')}.`,
      inputSchema: z.object({
        code: z
          .string()
          .describe('Body of an async function; use `tools` and `return`.'),
      }),
      execute: ({ code }) => runCode(code, callable),
    }),
  };
}
