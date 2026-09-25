import { isViewRequest } from '@tomic/plugin';
import { viewSession } from '@helpers/extensions/viewSession';
import { useEffect, useRef, useState } from 'react';
import { styled } from 'styled-components';
import { errorMessageFromResponse, signRequest, useStore } from '@tomic/react';
import { findSchema, pluginSchema } from '@tomic/lib';
import { FrameBridge } from '@helpers/extensions/FrameBridge';
import {
  handleRequest,
  isHostRequest,
  resolveAppImporter,
  resourceToOpen,
  type HostReply,
} from './hostStore';
import {
  checkExternalLink,
  openInNewTab,
} from '@helpers/extensions/externalLink';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { paths } from '../../routes/paths';
import { AppImporterRun, type ImporterAsk } from './AppImporterRun';
import { describePluginSource } from '@chunks/PluginRuns/runScript';
import { LoaderBlock } from '@components/Loader';
import { Button } from '@components/Button';
import { Row } from '@components/Row';
import { newContextItem, useAISidebar } from '@components/AI/AISidebarContext';
import type { AIAtomicResourceMessageContext } from '@chunks/AI/types';

import resetCss from '../../reset.css?raw';
import {
  useCreateThemeVars,
  useFrameColorScheme,
} from '@views/PluginView/useCreateThemeVars';
import { getIntegrationProxy } from '@helpers/integrationProxy';
import {
  isPlatformId,
  platformName,
  ProxyConnections,
  type ProxyConnection,
} from '@helpers/proxyConnections';
import { ProxyConsentBar, ProxyConsentText } from '@components/ProxyConsentBar';
import { appAgentOf } from './appAgent';
import { grantRowAccess, rowAccessQuestion } from './rowGrant';
import { RowGrantText } from './RowGrantText';
import { registerRuntimesInBackground } from '@helpers/useInstallationRuntimes';

const IMPORT_WAITING = 'An import from this app is already waiting for you.';

/** Changing installation or destination must discard source tokens and pending replies. */
export function AppFrame(props: Parameters<typeof AppFrameSession>[0]) {
  return (
    <AppFrameSession
      key={JSON.stringify([props.app, props.drive, props.table])}
      {...props}
    />
  );
}

/**
 * Renders an app's view, which lives in the drive rather than on the server's
 * filesystem.
 *
 * The iframe is null-origin, so it cannot sign a request for its own source —
 * the authenticated page mints it a short-lived capability instead and puts it
 * in the URL. Loading via `src` rather than `srcdoc` matters for the same
 * reason it does for installed plugins: a `srcdoc`, `blob:` or `data:` frame
 * inherits this page's CSP and the app's script would be blocked.
 */
