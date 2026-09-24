import { isViewRequest } from '@tomic/plugin';
import { viewSession } from '@helpers/extensions/viewSession';
import { useEffect, useRef, useState } from 'react';
import { styled } from 'styled-components';
import { errorMessageFromResponse, signRequest, useStore } from '@tomic/react';
import { findSchema, pluginSchema } from '@tomic/lib';
import { FrameBridge } from '@helpers/extensions/FrameBridge';
import { handleRequest, isHostRequest, type HostReply } from './hostStore';
import { LoaderBlock } from '@components/Loader';
import { Button } from '@components/Button';
import { Row } from '@components/Row';
import { newContextItem, useAISidebar } from '@components/AI/AISidebarContext';
import type { AIAtomicResourceMessageContext } from '@chunks/AI/types';

import resetCss from '../../reset.css?raw';
import { useCreateThemeVars } from '@views/PluginView/useCreateThemeVars';
import { getIntegrationProxy } from '@helpers/integrationProxy';
import { isPlatformId, ProxyConnections } from '@helpers/proxyConnections';
import { ProxyTrafficNotice } from '@components/ProxyTrafficNotice';

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
  onOutcome,
  silent,
}: {
  app: string;
  drive: string;
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
        const ask = {
          id: data.id,
          platform: data.platform!,
          reply: session.post,
        };
        connectAskRef.current = ask;
        setConnectAsk(ask);

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
  }, [store, app, drive, table, src]);

  useEffect(() => {
    bridgeRef.current?.setStyle(`${resetCss}\n${stylesheet}`);
  }, [stylesheet, src]);

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

  const connect = () => {
    if (!connectAsk) return;
    const actor = store.getAgent()?.subject;

    if (!actor) {
      connectAsk.reply({
        id: connectAsk.id,
        error: 'Sign in to connect an account.',
      });
      connectAskRef.current = undefined;
      setConnectAsk(undefined);

      return;
    }

    new ProxyConnections(localStorage, getIntegrationProxy())
      .start({ drive, actor, app }, connectAsk.platform, location.href)
      .then(url => location.assign(url))
      .catch((e: Error) => {
        connectAsk.reply({ id: connectAsk.id, error: e.message });
        connectAskRef.current = undefined;
        setConnectAsk(undefined);
      });
  };

  const cancelConnect = () => {
    connectAsk?.reply({ id: connectAsk.id, result: { status: 'cancelled' } });
    connectAskRef.current = undefined;
    setConnectAsk(undefined);
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
        <ConnectBar role='group' aria-label='Connect an account'>
          <ConnectText>
            <ErrorText>
              This app wants to connect your{' '}
              <strong>{platformName(connectAsk.platform)}</strong> account. The
              connection stays in this browser; the app can only make requests
              through it.
            </ErrorText>
            <ProxyTrafficNotice />
          </ConnectText>
          <Row gap='0.5rem'>
            <Button onClick={connect}>Connect</Button>
            <Button subtle onClick={cancelConnect}>
              Cancel
            </Button>
          </Row>
        </ConnectBar>
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
        proxyRelay(store, app, drive),
      ),
    });
  } catch (e) {
    post({ id: request.id, error: (e as Error).message });
  }
}

/** This app's proxy connections in this page, or none when signed out. */
function proxyRelay(
  store: ReturnType<typeof useStore>,
  app: string,
  drive: string,
) {
  const actor = store.getAgent()?.subject;

  return actor
    ? new ProxyConnections(localStorage, getIntegrationProxy()).relay({
        drive,
        actor,
        app,
      })
    : undefined;
}

/** `pets` -> `Pets`, `github-issues` -> `Github Issues`. */
function platformName(id: string) {
  return id
    .split('-')
    .map(word => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ');
}

interface ConnectAsk {
  id: number | string;
  platform: string;
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

const ConnectBar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 0.5rem 0.75rem;
  border: 1px solid ${p => p.theme.colors.main};
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg1};
  margin-bottom: 0.5rem;
`;

const ConnectText = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  flex: 1 1 20rem;
  min-width: 0;
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

const Problem = styled.p`
  color: ${p => p.theme.colors.alert};
`;
