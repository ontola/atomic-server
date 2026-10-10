import { describe, expect, it, vi } from 'vitest';
import { discoverHomeServer, type DiscoveryDeps } from './discoverHomeServer';

const DRIVE = 'did:ad:home';

function setup(overrides: Partial<DiscoveryDeps> = {}) {
  const store = {
    getServerUrl: vi.fn(() => 'https://app.example'),
    setServerUrl: vi.fn(),
    unregisterLocalOnlyDrive: vi.fn(),
    waitForServerConnected: vi.fn(async () => true),
  };
  const persist = vi.fn();
  const deps: DiscoveryDeps = {
    wasExplicitlyChosen: () => false,
    hasEmbeddedNode: () => false,
    hasDriveData: async () => false,
    resolveOrigins: async () => ['https://a.example', 'https://b.example'],
    probe: async () => 'node',
    ...overrides,
  };

  return { store, persist, deps };
}

describe('discoverHomeServer', () => {
  it('connects to the first announced origin that is a node', async () => {
    const { store, persist, deps } = setup({
      probe: async origin =>
        origin === 'https://a.example' ? 'not-node' : 'node',
    });

    expect(await discoverHomeServer(store, DRIVE, persist, deps)).toBe(true);
    expect(store.setServerUrl).toHaveBeenCalledWith('https://b.example');
    expect(persist).toHaveBeenCalledWith('https://b.example');
    expect(store.unregisterLocalOnlyDrive).toHaveBeenCalledWith(DRIVE);
  });

  it('keeps the announced order when several answer', async () => {
    const { store, persist, deps } = setup();

    await discoverHomeServer(store, DRIVE, persist, deps);
    expect(store.setServerUrl).toHaveBeenCalledWith('https://a.example');
  });

  it('never overrides an explicitly chosen server', async () => {
    const resolveOrigins = vi.fn(async () => ['https://a.example']);
    const { store, persist, deps } = setup({
      wasExplicitlyChosen: () => true,
      resolveOrigins,
    });

    expect(await discoverHomeServer(store, DRIVE, persist, deps)).toBe(false);
    expect(resolveOrigins).not.toHaveBeenCalled();
    expect(store.setServerUrl).not.toHaveBeenCalled();
  });

  it('leaves a desktop shell with its own node alone', async () => {
    const { store, persist, deps } = setup({ hasEmbeddedNode: () => true });

    expect(await discoverHomeServer(store, DRIVE, persist, deps)).toBe(false);
    expect(store.setServerUrl).not.toHaveBeenCalled();
  });

  it('does not switch a session whose server already has the drive', async () => {
    const resolveOrigins = vi.fn(async () => ['https://a.example']);
    const { store, persist, deps } = setup({
      hasDriveData: async () => true,
      resolveOrigins,
    });

    expect(await discoverHomeServer(store, DRIVE, persist, deps)).toBe(false);
    expect(resolveOrigins).not.toHaveBeenCalled();
    expect(store.setServerUrl).not.toHaveBeenCalled();
  });

  it('stays put when no origin is announced or none is a node', async () => {
    for (const overrides of [
      { resolveOrigins: async () => [] },
      { probe: async () => 'unreachable' as const },
      { probe: async () => 'not-node' as const },
    ]) {
      const { store, persist, deps } = setup(overrides);

      expect(await discoverHomeServer(store, DRIVE, persist, deps)).toBe(false);
      expect(store.setServerUrl).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    }
  });

  it('skips the origin it is already on', async () => {
    const probe = vi.fn(async () => 'node' as const);
    const { store, persist, deps } = setup({
      resolveOrigins: async () => ['https://app.example'],
      probe,
    });

    expect(await discoverHomeServer(store, DRIVE, persist, deps)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('swallows failures', async () => {
    const { store, persist, deps } = setup({
      resolveOrigins: async () => {
        throw new Error('boom');
      },
    });

    expect(await discoverHomeServer(store, DRIVE, persist, deps)).toBe(false);
  });

  it('gives up at the deadline and does not connect late', async () => {
    vi.useFakeTimers();

    let finish: (origins: string[]) => void = () => undefined;
    const { store, persist, deps } = setup({
      resolveOrigins: () =>
        new Promise<string[]>(resolve => (finish = resolve)),
    });
    const result = discoverHomeServer(store, DRIVE, persist, deps, 1_000);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(await result).toBe(false);

    finish(['https://a.example']);
    await vi.advanceTimersByTimeAsync(10);
    expect(store.setServerUrl).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not connect when the person picked a server while it was asking', async () => {
    let chosen = false;
    const { store, persist, deps } = setup({
      wasExplicitlyChosen: () => chosen,
      probe: async () => {
        chosen = true;

        return 'node';
      },
    });

    expect(await discoverHomeServer(store, DRIVE, persist, deps)).toBe(false);
    expect(store.setServerUrl).not.toHaveBeenCalled();
  });
});
