import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  enableLoro: vi.fn(),
  ensureAgent: vi.fn(),
}));

vi.mock('idb-keyval', () => ({ get: mocks.get, set: mocks.set }));
vi.mock('@tomic/lib', () => ({
  core: { properties: {} },
  server: { classes: {} },
  dataBrowser: { classes: {} },
  Datatype: {},
  enableLoro: mocks.enableLoro,
}));
vi.mock('devonian/platform-lenses/github-issues/adapter', () => ({
  endpoint: vi.fn(),
}));
vi.mock('./devonian.js', () => ({}));
vi.mock('../Demo/guestAgent', () => ({
  ensureAgentForDemo: mocks.ensureAgent,
}));
vi.mock('../TablePage/createTableFromSpec', () => ({
  buildTableFromSpec: vi.fn(),
}));
vi.mock('devonian/platform-lenses/github-issues', () => ({ Bridge: class {} }));
vi.mock('devonian/platform-lenses/github-issues/ports', () => ({
  AtomicPort: class {},
  GitHubPort: class {},
}));
vi.mock('devonian/platform-lenses/github-issues/proxy', () => ({
  fixtureTransport: vi.fn(),
  proxyTransport: vi.fn(),
}));

import { resumeDemo } from './demo.mjs';

const key = 'devonian-demo:["agent","owner/repo","https://proxy.example"]';
const state = {
  config: { connection: { drive: 'drive' } },
  options: {
    sample: false,
    repository: 'owner/repo',
    proxy: 'https://proxy.example',
  },
};
const handoff = {
  key,
  state: 'state',
  platform: 'github-issues',
  drive: 'drive',
  actor: 'agent',
  proxy: 'https://proxy.example',
};
let actor = 'agent';
let savedState = structuredClone(state);

function storage() {
  const values = new Map<string, string>();

  return {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
    removeItem: (name: string) => values.delete(name),
  };
}

function locks() {
  const pending = new Map<string, Promise<unknown>>();

  return {
    request: <T>(name: string, callback: () => Promise<T>) => {
      const previous = pending.get(name) ?? Promise.resolve();
      const current = previous.then(callback);
      pending.set(
        name,
        current.catch(() => {}),
      );

      return current;
    },
  };
}

const store = {
  getAgent: () => ({ subject: actor }),
  waitForClientDb: vi.fn(),
  getClientDb: () => ({ waitForReady: async () => true }),
  registerLocalOnlyDrive: vi.fn(),
  setDrive: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  actor = 'agent';
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('sessionStorage', storage());
  vi.stubGlobal('navigator', { locks: locks() });
  vi.stubGlobal('location', {
    href: 'https://atomic.example/app/devonian-demo?connection_code=code&integration_state=state&platform=github-issues',
  });
  vi.stubGlobal('history', {
    replaceState: vi.fn((_state, _title, path) => {
      location.href = new URL(path, location.href).href;
    }),
  });
  vi.stubGlobal('fetch', mocks.fetch);
  savedState = structuredClone(state);
  mocks.get.mockImplementation(async () => structuredClone(savedState));
  mocks.set.mockImplementation(async (_key, value) => {
    savedState = structuredClone(value);
  });
  localStorage.setItem(
    'localthought-browser-v1:state',
    JSON.stringify({
      drive: 'drive',
      actor: 'agent',
      platform: 'github-issues',
      origin: 'https://proxy.example',
      expires: Date.now() + 60_000,
      codeVerifier: 'verifier',
      ready: false,
    }),
  );
  sessionStorage.setItem('devonian-browser-handoff', JSON.stringify(handoff));
});

afterEach(() => vi.unstubAllGlobals());

describe('resumeDemo', () => {
  it('serializes overlapping callback resumes before either reads the handoff', async () => {
    let redeem!: () => void;
    let redeemStarted!: () => void;
    const started = new Promise<void>(resolve => (redeemStarted = resolve));
    mocks.fetch.mockImplementation(async url => {
      expect(url).toBe('https://proxy.example/connect/redeem');
      redeemStarted();
      await new Promise<void>(resolve => (redeem = resolve));

      return Response.json({
        connection_code: 'connection',
        platform: 'github-issues',
      });
    });

    const first = resumeDemo(store as never);
    await started;
    const second = resumeDemo(store as never);
    const both = Promise.all([first, second]);
    redeem();
    await expect(both).resolves.toEqual([
      expect.objectContaining({
        key,
        state: expect.objectContaining({ connection: 'state' }),
      }),
      expect.objectContaining({
        key,
        state: expect.objectContaining({ connection: 'state' }),
      }),
    ]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('devonian-browser-handoff')).toBeNull();
    expect(sessionStorage.getItem('devonian-browser-resume')).toBe(key);
  });

  it.each([
    ['platform', 'another-platform'],
    ['state', 'another-state'],
  ])('rejects a callback bound to another %s', async (field, value) => {
    const callback = new URL(location.href);
    callback.searchParams.set(
      field === 'platform' ? 'platform' : 'integration_state',
      value,
    );
    location.href = callback.href;

    await expect(resumeDemo(store as never)).rejects.toThrow(
      'Invalid connection callback state',
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects a callback bound to another agent before redeeming it', async () => {
    actor = 'another-agent';

    await expect(resumeDemo(store as never)).rejects.toThrow(
      'Invalid connection callback state',
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('does not repeat an uncertain redemption', async () => {
    mocks.fetch.mockRejectedValue(new Error('connection lost'));

    await expect(resumeDemo(store as never)).rejects.toThrow('connection lost');
    await expect(resumeDemo(store as never)).rejects.toThrow(
      'Reconnect your account',
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