function AppFrameSession({
  app,
  drive,
  table,
  view,
  onOutcome,
  silent,
}: {
  app: string;
  drive: string;
  /**
   * The View (tab) showing this app on `table`. An app that asks to edit the
   * table's rows gets a grant tied to this view, so removing the tab takes
   * it back.
   */
  view?: string;
  /**
   * The table this app is a view of, when it is being used as one.
   *
   * Without it an app reads its own rows. With it, the same app can be
   * pointed at rows someone already has — which is the difference between an
   * app that owns its data and an app that is a way of looking at data.
   */
  table?: string;
  /**
   * Told once, when the app either finishes rendering or fails.
   *
   * This is what lets something other than a person watch an app run — the
   * check that happens right after a model writes one, before it reports
   * success.
   */
  onOutcome?: (outcome: AppOutcome) => void;
  /** Report the outcome, but do not draw the error bar. For an unattended run. */
  silent?: boolean;
}): React.JSX.Element {
  const store = useStore();
  const [src, setSrc] = useState<string>();
  const [entrypoint, setEntrypoint] = useState<string | null>();
  const [problem, setProblem] = useState<string>();
  const [appError, setAppError] = useState<AppError>();
  // An app asking to connect a proxy platform. Drawn by this page, not the
  // frame, so only a click the person makes here can navigate away.
  const [connectAsk, setConnectAsk] = useState<ConnectAsk>();
  const connectAskRef = useRef<ConnectAsk | undefined>(undefined);
  // An app asking to open a link outside the drive. Same rule: only a click
  // here opens it, so the frame never needs popup rights.
  const [externalAsk, setExternalAsk] = useState<ExternalAsk>();
  const externalAskRef = useRef<ExternalAsk | undefined>(undefined);
  const navigate = useNavigateWithTransition();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  // An app asking to run its own importer: a picker and a review, both drawn
  // by this page. One at a time, so a review is never swapped out under the
  // person.
  const [importerAsk, setImporterAsk] = useState<ImporterAsk>();
  const importerAskRef = useRef<ImporterAsk | undefined>(undefined);
  // An app asking to edit the table's rows (#1740). Drawn by this page, and
  // only a click here grants it.
  const [rowAsk, setRowAsk] = useState<RowAsk>();
  const rowAskRef = useRef<RowAsk | undefined>(undefined);
  const { askAI } = useAISidebar();
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Held in a ref so an inline callback does not tear down the listener — and
  // with it every subscription — on each render.
  const onOutcomeRef = useRef(onOutcome);
  onOutcomeRef.current = onOutcome;
  // Subject to the store's unsubscribe, so a view that re-renders does not
  // accumulate a listener per render and get told about one change N times.
  const bridgeRef = useRef<FrameBridge | undefined>(undefined);
  const stylesheet = useCreateThemeVars();
  const colorScheme = useFrameColorScheme();

  // Which plugin renders it. Resolved here rather than by each caller: a
  // table tab and an app page both need it, and two copies would drift.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const schema = await findSchema(store, drive, pluginSchema());
      const property = schema.properties?.entrypoint;
      // Read through the store rather than from a passed resource, so this
      // depends on a subject string instead of a proxy whose identity churns.
      const resource = await store.getResource(app);
      const found = property
        ? (resource.get(property) as string | undefined)
        : undefined;

      if (!cancelled) setEntrypoint(found ?? null);
    })().catch(() => {
      if (!cancelled) setEntrypoint(null);
    });

    return () => {
      cancelled = true;
    };
  }, [store, drive, app]);

  // An Installation's nodes act for its app id at the proxy only once they
  // are registered as its runtimes. Covers coming back from a connect
  // handoff, which delegates and then reloads this page. A no-op for
  // `createApp` apps.
  useEffect(() => {
    registerRuntimesInBackground(store, app);
  }, [store, app]);

  useEffect(() => {
    if (!entrypoint) return;

    let cancelled = false;

    mintViewToken(store, drive, entrypoint)
      .then(result => {
        if (cancelled) return;

        if (!result.ok) {
          setProblem(result.error);

          return;
        }

        const query = new URLSearchParams({
          drive,
          plugin: entrypoint,
          token: result.token,
          format: 'html',
        });
        setSrc(`${store.getServerUrl()}/plugin-ui?${query.toString()}`);
      })
      .catch((e: Error) => {
        if (!cancelled) setProblem(e.message);
      });

    return () => {
      cancelled = true;
    };
  }, [store, drive, entrypoint, app]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const bridge = new FrameBridge(frame, (wire, originalSession) => {
      const canonical = isViewRequest(wire);
      const data = canonical
        ? { ...wire.args, __atomic: true, id: wire.id, op: wire.op }
        : wire;
      const session = canonical
        ? viewSession(originalSession, wire.id)
        : originalSession;
      const message = data as Record<string, unknown>;

      if (message.type === '__atomic_plugin_error') {
        const failure: AppError = {
          message: String(message.message ?? 'Something went wrong.'),
          stack: typeof message.stack === 'string' ? message.stack : undefined,
          phase: message.phase === 'load' ? 'load' : 'runtime',
        };
        setAppError(failure);
        onOutcomeRef.current?.({ ok: false, ...failure });

        return;
      }

      if (message.type === '__atomic_plugin_rendered') {
        onOutcomeRef.current?.({
          ok: true,
          children: typeof message.children === 'number' ? message.children : 0,
        });

        return;
      }

      if (!isHostRequest(data)) return;

      if (data.op === 'proxyConnect') {
        if (!isPlatformId(data.platform)) {
          session.post({ id: data.id, error: 'platform is required' });

          return;
        }

        // One question at a time; a second ask answers the first.
        const previous = connectAskRef.current;
        previous?.reply({ id: previous.id, result: { status: 'cancelled' } });
        const ask: ConnectAsk = {
          id: data.id,
          platform: data.platform!,
          reply: session.post,
        };
        connectAskRef.current = ask;
        setConnectAsk(ask);

        // Offer a connection the person already has for this platform, so
        // using it for one more app needs no second trip through OAuth.
        existingConnections(store, data.platform!)
          .then(existing => {
            if (connectAskRef.current !== ask || existing.length === 0) return;
            const withExisting = { ...ask, existing };
            connectAskRef.current = withExisting;
            setConnectAsk(withExisting);
          })
          .catch(() => undefined);

        return;
      }

      if (data.op === 'requestRowAccess') {
        const previous = rowAskRef.current;
        previous?.reply({
          id: previous.id,
          result: { status: 'denied', reason: /* @wc-ignore */ 'Asked again' },
        });
        rowAskRef.current = undefined;
        setRowAsk(undefined);

        rowAccessQuestion(store, { app, drive, table, view }, () =>
          appLabel(store, app),
        )
          .then(outcome => {
            if (outcome.ask === false) {
              session.post({ id: data.id, result: outcome.result });

              return;
            }

            const ask: RowAsk = {
              id: data.id,
              appName: outcome.appName,
              reply: session.post,
            };
            rowAskRef.current = ask;
            setRowAsk(ask);
          })
          .catch((e: Error) => session.post({ id: data.id, error: e.message }));

        return;
      }

      if (data.op === 'openExternal') {
        const link = checkExternalLink(data.url);

        if ('error' in link) {
          session.post({ id: data.id, error: link.error });

          return;
        }

        const { url } = link;
        // One question at a time; a second ask answers the first.
        const previous = externalAskRef.current;
        previous?.reply({ id: previous.id, result: { status: 'cancelled' } });
        const ask: ExternalAsk = { id: data.id, url, reply: session.post };
        externalAskRef.current = ask;
        setExternalAsk(ask);

        return;
      }

      if (data.op === 'openResource') {
        resourceToOpen(store, data.subject)
          .then(subject => {
            session.post({
              id: data.id,
              result: { status: 'opened', subject },
            });
            void navigateRef.current(
              `${paths.show}?${new URLSearchParams({ subject })}`,
            );
          })
          .catch((e: Error) => session.post({ id: data.id, error: e.message }));

        return;
      }

      if (data.op === 'runImporter') {
        if (importerAskRef.current) {
          session.post({
            id: data.id,
            error: IMPORT_WAITING,
          });

          return;
        }

        resolveAppImporter(store, drive, table, data, describePluginSource)
          .then(resolved => {
            if (importerAskRef.current) {
              session.post({
                id: data.id,
                error: IMPORT_WAITING,
              });

              return;
            }

            const ask: ImporterAsk = {
              id: data.id,
              resolved,
              reply: session.post,
            };
            importerAskRef.current = ask;
            setImporterAsk(ask);
          })
          .catch((e: Error) => session.post({ id: data.id, error: e.message }));

        return;
      }

      if (data.op === 'subscribe' && typeof data.subject === 'string') {
        const subject = data.subject;
        session.watch(subject, () =>
          store.subscribe(subject, () =>
            session.post({ __atomicChanged: subject }),
          ),
        );
        session.post({ id: data.id, result: true });

        return;
      }

      if (data.op === 'unsubscribe' && typeof data.subject === 'string') {
        session.unwatch(data.subject);
        session.post({ id: data.id, result: true });

        return;
      }

      void answer(store, app, drive, table, data, session.post);
    });
    bridgeRef.current = bridge;

    return () => {
      bridge.close();
      bridgeRef.current = undefined;
    };
  }, [store, app, drive, table, view, src]);

  useEffect(() => {
    bridgeRef.current?.setStyle(`${resetCss}\n${stylesheet}`, colorScheme);
  }, [stylesheet, colorScheme, src]);

  // The app never got as far as running: no token, no entry point, no source.
  // Reported as a failure like any other, so a caller waiting on an outcome
  // hears now rather than sitting out the timeout for a verdict of "unknown".
  useEffect(() => {
    if (problem !== undefined) {
      onOutcomeRef.current?.({ ok: false, phase: 'load', message: problem });
    } else if (entrypoint === null) {
      onOutcomeRef.current?.({
        ok: false,
        phase: 'load',
        message:
          /* @wc-ignore */ 'This app has no entry point, so there is nothing to run.',
      });
    }
  }, [problem, entrypoint]);

  if (problem !== undefined) {
    return <Problem>{problem}</Problem>;
  }

  if (entrypoint === null) {
    return (
      <Problem>
        This app has no entry point, so there is nothing to open.
      </Problem>
    );
  }

  if (src === undefined) {
    return <LoaderBlock />;
  }

  const finishAsk = (reply: HostReply) => {
    connectAsk?.reply(reply);
    connectAskRef.current = undefined;
    setConnectAsk(undefined);
  };

  const connect = () => {
    if (!connectAsk) return;

    if (!store.getAgent()) {
      finishAsk({ id: connectAsk.id, error: 'Sign in to connect an account.' });

      return;
    }

    (async () => {
      const appAgent = await appAgentOf(store, { drive, app });

      return proxyConnections(store).start(
        { drive, app, appAgent },
        connectAsk.platform,
        location.href,
        await appLabel(store, app),
      );
    })()
      .then(url => location.assign(url))
      .catch((e: Error) => finishAsk({ id: connectAsk.id, error: e.message }));
  };

  const pickExisting = (connection: ProxyConnection) => {
    if (!connectAsk) return;

    (async () => {
      const appAgent = await appAgentOf(store, { drive, app });
      await proxyConnections(store).delegate(
        connection.connection_id,
        appAgent,
        await appLabel(store, app),
      );
    })()
      .then(() => {
        // An Installation's nodes act for its app id only once registered
        // as runtimes; not waited on, failures are toasted.
        registerRuntimesInBackground(store, app);
        finishAsk({
          id: connectAsk.id,
          result: {
            status: 'connected',
            connectionId: connection.connection_id,
            platform: connection.platform,
          },
        });
      })
      .catch((e: Error) => finishAsk({ id: connectAsk.id, error: e.message }));
  };

  const finishExternal = (status: 'opened' | 'cancelled') => {
    if (!externalAsk) return;

    // Opened from this click, so the browser allows the new tab without the
    // frame ever holding popup rights.
    if (status === 'opened') openInNewTab(externalAsk.url);
    externalAsk.reply({ id: externalAsk.id, result: { status } });
    externalAskRef.current = undefined;
    setExternalAsk(undefined);
  };

  const externalHost = externalAsk?.url.host;

  const cancelConnect = () => {
    if (!connectAsk) return;
    finishAsk({ id: connectAsk.id, result: { status: 'cancelled' } });
  };

  const finishRowAsk = (reply: HostReply) => {
    rowAsk?.reply(reply);
    rowAskRef.current = undefined;
    setRowAsk(undefined);
  };

  const allowRows = () => {
    if (!rowAsk || !table || !view) return;

    grantRowAccess(store, { drive, table, app, view, via: 'request' })
      .then(() =>
        finishRowAsk({ id: rowAsk.id, result: { status: 'granted' } }),
      )
      .catch((e: Error) =>
        finishRowAsk({
          id: rowAsk.id,
          result: { status: 'denied', reason: e.message },
        }),
      );
  };

  const declineRows = () => {
    if (!rowAsk) return;
    finishRowAsk({
      id: rowAsk.id,
      result: {
        status: 'denied',
        reason: /* @wc-ignore */ 'The person said no',
      },
    });
  };

  const fixIt = () => {
    if (!appError) return;

    askAI({
      // Written as what the user would say, because it becomes the first
      // message of the chat and they have to be able to read it back.
      prompt: /* @wc-ignore */ [
        'The app I have open just hit an error. Read its source with',
        'describe_app, work out what went wrong, and fix it with update_app.',
        '',
        `Error (${appError.phase === 'load' ? 'while opening the app' : 'while using it'}): ${appError.message}`,
        ...(appError.stack ? ['', 'Stack:', appError.stack] : []),
      ].join('\n'),
      context: [
        newContextItem<AIAtomicResourceMessageContext>({
          type: 'atomic-resource',
          subject: app,
        }),
      ],
    });
  };

  return (
    <Wrapper>
      {appError && !silent && (
        <ErrorBar role='alert'>
          <ErrorText>
            <strong>This app hit an error.</strong> {appError.message}
          </ErrorText>
          <Row gap='0.5rem'>
            <Button onClick={fixIt}>Fix it</Button>
            <Button subtle onClick={() => setAppError(undefined)}>
              Dismiss
            </Button>
          </Row>
        </ErrorBar>
      )}
      {connectAsk && (
        <ProxyConsentBar aria-label='Connect an account'>
          <ProxyConsentText>
            This app wants to use your{' '}
            <strong>{platformName(connectAsk.platform)}</strong> account through{' '}
            {getIntegrationProxy()}. The proxy keeps the connection under your
            account; this app may use it until you revoke that.
          </ProxyConsentText>
          <Row gap='0.5rem'>
            {connectAsk.existing?.[0] && (
              <Button onClick={() => pickExisting(connectAsk.existing![0])}>
                Use existing connection
              </Button>
            )}
            <Button subtle={!!connectAsk.existing?.length} onClick={connect}>
              Connect
            </Button>
            <Button subtle onClick={cancelConnect}>
              Cancel
            </Button>
          </Row>
        </ProxyConsentBar>
      )}
      {externalAsk && (
        <ProxyConsentBar aria-label='Open a link'>
          <ProxyConsentText>
            This app wants to open <Host>{externalHost}</Host> in a new tab.
            <ExternalUrl>{externalAsk.url.href}</ExternalUrl>
          </ProxyConsentText>
          <Row gap='0.5rem'>
            <Button onClick={() => finishExternal('opened')}>Open link</Button>
            <Button subtle onClick={() => finishExternal('cancelled')}>
              Cancel
            </Button>
          </Row>
        </ProxyConsentBar>
      )}
      {rowAsk && (
        <ProxyConsentBar aria-label='Let this app edit rows'>
          <ProxyConsentText>
            <RowGrantText appName={rowAsk.appName} />
          </ProxyConsentText>
          <Row gap='0.5rem'>
            <Button onClick={allowRows}>Allow editing</Button>
            <Button subtle onClick={declineRows}>
              Not now
            </Button>
          </Row>
        </ProxyConsentBar>
      )}
      {importerAsk && (
        <AppImporterRun
          key={String(importerAsk.id)}
          ask={importerAsk}
          drive={drive}
          onDone={() => {
            importerAskRef.current = undefined;
            setImporterAsk(undefined);
          }}
        />
      )}
      <Frame
        ref={frameRef}
        src={src}
        // `allow-modals` because confirm() and alert() are the first things
        // an app reaches for to guard a delete, and without it they return
        // false silently — the button does nothing and nothing says why. Still
        // no allow-same-origin, so the frame stays null-origin and cannot
        // touch this page.
        sandbox='allow-scripts allow-modals'
        title='App'
      />
    </Wrapper>
  );
}

