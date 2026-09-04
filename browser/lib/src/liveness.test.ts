import { describe, it } from 'vitest';
import {
  livenessAction,
  LIVENESS_DEADLINE_MS,
  LIVENESS_IDLE_MS,
} from './liveness.js';

/**
 * The browser cannot see the server's protocol-level pings, so `WSClient`
 * decides from inbound-frame silence alone whether to probe (`KEEPALIVE`)
 * or give the socket up. The decision is a pure function; this pins it.
 */
describe('livenessAction', () => {
  it('does nothing while frames keep arriving', ({ expect }) => {
    expect(livenessAction(0, false)).toBe('none');
    expect(livenessAction(LIVENESS_IDLE_MS - 1, false)).toBe('none');
  });

  it('probes once past the idle threshold', ({ expect }) => {
    expect(livenessAction(LIVENESS_IDLE_MS, false)).toBe('probe');
  });

  it('does not probe twice while one is outstanding', ({ expect }) => {
    expect(livenessAction(LIVENESS_IDLE_MS, true)).toBe('none');
    expect(livenessAction(LIVENESS_DEADLINE_MS - 1, true)).toBe('none');
  });

  it('closes once the deadline passes, probe or not', ({ expect }) => {
    expect(livenessAction(LIVENESS_DEADLINE_MS, true)).toBe('close');
    expect(livenessAction(LIVENESS_DEADLINE_MS, false)).toBe('close');
  });

  it('keeps the deadline after the idle threshold', ({ expect }) => {
    expect(LIVENESS_DEADLINE_MS).toBeGreaterThan(LIVENESS_IDLE_MS);
  });
});
