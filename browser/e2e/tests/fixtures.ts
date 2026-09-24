import { test as base, expect, type BrowserContext } from '@playwright/test';

import { collectFailureState } from './failure-state';
import { DiagnosticCollector } from './diagnostic-collector';
import { TransportCollector } from './transport-collector';

export * from '@playwright/test';

/** No global allowlist: expected failures belong to the test that causes them. */
export const test = base.extend<{
  browserDiagnostics: Pick<DiagnosticCollector, 'expect'>;
}>({
  browserDiagnostics: [
    async ({ browser, context: defaultContext }, use, testInfo) => {
      const diagnostics = new DiagnosticCollector();
      const transport = new TransportCollector();
      const watched = new Set<BrowserContext>();
      const ownedContexts = new Set<BrowserContext>();

      const watch = async (context: BrowserContext) => {
        if (watched.has(context)) return;
        watched.add(context);
        diagnostics.start(context);
        transport.start(context);
        await context.addInitScript(() => {
          const load = {
            longTasks: [] as Array<{ start: number; duration: number }>,
            maxTimerLagMs: 0,
          };
          window.__e2eLoad = load;

          if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
            new PerformanceObserver(list => {
              for (const entry of list.getEntries())
                load.longTasks.push({
                  start: entry.startTime,
                  duration: entry.duration,
                });
              load.longTasks = load.longTasks.slice(-100);
            }).observe({ entryTypes: ['longtask'] });
          }

          let previous = performance.now();
          setInterval(() => {
            const now = performance.now();
            load.maxTimerLagMs = Math.max(
              load.maxTimerLagMs,
              now - previous - 1000,
            );
            previous = now;
          }, 1000);
        });

        // General UI tests use an empty discovery room, independent of public
        // service availability. verify-peer-mesh.mjs separately exercises real
        // signaling, authenticated WebRTC, persistence and reconciliation.
        await installEmptyDiscoveryRoom(context);
      };

      // Depend on context so assertions run BEFORE Playwright closes it. The
      // auto fixture still runs before page setup/navigation. Wrap creation so additional
      // users, popups and tabs are observed before their first navigation too.
      const newContext = browser.newContext;

      browser.newContext = async options => {
        const context = await newContext.call(browser, options);
        ownedContexts.add(context);
        await watch(context);

        return context;
      };

      try {
        await watch(defaultContext);
        await Promise.all(browser.contexts().map(watch));
        await use({
          expect: (...args) => diagnostics.expect(...args),
        });
      } finally {
        browser.newContext = newContext;
        diagnostics.dispose();
        transport.dispose();
        const { entries, expectations, unexpected, missing } =
          diagnostics.snapshot();

        if (
          testInfo.status !== testInfo.expectedStatus ||
          unexpected.length ||
          missing.length
        ) {
          const closedPages = transport
            .pages()
            .filter(page => page.isClosed())
            .slice(0, 5);

          if (closedPages.length) {
            await testInfo.attach('closed-page-transports', {
              body: JSON.stringify(
                closedPages.map(page => ({
                  transportEvents: transport.snapshot(page),
                })),
              ),
              contentType: 'application/json',
            });
          }

          for (const [index, page] of [...watched]
            .flatMap(c => c.pages())
            .slice(0, 5)
            .entries()) {
            // A broken page must not mask the original failure or stall teardown.
            let timer: ReturnType<typeof setTimeout> | undefined;

            try {
              const state = await Promise.race([
                collectFailureState(page),
                new Promise(resolve => {
                  timer = setTimeout(
                    () => resolve({ unavailable: 'page did not respond' }),
                    2000,
                  );
                }),
              ]);
              await testInfo.attach(`failure-state-${index}`, {
                body: JSON.stringify(
                  { state, transportEvents: transport.snapshot(page) },
                  null,
                  2,
                ),
                contentType: 'application/json',
              });
            } catch {
              // Closed/crashed pages are already represented in the trace.
            } finally {
              clearTimeout(timer);
            }
          }
        }

        // Match Playwright's default-context teardown for extra test-owned
        // contexts. Otherwise their live tabs leak into the next test.
        await Promise.all(
          [...ownedContexts].map(context =>
            context.close().catch(() => undefined),
          ),
        );

        if (entries.length || expectations.length) {
          await testInfo.attach('browser-diagnostics', {
            body: JSON.stringify(
              {
                entries,
                expectations,
              },
              null,
              2,
            ),
            contentType: 'application/json',
          });
        }

        expect(
          unexpected.slice(0, 20),
          `Unexpected browser warnings/errors (${unexpected.length}); first 20 shown, full browser-diagnostics attached`,
        ).toEqual([]);
        expect(missing, 'Expected diagnostic count did not match').toEqual([]);
      }
    },
    { auto: true },
  ],
});

export default test;

/** Isolated UI fixtures do not depend on the public discovery service.
 *
 * The host list has to track `defaultPeerSignalingUrl`
 * (data-browser/src/helpers/browserPeerSync.ts), which picks the SaaS portal
 * for the origin the app is served from. It answers `atomic.place` for every
 * origin except staging, and an e2e app is served from localhost, so that is
 * the one this fixture meets. When #1699 introduced that default the pattern
 * here still named `atomicserver.eu` alone, the stub stopped matching, and
 * every context dialled production instead: a single unroutable websocket
 * that the diagnostics fixture turns into a console error, failing tests that
 * have nothing to do with peers. Twelve of nineteen in a five-spec mix here,
 * three runs of three, on meetings, saved-drives, second-device-load and
 * sign-in-without-data.
 *
 * It only shows up where that host is unreachable. On a machine that CAN
 * reach atomic.place the socket connects, nothing is logged, and the suite
 * looks fine while quietly depending on the public service this fixture
 * exists to remove. That is the more expensive half of the bug, and it is why
 * the hosts are matched by name rather than the whole path pattern: a local
 * signaling server, which some setups point at, must still reach its socket.
 */
export async function installEmptyDiscoveryRoom(context: BrowserContext) {
  await context.routeWebSocket(
    /^wss:\/\/(?:(?:staging\.)?atomicserver\.eu|atomic\.place)\/webrtc-signal$/,
    socket => {
      socket.onMessage(message => {
        if (
          typeof message === 'string' &&
          JSON.parse(message).type === 'join'
        ) {
          socket.send(
            JSON.stringify({ type: 'joined', peers: [], iceServers: [] }),
          );
        }
      });
    },
  );
}