/** How a run of an app ended. */
export type AppOutcome =
  | { ok: true; children: number }
  | ({ ok: false } & AppError);

/** What the frame told us went wrong. */
export interface AppError {
  message: string;
  stack?: string;
  /** Whether the app failed to open at all, or broke while being used. */
  phase: 'load' | 'runtime';
}

/**
 * Serving one request, shaped so failures come back to the app as errors it
 * can render rather than as a promise nobody is watching.
 */
async function answer(
  store: ReturnType<typeof useStore>,
  app: string,
  drive: string,
  table: string | undefined,
  request: Parameters<typeof handleRequest>[3],
  post: (reply: HostReply) => void,
): Promise<void> {
  try {
    post({
      id: request.id,
      result: await handleRequest(
        store,
        app,
        drive,
        request,
        table,
        proxyHost(store, app, drive),
      ),
    });
  } catch (e) {
    post({ id: request.id, error: (e as Error).message });
  }
}

/** The configured proxy, managed with the signed-in user's key. */
function proxyConnections(store: ReturnType<typeof useStore>) {
  return new ProxyConnections(localStorage, getIntegrationProxy(), () =>
    store.getAgent(),
  );
}

/**
 * Each app's agent, looked up once per page. A failed lookup is forgotten so
 * the next request tries again (the app may get an identity meanwhile).
 */
