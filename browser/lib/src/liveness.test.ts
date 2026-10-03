import { describe, it } from 'vitest';
import {
  livenessAction,
  LIVENESS_CHECK_MS,
  LIVENESS_IDLE_MS,
  LIVENESS_PROBE_TIMEOUT_MS,
} from './liveness.js';

/**
 * The browser cannot see the server's protocol-level pings, so `WSClient`
 * decides from inbound-frame silence alone whether to probe (`KEEPALIVE`)
 * or give the socket up. The decision is a pure function; this pins it.
 */
describe('livenessAction', () => {
  it('does nothing while frames keep arriving', ({ expect }) => {
    expect(livenessAction(0, undefined)).toBe('none');
    expect(livenessAction(LIVENESS_IDLE_MS - 1, undefined)).toBe('none');
  });

  it('probes once past the idle threshold', ({ expect }) => {
    expect(livenessAction(LIVENESS_IDLE_MS, undefined)).toBe('probe');
  });

  it('does not probe twice while one is outstanding', ({ expect }) => {
    expect(livenessAction(LIVENESS_IDLE_MS, 0)).toBe('none');
    expect(
      livenessAction(
        LIVENESS_IDLE_MS + LIVENESS_PROBE_TIMEOUT_MS - 1,
        LIVENESS_PROBE_TIMEOUT_MS - 1,
      ),
    ).toBe('none');
  });

  it('closes once a probe has gone unanswered past its timeout', ({
    expect,
  }) => {
    expect(
      livenessAction(
        LIVENESS_IDLE_MS + LIVENESS_PROBE_TIMEOUT_MS,
        LIVENESS_PROBE_TIMEOUT_MS,
      ),
    ).toBe('close');
  });

  it('never closes on silence alone, however long', ({ expect }) => {
    // A hidden tab's timer can first run minutes after the last frame.
    // Without a probe out, the server has not been asked yet.
    expect(livenessAction(10 * 60_000, undefined)).toBe('probe');
  });
});

/**
 * #1800: in a hidden tab Chrome batches timers to once a minute, so the 5 s
 * liveness check ran every 60 s. Its first look at a quiet socket saw 60 s
 * of silence, past the old 45 s deadline, and closed a healthy connection
 * without ever sending the probe ("no frame from the server for 45000ms
 * (probe unanswered)"). The app then showed "Working offline".
 *
 * Replays the WSClient timer loop against a server that answers every probe
 * within a round trip, at the throttled cadence and at the normal one.
 */
describe('liveness under timer throttling', () => {
  function simulate(tickMs: number, durationMs: number, rttMs: number) {
    let now = 0;
    let lastFrameAt = 0;
    let probeSentAt: number | undefined;
    let echoAt: number | undefined;
    const actions: string[] = [];

    for (now = tickMs; now <= durationMs; now += tickMs) {
      // Socket events are not throttled: an echo lands when it arrives.
      if (echoAt !== undefined && echoAt <= now) {
        lastFrameAt = echoAt;
        probeSentAt = undefined;
        echoAt = undefined;
      }

      const action = livenessAction(
        now - lastFrameAt,
        probeSentAt === undefined ? undefined : now - probeSentAt,
      );
      actions.push(action);

      if (action === 'probe') {
        probeSentAt = now;
        echoAt = now + rttMs;
      } else if (action === 'close') {
        break;
      }
    }

    return actions;
  }

  it('keeps a healthy socket open when timers fire once a minute', ({
    expect,
  }) => {
    const actions = simulate(60_000, 30 * 60_000, 50);
    expect(actions).not.toContain('close');
    expect(actions).toContain('probe');
  });

  it('keeps a healthy socket open at the normal cadence', ({ expect }) => {
    const actions = simulate(LIVENESS_CHECK_MS, 30 * 60_000, 50);
    expect(actions).not.toContain('close');
  });

  it('still closes a dead socket, one tick after the probe times out', ({
    expect,
  }) => {
    // The echo never comes.
    const actions = simulate(60_000, 30 * 60_000, Infinity);
    expect(actions).toEqual(['probe', 'close']);
  });
});
