import { test, expect } from '@playwright/test';
import { before } from './test-utils';

/**
 * Regression for ClientDb OPFS durability. Per-write redb commits use
 * `Durability::None`; only a later `flush()` (Immediate commit) persists them.
 * The native server flushes on a periodic tick, but the browser worker never
 * did — so every local write was rolled back on the next reload. That was
 * invisible online (the server re-fetches and re-caches) but fatal offline:
 * after a disconnect + reload the drive read "Offline: resource not available
 * locally". The worker now flushes on a 1s tick after writes.
 */
test('cached drive survives reload while offline', async ({ page }) => {
  // Record who writes an EMPTY resource into the store's map.
  //
  // This test's remaining failure is a drive that is present in OPFS while
  // the store holds a resource with zero properties and no error — deleting
  // that cached entry makes the very next read return all ten. So something
  // writes the empty entry, and knowing what does is the whole question. The
  // hook goes on `window.store`'s assignment so it is installed before the
  // app can populate anything, and it survives the reload because
  // `addInitScript` runs on every navigation.
  await page.addInitScript(() => {
    const writes: { subject: string; stack: string }[] = [];
    const events: string[] = [];
    (window as unknown as Record<string, unknown>).__emptyWrites = writes;
    (window as unknown as Record<string, unknown>).__events = events;

    const at = () => Math.round(performance.now());
    const short = (s: unknown) => String(s).slice(-12);

    let lastLine = '';
    let repeats = 0;

    const record = (line: string) => {
      // Boot re-fetches the same subject dozens of times in a burst; collapsing
      // the repeat keeps the one line that matters from being pushed out of the
      // failure message by noise.
      if (line === lastLine) {
        repeats++;
        events[events.length - 1] = `${at()} ${line} ×${repeats + 1}`;

        return;
      }

      lastLine = line;
      repeats = 0;

      // A cap keeps a chatty path from eating the page's memory; the
      // interesting events all happen in the first seconds after the reload.
      if (events.length < 400) events.push(`${at()} ${line}`);
    };

    /** Log every call the store makes on this subject's behalf, so the ONE
     * that leaves it empty-and-without-error is visible. Every branch of
     * `fetchResourceWithLocalFallback` ends in either data or `failResource`,
     * so a run with neither means an await never returned — and the last
     * event recorded says which one. */
    /** @param settled Also record how the call ENDED. The awaits inside the
     *  local-fallback fetch are the suspects for a resource that neither
     *  hydrates nor errors, and only a call with no matching end pins one. */
    const wrapper =
      (host: Record<string, unknown>, label: string) =>
      (
        name: string,
        describe: (args: unknown[]) => string,
        settled = false,
      ) => {
        const original = host[name] as
          | ((...args: unknown[]) => unknown)
          | undefined;

        if (typeof original !== 'function') {
          record(`MISSING ${label}${name}`);

          return;
        }

        host[name] = (...args: unknown[]) => {
          // Several of these run concurrently for different subjects, so the
          // call's own tag has to travel to its end line — otherwise the chain
          // that never finished can't be told from the ones that did.
          let tag = '?';

          try {
            tag = `${label}${name}(${describe(args)})`;
            record(tag);
          } catch {
            // Never let instrumentation break the thing it observes.
          }

          const result = original.apply(host, args);

          if (settled && !(result instanceof Promise)) {
            record(`${tag} → ${JSON.stringify(result)?.slice(0, 60)}`);
          }

          if (settled && result instanceof Promise) {
            result.then(
              value =>
                record(`${tag} → ${JSON.stringify(value)?.slice(0, 60)}`),
              error =>
                record(`${tag} ✗ ${(error as Error)?.message?.slice(0, 60)}`),
            );
          }

          return result;
        };
      };

    /** The two awaits the OPFS branch of the fetch depends on. A worker torn
     * down mid-request takes its in-flight replies with it, so "called but
     * never settled" is a real outcome here, not a theoretical one. */
    const watchDb = (db: Record<string, unknown> & { __watched?: boolean }) => {
      if (!db || db.__watched) return;

      db.__watched = true;
      const wrap = wrapper(db, 'db.');
      wrap('waitForInit', () => '', true);
      wrap('getResourceWithSnapshot', args => short(args[0]), true);
    };

    const watch = (store: Record<string, unknown>) => {
      const wrap = wrapper(store, '');
      const subjectOf = (r: unknown) =>
        short((r as { subject?: string })?.subject);
      const entriesOf = (r: unknown) =>
        (r as { getEntries?(): unknown[] })?.getEntries?.()?.length ?? '?';

      // Which database file this worker opened matters: until an agent is
      // known the app runs against the shared anonymous db, which holds none
      // of this agent's data. `leaderLockName` carries the name either way.
      wrap('setClientDb', args => {
        const db = args[0] as {
          opts?: { dbName?: string };
          leaderLockName?: string;
          isReady?: boolean;
        };

        watchDb(db as Record<string, unknown>);

        return `${db?.opts?.dbName ?? db?.leaderLockName ?? '?'} ready=${db?.isReady}`;
      });
      wrap(
        'failResource',
        args =>
          `${short(args[0])} "${(args[1] as Error)?.message?.slice(0, 60)}"`,
      );
      wrap('fetchResourceWithLocalFallback', args => short(args[0]), true);
      wrap('fetchResourceFromServer', args => short(args[0]));
      // Whether an OPFS hit actually hydrated: it returns `true` on paths that
      // deliberately do NOT write any values, which would leave the placeholder
      // empty while the caller counts it as local data.
      wrap('hydrateResourceFromJson', args => short(args[0]), true);
      wrap('waitForServerConnected', args => String(args[0]), true);
      wrap(
        'addResource',
        args => `${subjectOf(args[0])} n=${entriesOf(args[0])}`,
      );
    };

    let current: unknown;
    Object.defineProperty(window, 'store', {
      configurable: true,
      get: () => current,
      set: value => {
        current = value;
        const store = value as {
          resources?: Map<string, { getEntries?(): unknown[] }>;
          __emptyWatch?: boolean;
        };

        if (!store?.resources?.set || store.__emptyWatch) return;

        store.__emptyWatch = true;
        watch(store as unknown as Record<string, unknown>);
        const original = store.resources.set.bind(store.resources);

        store.resources.set = (key, resource) => {
          try {
            if ((resource?.getEntries?.()?.length ?? -1) === 0) {
              writes.push({
                subject: String(key),
                stack: String(new Error().stack).slice(0, 700),
              });
            }
          } catch {
            // Never let instrumentation break the thing it observes.
          }

          return original(key, resource);
        };
      },
    });
  });

  // The store logs its own diagnosis of a failed OPFS lookup / incomplete
  // import; without this it goes to a console nobody reads.
  const consoleLines: string[] = [];
  page.on('console', message => {
    const text = message.text();

    if (/ClientDb|Store|Outbox|Offline/.test(text)) {
      consoleLines.push(`${message.type()}: ${text.slice(0, 200)}`);
    }
  });

  await before({ page }); // devDrive — creates + visits a drive online

  // Wait for ClientDb + the drive's OPFS write — a bare timeout races
  // WASM init under dagger (clientdb.init alone can exceed 2s). Mirror
  // `offline-reload.spec.ts`.
  // `window.store` is assigned during boot, so this has to tolerate it being
  // absent rather than throw: under a slow boot the unguarded form fails with
  // "Cannot read properties of undefined", which reports a TypeError instead
  // of whatever actually went wrong. Reproduced locally at
  // ATOMIC_TEST_CPU_THROTTLE=8.
  await page.waitForFunction(
    () => window.store?.getClientDb()?.isReady === true,
    undefined,
    { timeout: 30000 },
  );
  await page.waitForFunction(
    async () => {
      const drive = window.store?.getDrive();
      if (!drive) return false;
      const jsonAd = await window.store?.getClientDb()?.getResource?.(drive);

      return !!jsonAd;
    },
    undefined,
    { timeout: 15000 },
  );

  // The write landing is not the same as the write being durable: per-write
  // commits use `Durability::None` and are only persisted by a later Immediate
  // commit, which the worker otherwise schedules on a 1s tick. A reload before
  // that tick rolls the write back — which is the exact bug under test, so ask
  // for the flush and wait for it rather than racing the timer.
  await page.evaluate(async () => {
    const db = window.store.getClientDb();

    // Not optional-chained: `?.flush()` on an absent ClientDb is a silent
    // no-op, and the test would go on to reload and fail with the same
    // props=0 it was written to catch — blaming durability for a database
    // that was never there.
    if (!db) throw new Error('ClientDb missing when asking for a flush');

    await db.flush();
  });

  const drive = await page.evaluate(() => window.store.getDrive());

  // Go offline (what the Sync-page "disconnect" does) and reload.
  await page.evaluate(() => localStorage.setItem('ws-disconnected', '1'));
  await page.reload();

  await page.waitForFunction(
    () => window.store?.getClientDb()?.isReady === true,
    undefined,
    { timeout: 30000 },
  );

  const r = await page.evaluate(async d => {
    const s = window.store;
    let viaGet = -1; // -1 ⇒ threw "Offline: resource not available locally"

    try {
      const g = await s.getResource(d);
      viaGet = g?.getEntries ? g.getEntries().length : 0;
    } catch {
      viaGet = -1;
    }

    // Ask the ClientDb directly as well as through the store. These answer
    // different questions and the failure has been ambiguous between them:
    // whether the drive was persisted to OPFS at all, or whether it was
    // persisted and the store declines to read it while offline.
    let inClientDb = false;
    let storedProps = -1;
    let storedHasClass = false;

    try {
      const jsonAd = await s.getClientDb()?.getResource?.(d);
      inClientDb = !!jsonAd;

      if (jsonAd) {
        // What the store's "renderable" guard looks at when deciding whether
        // an OPFS hit counts: a resource with no class and nothing beyond the
        // server-managed skeleton is discarded as a miss, which offline means
        // failing rather than falling back.
        const parsed = JSON.parse(jsonAd) as Record<string, unknown>;
        storedProps = Object.keys(parsed).length;
        storedHasClass = 'https://atomicdata.dev/properties/isA' in parsed;
      }
    } catch {
      inClientDb = false;
    }

    // Ask again, from scratch, now that the ClientDb is definitely attached
    // and ready. If THIS succeeds while the first attempt failed, the drive
    // was readable all along and the failure is a resource failed during boot
    // — before the ClientDb was attached — that nothing ever retries.
    let viaRetry = -1;

    try {
      s.resources.delete(d);
      const again = await s.getResource(d);
      viaRetry = again?.getEntries ? again.getEntries().length : 0;
    } catch {
      viaRetry = -1;
    }

    const emptyWrites = (
      (window as unknown as Record<string, unknown>).__emptyWrites as
        | { subject: string; stack: string }[]
        | undefined
    )?.filter(w => w.subject === d);

    return {
      emptyWrites,
      events: (window as unknown as Record<string, unknown>).__events,
      // `error=undefined` alone is ambiguous between three very different
      // states, and every offline branch of the fetch ends in an error — so
      // read the ones that tell them apart. `cached` absent means the store
      // filed the resource under another key (an alias), `loading` means an
      // await never returned, and ready-with-zero-entries means something
      // declared success without hydrating anything.
      cached: (() => {
        const held = s.resources.get(d);

        if (!held) return 'ABSENT';

        return `loading=${held.loading} new=${held.new} ready=${held.isReady?.()} n=${
          held.getEntries?.().length
        }`;
      })(),
      aliasedTo:
        (s as unknown as { aliases?: Map<string, string> }).aliases?.get?.(d) ??
        null,
      viaRetry,
      serverConnected: s.getSyncStatus?.()?.serverConnected,
      viaGetProps: viaGet,
      inClientDb,
      storedProps,
      storedHasClass,
      error: s.resources.get(d)?.error?.message,
    };
  }, drive ?? '');

  // We must actually be offline (proves we're testing the local cache, not a
  // server re-fetch), and the drive must still resolve from the ClientDb.
  expect(r.serverConnected).toBe(false);
  expect(
    r.viaGetProps,
    `drive should load from OPFS offline; got props=${r.viaGetProps} ` +
      `inClientDb=${r.inClientDb} storedProps=${r.storedProps} ` +
      `storedHasClass=${r.storedHasClass} viaRetry=${r.viaRetry} ` +
      `error=${r.error} cached=${r.cached} aliasedTo=${r.aliasedTo}. ` +
      `Events: ${JSON.stringify(r.events)?.slice(0, 6000)}. ` +
      `Console: ${JSON.stringify(consoleLines)?.slice(0, 1500)}. ` +
      `Empty writes for this subject: ${JSON.stringify(r.emptyWrites)?.slice(0, 1500)}. ` +
      (r.viaRetry > 0
        ? 'A fresh request SUCCEEDS, so the drive was readable all along and ' +
          'the first attempt failed before the ClientDb was attached.'
        : 'A fresh request fails too, so the store genuinely cannot read it.') +
      ' ' +
      (r.inClientDb
        ? 'The drive IS in OPFS, so this is the store refusing to read it offline.'
        : 'The drive is NOT in OPFS, so the write did not survive the reload.'),
  ).toBeGreaterThan(0);
});
