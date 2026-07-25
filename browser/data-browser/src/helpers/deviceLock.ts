/**
 * Device lock: keep the agent unusable on this machine until it's unlocked.
 *
 * Not recovery — the encrypted backup covers that. This is the shared-machine
 * case: without it, `getAgentFromIDB()` loads a signable keypair on every page
 * load, so whoever opens the browser is signed in as you.
 *
 * ## Why a heartbeat rather than sessionStorage
 *
 * The obvious "has this browser session ended?" signal is `sessionStorage`,
 * and it does not work: browsers *restore* sessionStorage when they restore
 * tabs ("continue where you left off"), so a full restart can come back with
 * the marker intact and the device never locks. Instead the app writes a
 * timestamp while it's open, and lock decisions compare the gap since that
 * last beat — a browser that was closed simply stops beating.
 *
 * The gap is also what makes "lock when idle" work, so both policies fall out
 * of one mechanism.
 *
 * Because the agent secret always opens it, this can add friction but can
 * never lock anyone out.
 */

const POLICY_KEY = 'atomic.lock.policy';
// Two clocks, because the policies measure different things: "closed" is
// about the *app* being open, "inactive" is about the *user* doing something.
// One timestamp can't serve both — a blind beat keeps an idle open tab alive
// forever, and beating only on input would lock a running app that's merely
// being read.
const LAST_OPEN_KEY = 'atomic.lock.lastOpen';
const LAST_ACTIVE_KEY = 'atomic.lock.lastActive';

export type LockPolicy = 'never' | 'close' | 'idle-15m' | 'idle-1h';

export const DEFAULT_LOCK_POLICY: LockPolicy = 'never';

/**
 * How long a gap means "locked", and which clock it reads.
 *
 * `close` is deliberately not near-zero: a reload pauses the beat briefly,
 * and background tabs get their timers throttled (often to about once a
 * minute), so a tight threshold would lock people mid-session. Two minutes
 * survives both and still makes "closed the browser and came back" a lock.
 */
const POLICY_GAP: Record<
  Exclude<LockPolicy, 'never'>,
  { key: string; ms: number }
> = {
  close: { key: LAST_OPEN_KEY, ms: 120_000 },
  'idle-15m': { key: LAST_ACTIVE_KEY, ms: 15 * 60_000 },
  'idle-1h': { key: LAST_ACTIVE_KEY, ms: 60 * 60_000 },
};

export const LOCK_POLICY_LABELS: Record<LockPolicy, string> = {
  never: 'Never lock',
  close: 'Lock when I close the browser',
  'idle-15m': 'Lock after 15 minutes of inactivity',
  'idle-1h': 'Lock after 1 hour of inactivity',
};

function readPolicies(): Record<string, LockPolicy> {
  try {
    const raw = localStorage.getItem(POLICY_KEY);

    return raw ? (JSON.parse(raw) as Record<string, LockPolicy>) : {};
  } catch {
    return {};
  }
}

export function getLockPolicy(agentSubject: string | undefined): LockPolicy {
  if (!agentSubject) return DEFAULT_LOCK_POLICY;

  return readPolicies()[agentSubject] ?? DEFAULT_LOCK_POLICY;
}

export function setLockPolicy(agentSubject: string, policy: LockPolicy): void {
  try {
    localStorage.setItem(
      POLICY_KEY,
      JSON.stringify({ ...readPolicies(), [agentSubject]: policy }),
    );
  } catch {
    // Private mode: locking silently stays off rather than half-on.
  }
}

/** Milliseconds since the given clock last ticked, or null if never. */
export function millisSince(key: string, now = Date.now()): number | null {
  try {
    const raw = localStorage.getItem(key);

    if (!raw) return null;

    const last = Number(raw);

    if (!Number.isFinite(last)) return null;

    // A clock that moved backwards shouldn't read as "just seen".
    return Math.max(0, now - last);
  } catch {
    return null;
  }
}

/** Mark the app open *and* the user present — used on sign-in and at start. */
export function beat(now = Date.now()): void {
  try {
    localStorage.setItem(LAST_OPEN_KEY, String(now));
    localStorage.setItem(LAST_ACTIVE_KEY, String(now));
  } catch {
    // Without a heartbeat every load looks like a long gap, so the device
    // locks more often than asked — inconvenient, never unsafe.
  }
}

/** Forget both clocks, so the very next check counts as locked. */
export function clearHeartbeat(): void {
  try {
    localStorage.removeItem(LAST_OPEN_KEY);
    localStorage.removeItem(LAST_ACTIVE_KEY);
  } catch {
    // Absence is the desired state either way.
  }
}

/**
 * Whether the stored agent should be withheld: a policy is set, and the gap
 * since the app was last open exceeds it. No heartbeat at all counts as
 * locked — that's a device that has never run this code, or was locked
 * explicitly.
 */
export function shouldLock(
  agentSubject: string | undefined,
  now = Date.now(),
): boolean {
  const policy = getLockPolicy(agentSubject);

  if (policy === 'never') return false;

  const { key, ms } = POLICY_GAP[policy];
  const gap = millisSince(key, now);

  if (gap === null) return true;

  return gap > ms;
}

/**
 * Keep the heartbeat current while the app is open, and report when the gap
 * has grown past the policy (a tab left open past an idle timeout). Returns a
 * disposer.
 */
export function startLockHeartbeat(
  agentSubject: string | undefined,
  onShouldLock: () => void,
  intervalMs = 20_000,
): () => void {
  if (typeof window === 'undefined') return () => undefined;

  beat();

  const tick = () => {
    // Check *before* refreshing the open-clock: a tab that was suspended
    // (laptop asleep) resumes with a stale timestamp, and beating first would
    // erase the very gap we're looking for.
    if (shouldLock(agentSubject)) {
      onShouldLock();

      return;
    }

    try {
      localStorage.setItem(LAST_OPEN_KEY, String(Date.now()));
    } catch {
      // See `beat`.
    }
  };

  const markActive = () => {
    try {
      localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
    } catch {
      // See `beat`.
    }
  };

  const timer = window.setInterval(tick, intervalMs);

  // Returning to the tab is both activity and the moment a long gap becomes
  // visible, so check then rather than waiting up to a full interval.
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;

    tick();
    markActive();
  };

  const ACTIVITY = ['pointerdown', 'keydown', 'wheel'] as const;

  document.addEventListener('visibilitychange', onVisible);
  ACTIVITY.forEach(e =>
    window.addEventListener(e, markActive, { passive: true }),
  );

  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    ACTIVITY.forEach(e => window.removeEventListener(e, markActive));
  };
}