const appAgents = new Map<string, Promise<string>>();

function cachedAppAgent(
  store: ReturnType<typeof useStore>,
  drive: string,
  app: string,
): Promise<string> {
  const key = JSON.stringify([store.getServerUrl(), drive, app]);
  let found = appAgents.get(key);

  if (!found) {
    found = appAgentOf(store, { drive, app });
    found.catch(() => appAgents.delete(key));
    appAgents.set(key, found);
  }

  return found;
}

/** This app's integration-proxy access, or none when signed out. */
function proxyHost(
  store: ReturnType<typeof useStore>,
  app: string,
  drive: string,
) {
  return store.getAgent()
    ? proxyConnections(store).host(() => cachedAppAgent(store, drive, app))
    : undefined;
}

/** The person's own connections for `platform`, most recently used first. */
async function existingConnections(
  store: ReturnType<typeof useStore>,
  platform: string,
): Promise<ProxyConnection[]> {
  if (!store.getAgent()) return [];
  const rows = await proxyConnections(store).list(platform);

  return rows.sort((a, b) =>
    String(b.last_used_at ?? b.created_at ?? '').localeCompare(
      String(a.last_used_at ?? a.created_at ?? ''),
    ),
  );
}

/** What a delegation is labelled with at the proxy: the app's name. */
async function appLabel(
  store: ReturnType<typeof useStore>,
  app: string,
): Promise<string> {
  try {
    return (await store.getResource(app)).title || app;
  } catch {
    return app;
  }
}

