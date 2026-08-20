import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  looksLikeOpenableSubject,
  parseDidOpenInput,
  buildShareLink,
} from './didResolve';

// Absolute origin for /resolve-agent and /iroh-sync — the real module touches
// `window`, so keep it out of unit tests (same pattern as pairing.test.ts).
vi.mock('./tauri', () => ({
  getLocalServerOrigin: () => 'http://localhost:9883',
}));

const { resolveDidForOpen, resolveAgentNodeIds } = await import('./didResolve');
const { readKnownPeers, upsertKnownPeer } = await import('./knownPeers');

const RESOURCE =
  'did:ad:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const AGENT = 'did:ad:agent:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const NODE =
  'did:ad:node:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const NODE_B =
  'did:ad:node:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';

const resolveAgentContract = (() => {
  const path = fileURLToPath(
    new URL(
      '../../../../testdata/resolve-agent-response.json',
      import.meta.url,
    ),
  );
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<
    string,
    unknown
  >;

  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !key.startsWith('_')),
  ) as {
    agent: string;
    nodeIds: string[];
    publicZone: string | null;
  };
})();

function installLocalStorage() {
  const store = new Map<string, string>();

  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

/**
 * Route fetch stubs for the two endpoints resolveDidForOpen dials.
 * Returns the mock so tests can assert URLs and bodies.
 */
function stubResolveFetch(opts: {
  resolveAgent?: unknown;
  resolveAgentOk?: boolean;
  irohSync?: unknown | ((url: string, init?: RequestInit) => unknown);
}) {
  const fetchMock = vi
    .fn()
    .mockImplementation(async (url: unknown, init?: RequestInit) => {
      const href = String(url);

      if (href.includes('/resolve-agent')) {
        const body = opts.resolveAgent ?? { nodeIds: [] };

        return {
          ok: opts.resolveAgentOk ?? true,
          json: async () => body,
        };
      }

      if (href.includes('/iroh-sync')) {
        const body =
          typeof opts.irohSync === 'function'
            ? opts.irohSync(href, init)
            : (opts.irohSync ?? { count: 1 });

        return {
          ok: true,
          json: async () => body,
        };
      }

      throw new Error(`unexpected fetch: ${href}`);
    });

  globalThis.fetch = fetchMock as unknown as typeof fetch;

  return fetchMock;
}

/** isAvailable that fails until `unlock()` — models "not local until after sync". */
function gatedAvailability() {
  let available = false;

  return {
    isAvailable: async () => available,
    unlock: () => {
      available = true;
    },
  };
}

describe('parseDidOpenInput', () => {
  it('parses a bare resource DID', () => {
    expect(parseDidOpenInput(RESOURCE)).toEqual({ subject: RESOURCE });
  });

  it('parses agent and node hints on the DID query string', () => {
    const input = `${RESOURCE}?agent=${AGENT}&node=${NODE}`;
    expect(parseDidOpenInput(input)).toEqual({
      subject: RESOURCE,
      agent: AGENT,
      node: NODE,
    });
  });

  it('keeps a drive hint on the subject', () => {
    const drive = RESOURCE.replace(/A/g, 'D');
    const input = `${RESOURCE}?drive=${drive}&agent=${AGENT}`;
    expect(parseDidOpenInput(input)).toEqual({
      subject: `${RESOURCE}?drive=${drive}`,
      agent: AGENT,
    });
  });

  it('parses atomic://open links', () => {
    const input = `atomic://open?subject=${encodeURIComponent(RESOURCE)}&agent=${encodeURIComponent(AGENT)}&node=${encodeURIComponent(NODE)}`;
    expect(parseDidOpenInput(input)).toEqual({
      subject: RESOURCE,
      agent: AGENT,
      node: NODE,
    });
  });

  it('rejects bare node DIDs (those are pairing codes)', () => {
    expect(parseDidOpenInput(NODE)).toBeNull();
  });

  it('looksLikeOpenableSubject accepts resource DIDs and rejects garbage', () => {
    expect(looksLikeOpenableSubject(RESOURCE)).toBe(true);
    expect(looksLikeOpenableSubject('not a did')).toBe(false);
  });
});

describe('buildShareLink', () => {
  it('builds an https show URL with agent and node hints', () => {
    const link = buildShareLink(RESOURCE, {
      appOrigin: 'https://example.com',
      agent: AGENT,
      node: NODE,
    });
    expect(link).toContain('https://example.com/app/show?');
    expect(link).toContain(`subject=${encodeURIComponent(RESOURCE)}`);
    expect(link).toContain(`agent=${encodeURIComponent(AGENT)}`);
    expect(link).toContain(`node=${encodeURIComponent(NODE)}`);
  });

  it('builds an atomic://open link for OS handoff', () => {
    const link = buildShareLink(RESOURCE, {
      appOrigin: 'https://example.com',
      agent: AGENT,
      node: NODE,
      format: 'atomic',
    });
    expect(link.startsWith('atomic://open?')).toBe(true);
    expect(parseDidOpenInput(link)).toEqual({
      subject: RESOURCE,
      agent: AGENT,
      node: NODE,
    });
  });

  it('round-trips https show URLs through parseDidOpenInput', () => {
    const link = buildShareLink(RESOURCE, {
      appOrigin: 'http://localhost:6747',
      agent: AGENT,
      node: NODE,
    });
    expect(parseDidOpenInput(link)).toEqual({
      subject: RESOURCE,
      agent: AGENT,
      node: NODE,
    });
  });
});

describe('resolveAgentNodeIds', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('GETs /resolve-agent and reads the shared contract fields', async () => {
    const fetchMock = stubResolveFetch({
      resolveAgent: resolveAgentContract,
    });

    const nodes = await resolveAgentNodeIds(resolveAgentContract.agent);

    expect(nodes).toEqual(resolveAgentContract.nodeIds);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://localhost:9883/resolve-agent?agent=${encodeURIComponent(resolveAgentContract.agent)}`,
    );
  });

  it('normalises bare hex node ids to did:ad:node:', async () => {
    const hex = 'e'.repeat(64);
    stubResolveFetch({
      resolveAgent: { nodeIds: [hex] },
    });

    expect(await resolveAgentNodeIds(AGENT)).toEqual([`did:ad:node:${hex}`]);
  });

  it('returns an empty list when the server reports an error', async () => {
    stubResolveFetch({
      resolveAgent: { error: 'not found' },
      resolveAgentOk: false,
    });

    expect(await resolveAgentNodeIds(AGENT)).toEqual([]);
  });
});

