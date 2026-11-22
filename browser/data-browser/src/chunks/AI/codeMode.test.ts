// @wc-ignore-file
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  FRAME_SANDBOX,
  runCode,
  withCodeMode,
  type CodeFrame,
  type ToHost,
} from './codeMode';

const html = readFileSync(
  new URL('../../../public/code-frame.html', import.meta.url),
  'utf8',
);
const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)![1];
/** The shipped sandbox logic: the script up to its wiring. */
const createSandbox = new Function(
  `${script.slice(0, script.indexOf('const handle ='))}; return createSandbox;`,
)() as (post: (m: ToHost) => void) => (m: unknown) => Promise<void>;

/** Evaluates the script in-process with the same sandbox logic as the worker. */
class FakeFrame implements CodeFrame {
  onmessage: CodeFrame['onmessage'] = null;
  onerror: CodeFrame['onerror'] = null;
  terminated = false;
  private handle = createSandbox((m: ToHost) =>
    queueMicrotask(() => this.onmessage?.({ data: m })),
  );

  postMessage(m: Parameters<CodeFrame['postMessage']>[0]) {
    void this.handle(m);
  }

  terminate() {
    this.terminated = true;
  }
}

const make = () => new FakeFrame();
const t = (fn: (a: never) => unknown) =>
  tool({ description: 'x', inputSchema: z.any(), execute: fn as never });

describe('runCode', () => {
  it('chains a call, JS and a second call', async () => {
    const tools: ToolSet = {
      list: t(() => ({ ids: [1, 2, 3] })),
      get: t((a: { ids: number[] }) => a.ids.map(i => i * 10)),
    };
    const out = await runCode(
      `const r = await tools.list({}); return await tools.get({ids: r.ids.filter(i => i > 1)});`,
      tools,
      make,
    );

    expect(out).toEqual({ result: [20, 30] });
  });

  it('validates arguments against the tool schema, with its defaults', async () => {
    const strict = tool({
      description: 'x',
      inputSchema: z.object({ n: z.number(), limit: z.number().default(5) }),
      execute: (a: { n: number; limit: number }) => a.limit + a.n,
    });

    expect(
      await runCode(`return await tools.strict({n: 1});`, { strict }, make),
    ).toEqual({ result: 6 });

    const bad = await runCode(
      `return await tools.strict({n: 'x'});`,
      { strict },
      make,
    );

    expect(bad).toHaveProperty('error');
  });

  it('runs calls concurrently', async () => {
    let active = 0;
    let peak = 0;
    const slow = t(async () => {
      peak = Math.max(peak, ++active);
      await new Promise(r => setTimeout(r, 10));
      active--;

      return 1;
    });
    const out = await runCode(
      `return await Promise.all([tools.slow({}), tools.slow({}), tools.slow({})]);`,
      { slow },
      make,
    );

    expect(out).toEqual({ result: [1, 1, 1] });
    expect(peak).toBe(3);
  });

  it('rejects the promise when a tool throws', async () => {
    const tools = {
      bad: t(() => {
        throw new Error('nope');
      }),
    };

    expect(
      await runCode(
        `try { await tools.bad({}); } catch (e) { return 'caught ' + e.message; }`,
        tools,
        make,
      ),
    ).toEqual({ result: 'caught nope' });
    expect(await runCode(`await tools.bad({})`, tools, make)).toEqual({
      error: 'nope',
    });
  });

  it('takes the last value of an async iterable', async () => {
    const tools = {
      s: t(async function* () {
        yield 1;
        yield 2;
      }),
    };

    expect(await runCode(`return await tools.s({})`, tools, make)).toEqual({
      result: 2,
    });
  });

  it('captures console.log and keeps it on errors', async () => {
    expect(
      await runCode(`console.log('a', {b: 1}); return 1`, {}, make),
    ).toEqual({ result: 1, logs: ['a {"b":1}'] });
    expect(
      await runCode(`console.log('x'); throw new Error('e')`, {}, make),
    ).toEqual({ error: 'e', logs: ['x'] });
  });

  it('times out and terminates the worker', async () => {
    const w = make();
    const out = await runCode(`await new Promise(() => {})`, {}, () => w, 20);

    expect(out).toEqual({ error: 'Timed out after 0.02s' });
    expect(w.terminated).toBe(true);
  });

  it('caps the number of tool calls', async () => {
    const fn = vi.fn(() => 1);
    const out = await runCode(
      `for (let i = 0; i < 60; i++) await tools.a({}); return 'done'`,
      { a: t(fn) },
      make,
    );

    expect(out).toMatchObject({ error: expect.stringContaining('50') });
    expect(fn).toHaveBeenCalledTimes(50);
  });

  it('errors on an oversize result instead of truncating', async () => {
    const out = await runCode(`return 'x'.repeat(200000)`, {}, make);

    expect(out).toMatchObject({ error: expect.stringContaining('limit') });
  });

  it('reports an unknown tool', async () => {
    expect(await runCode(`await tools.ghost({})`, {}, make)).toMatchObject({
      error: expect.stringContaining('tools.ghost'),
    });
  });
});

describe('withCodeMode', () => {
  it('adds run_code listing the executable tools', async () => {
    const tools = withCodeMode({
      a: t(() => 1),
      b: t(() => 2),
      noExec: tool({ description: 'x', inputSchema: z.any() }),
    });

    expect(Object.keys(tools)).toContain('run_code');
    expect(tools.run_code.description).toContain('a, b.');
  });

  it('does not add run_code for fewer than two tools', () => {
    expect(Object.keys(withCodeMode({ a: t(() => 1) }))).toEqual(['a']);
  });
});

describe('code-frame.html', () => {
  it('has no network, no ambient script sources, and a matching hash', () => {
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)![1];
    const scriptSrc = csp.split('; ').find(d => d.startsWith('script-src'))!;
    const hash = createHash('sha256').update(script).digest('base64');

    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(scriptSrc).toContain(`'sha256-${hash}'`);
    expect(scriptSrc).not.toMatch(/https:|blob:|unsafe-inline|nonce/);
  });

  it('is loaded without same-origin access', () => {
    expect(FRAME_SANDBOX).toBe('allow-scripts');
  });
});
