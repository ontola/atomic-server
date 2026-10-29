// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import { welcomeCall, type WelcomeDeps } from './welcomeCall';

function deps(build: WelcomeDeps['build']) {
  const posted: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const store = {
    getResource: vi.fn(async (s: string) => {
      calls.push(`get ${s}`);

      return { hasClasses: () => false };
    }),
    getResourceAncestry: vi.fn(async () => []),
    getDrive: () => undefined,
    setDrive: vi.fn(),
  } as unknown as WelcomeDeps['store'];

  return {
    posted,
    calls,
    store,
    deps: {
      store,
      flush: async () => void calls.push('flush'),
      post: (m: string) => posted.push(JSON.parse(m)),
      build,
    } satisfies WelcomeDeps,
  };
}

describe('welcomeCall', () => {
  it('builds the drive for the personal drive and answers with where to land', async () => {
    const build = vi.fn(async () => ({
      drive: 'did:ad:welcome',
      landing: 'did:ad:doc',
    }));
    const t = deps(build);

    await welcomeCall(t.deps, 7, 'did:ad:personal');

    expect(build).toHaveBeenCalledWith(t.store, 'did:ad:personal');
    // Read the personal drive first, flush after building.
    expect(t.calls[0]).toBe('get did:ad:personal');
    expect(t.calls.at(-1)).toBe('flush');
    expect(t.posted).toEqual([
      {
        method: 'welcomeResult',
        callId: 7,
        ok: true,
        payload: JSON.stringify({
          drive: 'did:ad:welcome',
          landing: 'did:ad:doc',
        }),
      },
    ]);
  });

  it('answers a failure with its message instead of throwing', async () => {
    const t = deps(async () => {
      throw new Error('no space left');
    });

    await welcomeCall(t.deps, 3, 'did:ad:personal');

    expect(t.posted).toEqual([
      {
        method: 'welcomeResult',
        callId: 3,
        ok: false,
        payload: 'no space left',
      },
    ]);
  });
});
