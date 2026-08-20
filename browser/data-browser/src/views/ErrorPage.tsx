import * as React from 'react';
import { isUnauthorized, useStore } from '@tomic/react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { ContainerWide } from '../components/Containers';
import { ErrorBlock } from '../components/ErrorLook';
import { Button } from '../components/Button';
import { SignInButton } from '../components/SignInButton';
import { useSettings } from '../helpers/AppSettings';
import { ResourcePageProps } from './ResourcePage';
import { Column, Row } from '../components/Row';
import CrashPage from './CrashPage';
import { AtomicLink } from '../components/AtomicLink';
import { paths } from '../routes/paths';
import { isRootWelcomeResourceError } from '../helpers/isRootWelcomeResourceError';
import { isDriveSignInError } from '../helpers/isDriveSignInError';
import { RootWelcomeGate } from './RootWelcomeGate';
import { readKnownPeers } from '../helpers/knownPeers';
import { parseDidOpenInput, resolveDidForOpen } from '../helpers/didResolve';

import type { JSX } from 'react';

/**
 * A View for Resource Errors. Not to be confused with the CrashPage, which is
 * for App wide errors.
 */
function ErrorPage({ resource }: ResourcePageProps): JSX.Element {
  const { agent, baseURL, drive } = useSettings();
  const store = useStore();
  const navigate = useNavigate();
  const location = useLocation();
  const knownPeers = readKnownPeers();
  const [peerStatus, setPeerStatus] = React.useState<string | null>(null);
  const [tryingPeers, setTryingPeers] = React.useState(false);

  const isHomeWelcome = isRootWelcomeResourceError(resource, agent, baseURL);
  // Not signed in + can't read this (non-home) resource → send to the welcome
  // panel's sign-in step, carrying the resource as `next` so we return the user
  // here once they sign in. (Already signed in? No redirect — that agent just
  // lacks access, handled below.)
  const isDriveSignIn = isDriveSignInError(resource, agent, baseURL);
  const shouldGoToWelcome = (!agent && isHomeWelcome) || isDriveSignIn;

  React.useEffect(() => {
    if (!shouldGoToWelcome) return;
    if (location.pathname === paths.welcome) return;

    navigate({
      to: paths.welcome,
      search: {
        next: isDriveSignIn ? resource.subject : undefined,
        from_portal: undefined,
      },
      replace: true,
    });
  }, [
    location.pathname,
    navigate,
    shouldGoToWelcome,
    isDriveSignIn,
    resource.subject,
  ]);

  const tryKnownDevices = () => {
    setTryingPeers(true);
    setPeerStatus(null);
    const hints = parseDidOpenInput(resource.subject);

    void resolveDidForOpen(resource.subject, {
      drive,
      agent: hints?.agent,
      node: hints?.node,
      tryPeers: true,
      isAvailable: async subject => {
        try {
          const next = await store.getResource(subject);

          return !next.error;
        } catch {
          return false;
        }
      },
    }).then(result => {
      setTryingPeers(false);

      if (result.ok) {
        setPeerStatus(`Found via ${result.via}. Reloading…`);
        store.fetchResourceFromServer(resource.subject, { setLoading: true });
      } else {
        setPeerStatus(result.message);
      }
    });
  };

  if (isRootWelcomeResourceError(resource, agent, baseURL)) {
    // Redirect effect above will handle the URL; render something safe meanwhile.
    return <RootWelcomeGate subject={baseURL || resource.subject} />;
  }

  if (isUnauthorized(resource.error)) {
    if (!agent) {
      // Redirect effect above will handle the URL.
      return <RootWelcomeGate subject={baseURL || resource.subject} />;
    }

    return (
      <ContainerWide>
        <Column>
          <h1>Unauthorized</h1>
          {agent ? (
            <>
              <ErrorBlock error={resource.error!} />
              <span>
                <Button
                  onClick={() =>
                    store.fetchResourceFromServer(resource.subject)
                  }
                >
                  Retry
                </Button>
              </span>
            </>
          ) : (
            <>
              <p>{"You don't have access to this, try signing in:"}</p>
              <SignInButton />
            </>
          )}
        </Column>
      </ContainerWide>
    );
  }

  const showTryPeers =
    resource.subject.startsWith('did:ad:') && knownPeers.length > 0;

  return (
    <ContainerWide>
      <Column>
        <h1>Could not open {resource.subject}</h1>
        <ErrorBlock error={resource.error!} />
        {resource.subject === baseURL && (
          <p>
            If you have not set up an identity on this server yet,{' '}
            <AtomicLink path={paths.onboarding}>create one here</AtomicLink>.
          </p>
        )}
        {resource.subject.startsWith('did:ad:') && knownPeers.length === 0 && (
          <p>
            This DID is not on this device. Pair a device on the{' '}
            <AtomicLink path={paths.sync}>Sync</AtomicLink> page, or open a link
            that includes an <code>agent</code> or <code>node</code> hint.
          </p>
        )}
        {peerStatus && <p>{peerStatus}</p>}
        <Row>
          <Button
            onClick={() =>
              store.fetchResourceFromServer(resource.subject, {
                setLoading: true,
              })
            }
          >
            Retry
          </Button>
          {showTryPeers && (
            <Button
              onClick={tryKnownDevices}
              disabled={tryingPeers}
              title='Dial every paired device and pull this resource’s zone/drive'
            >
              {tryingPeers
                ? 'Trying known devices…'
                : `Try ${knownPeers.length} known device${knownPeers.length === 1 ? '' : 's'}`}
            </Button>
          )}
          <Button
            onClick={() =>
              store.fetchResourceFromServer(resource.subject, {
                fromProxy: true,
                setLoading: true,
              })
            }
            title={`Fetches the URL from your current Atomic-Server (${store.getServerUrl()}), instead of from the actual URL itself. Can be useful if the URL is down, but the resource is cached in your server.`}
          >
            Use proxy
          </Button>
        </Row>
      </Column>
    </ContainerWide>
  );
}

export default ErrorPage;

interface ErrorBoundaryProps {
  children: React.ReactNode;
  FallBackComponent?: React.ComponentType<{ error: Error }>;
}

interface ErrorBoundaryState {
  error?: Error;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  public constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: undefined };
  }

  public static getDerivedStateFromError(error: Error) {
    // Update state so the next render will show the fallback UI.
    return { error };
  }

  public render() {
    if (this.state.error) {
      if (this.props.FallBackComponent) {
        return <this.props.FallBackComponent error={this.state.error} />;
      }

      return (
        <CrashPage
          error={this.state.error}
          clearError={() => this.setState({ error: undefined })}
          info={{} as React.ErrorInfo}
        />
      );
    }

    return this.props.children;
  }
}
