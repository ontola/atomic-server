// @wc-ignore-file
/**
 * The sandbox half of `run_code`: runs the model's script and turns each
 * `tools.<name>(args)` into a message to the host. Free of Worker APIs so tests
 * can run it in-process; `codeMode.worker.ts` is the shell around it.
 */

export type ToHost =
  | { type: 'call'; id: number; name: string; args: unknown }
  | { type: 'done'; json: string; logs: string[] }
  | { type: 'error'; message: string; logs: string[] };

export type ToWorker =
  | { type: 'run'; source: string; toolNames: string[] }
  | { type: 'result'; id: number; value?: unknown; error?: string };

export const MAX_LOG_LINES = 50;
export const MAX_LOG_CHARS = 1000;

const show = (v: unknown): string => {
  if (typeof v === 'string') return v;

  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

export function createSandbox(post: (m: ToHost) => void) {
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  let nextId = 0;

  return async (msg: ToWorker): Promise<void> => {
    if (msg.type === 'result') {
      const p = pending.get(msg.id);

      pending.delete(msg.id);

      if (msg.error !== undefined) p?.reject(new Error(msg.error));
      else p?.resolve(msg.value);

      return;
    }

    const logs: string[] = [];

    const log = (...args: unknown[]) => {
      if (logs.length < MAX_LOG_LINES)
        logs.push(args.map(show).join(' ').slice(0, MAX_LOG_CHARS));
    };

    const tools = Object.fromEntries(
      msg.toolNames.map(name => [
        name,
        (args: unknown) =>
          new Promise((resolve, reject) => {
            const id = nextId++;

            pending.set(id, { resolve, reject });
            post({ type: 'call', id, name, args });
          }),
      ]),
    );

    try {
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      const value = await new AsyncFunction('tools', 'console', msg.source)(
        tools,
        { log, info: log, warn: log, error: log },
      );

      post({ type: 'done', json: JSON.stringify(value) ?? 'null', logs });
    } catch (e) {
      post({
        type: 'error',
        message: e instanceof Error ? e.message : String(e),
        logs,
      });
    }
  };
}
