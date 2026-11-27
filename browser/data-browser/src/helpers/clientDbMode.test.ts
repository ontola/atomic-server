import { afterEach, describe, expect, it, vi } from 'vitest';
import { isClientDbEnabled } from './clientDbMode';

vi.mock('./tauri', () => ({ isRunningInTauri: vi.fn(() => true) }));

describe('isClientDbEnabled in the desktop app', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is off for a self-built app, which has its embedded node', () => {
    vi.stubEnv('VITE_ATOMIC_HOSTED_DISTRIBUTION', '');

    expect(isClientDbEnabled()).toBe(false);
  });

  it('is on for the hosted app, where new drives live on this device', () => {
    vi.stubEnv('VITE_ATOMIC_HOSTED_DISTRIBUTION', 'true');

    expect(isClientDbEnabled()).toBe(true);
  });
});