describe('resolveDidForOpen', () => {
  beforeEach(() => {
    installLocalStorage();
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns via local when the subject is already available', async () => {
    const fetchMock = stubResolveFetch({});

    const result = await resolveDidForOpen(RESOURCE, {
      isAvailable: async () => true,
      node: NODE,
      agent: AGENT,
    });

    expect(result).toEqual({ ok: true, subject: RESOURCE, via: 'local' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dials an explicit node hint and reports via node', async () => {
    const gate = gatedAvailability();
    const fetchMock = stubResolveFetch({
      irohSync: () => {
        gate.unlock();

        return { count: 2 };
      },
    });

    const result = await resolveDidForOpen(RESOURCE, {
      isAvailable: gate.isAvailable,
      node: NODE,
      tryPeers: false,
    });

    expect(result).toEqual({ ok: true, subject: RESOURCE, via: 'node' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({ nodeId: NODE, drive: RESOURCE });
  });

  it('resolves an agent via /resolve-agent then dials the returned node', async () => {
    const gate = gatedAvailability();
    const fetchMock = stubResolveFetch({
      resolveAgent: resolveAgentContract,
      irohSync: () => {
        gate.unlock();

        return { count: 1 };
      },
    });

    const result = await resolveDidForOpen(RESOURCE, {
      isAvailable: gate.isAvailable,
      agent: resolveAgentContract.agent,
      tryPeers: false,
    });

    expect(result).toEqual({ ok: true, subject: RESOURCE, via: 'agent' });

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain('/resolve-agent?agent=');
    expect(urls[1]).toBe('http://localhost:9883/iroh-sync');

    const syncBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(syncBody.nodeId).toBe(resolveAgentContract.nodeIds[0]);
  });

  it('with tryPeers false returns known peers without dialling them', async () => {
    upsertKnownPeer(NODE_B, 'Tablet');
    stubResolveFetch({});

    const result = await resolveDidForOpen(RESOURCE, {
      isAvailable: async () => false,
      tryPeers: false,
    });

    expect(result.ok).toBe(false);

    if (result.ok) {
      throw new Error('expected failure');
    }

    expect(result.peers).toEqual([
      expect.objectContaining({ nodeId: NODE_B, label: 'Tablet' }),
    ]);
    expect(result.message).toMatch(/known devices/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('walks known peers when hints are absent', async () => {
    upsertKnownPeer(NODE_B, 'Tablet');
    const gate = gatedAvailability();
    const fetchMock = stubResolveFetch({
      irohSync: () => {
        gate.unlock();

        return { count: 1 };
      },
    });

    const result = await resolveDidForOpen(RESOURCE, {
      isAvailable: gate.isAvailable,
      tryPeers: true,
    });

    expect(result).toEqual({ ok: true, subject: RESOURCE, via: 'peers' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.nodeId).toBe(NODE_B);
  });

  it('skips a known peer that was already tried as the node hint', async () => {
    upsertKnownPeer(NODE, 'Already tried');
    upsertKnownPeer(NODE_B, 'Next');
    const dialled: string[] = [];
    stubResolveFetch({
      irohSync: (_url, init) => {
        dialled.push(JSON.parse(init!.body as string).nodeId as string);

        return { count: 0 };
      },
    });

    const result = await resolveDidForOpen(RESOURCE, {
      isAvailable: async () => false,
      node: NODE,
      tryPeers: true,
    });

    expect(result.ok).toBe(false);
    expect(dialled).toEqual([NODE, NODE_B]);
  });

  it('reports a clear failure when nothing resolves', async () => {
    stubResolveFetch({});

    const result = await resolveDidForOpen(RESOURCE, {
      isAvailable: async () => false,
      tryPeers: true,
    });

    expect(result).toMatchObject({
      ok: false,
      subject: RESOURCE,
    });

    if (result.ok) {
      throw new Error('expected failure');
    }

    expect(result.message).toMatch(/Pair a device|known devices/i);
    expect(readKnownPeers()).toEqual([]);
  });
});
