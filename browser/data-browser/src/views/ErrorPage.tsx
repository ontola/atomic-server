import * as React from 'react';
import { isUnauthorized, useStore } from '@tomic/react';
import { useLocation } from '@tanstack/react-router';
import { ContainerWide } from '../components/Containers';
import { ErrorBlock } from '../components/ErrorLook';
import { Button } from '../components/Button';
import { SignInButton } from '../components/SignInButton';
import { useSettings } from '../helpers/AppSettings';
import { ResourcePageProps } from './ResourcePage';
import { Column, Row } from '../components/Row';
import CrashPage from './CrashPage';
import { clearAllLocalData } from '../helpers/clearData';
import { AtomicLink } from '../components/AtomicLink';
import { paths } from '../routes/paths';
import { isRootWelcomeResourceError } from '../helpers/isRootWelcomeResourceError';
import { RootWelcomeGate } from './RootWelcomeGate';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';

import type { JSX } from 'react';

/**
 * A View for Resource Errors. Not to be confused with the CrashPage, which is
 * for App wide errors.
 */
function ErrorPage({ resource }: ResourcePageProps): JSX.Element {
  const { agent, baseURL } = useSettings();
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const location = useLocation();

  const shouldGoToWelcome =
    (!agent && isRootWelcomeResourceError(resource, agent, baseURL)) ||
    (!agent && isUnauthorized(resource.error));

  React.useEffect(() => {
    if (!shouldGoToWelcome) return;
    if (location.pathname === paths.welcome) return;

    navigate({ to: paths.welcome, replace: true });
  }, [location.pathname, navigate, shouldGoToWelcome]);

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
          <Button
            title='Clear all local data & refresh page'
            onClick={clearAllLocalData}
          >
            Hard reset
          </Button>
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