interface RowAsk {
  id: number | string;
  appName: string;
  reply: (reply: HostReply) => void;
}

interface ConnectAsk {
  id: number | string;
  platform: string;
  reply: (reply: HostReply) => void;
  /** Connections the person already has for this platform. */
  existing?: ProxyConnection[];
}

interface ExternalAsk {
  id: number | string;
  url: URL;
  reply: (reply: HostReply) => void;
}

type MintResult = { ok: true; token: string } | { ok: false; error: string };

/**
 * Asking for the capability, shaped as a result rather than an exception: the
 * React Compiler cannot compile try/catch inside a component, and this is
 * called from one.
 */
async function mintViewToken(
  store: ReturnType<typeof useStore>,
  drive: string,
  plugin: string,
): Promise<MintResult> {
  const agent = store.getAgent();

  if (!agent) return { ok: false, error: 'Sign in to open this app.' };

  const url = `${store.getServerUrl()}/plugin-view-token`;

  try {
    const headers = await signRequest(url, agent, {});
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ drive, plugin }),
    });

    if (!response.ok) {
      return {
        ok: false,
        error: errorMessageFromResponse(await response.text(), response.status),
      };
    }

    const body = (await response.json()) as { token: string };

    return { ok: true, token: body.token };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const Frame = styled.iframe`
  border: none;
  width: 100%;
  /* An iframe never grows to fit its document: whatever height it is given is
   * the height the app gets, and anything taller is clipped. So take the whole
   * box the caller sized, and let the app scroll inside it. Both callers hand
   * it a sized box; the floor is only for the case where one forgets. */
  flex: 1;
  height: 100%;
  min-height: 20rem;
  background: ${p => p.theme.colors.bg};
`;

/** Keeps the frame filling whatever is left once the bar has taken its height. */
const Wrapper = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
`;

/**
 * Sits above the app rather than replacing it: an app that threw in one button
 * is usually still readable, and throwing away what the user can see is a
 * worse trade than showing a bar over it.
 */
const ErrorBar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 0.5rem 0.75rem;
  border: 1px solid ${p => p.theme.colors.alert};
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg1};
  margin-bottom: 0.5rem;
`;

const ErrorText = styled.span`
  color: ${p => p.theme.colors.textLight};
  overflow-wrap: anywhere;
  min-width: 0;
`;

/** The destination host, in full: what the person is deciding about. */
const Host = styled.strong``;

/** The whole link, under the host, for anyone who wants to check the path. */
const ExternalUrl = styled.span`
  display: block;
  font-size: 0.85em;
  overflow-wrap: anywhere;
`;

const Problem = styled.p`
  color: ${p => p.theme.colors.alert};
`;
