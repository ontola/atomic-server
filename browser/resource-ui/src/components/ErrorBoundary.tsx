import React from 'react';
import { useResourceUIHost } from '../ResourceUIHost.js';
interface ErrorBoundaryProps {
  children: React.ReactNode;
  FallBackComponent?: React.ComponentType<{ error: Error }>;
}

function HostErrorFallback({
  error,
  clearError,
}: {
  error: Error;
  clearError: () => void;
}) {
  const { errorFallback: Fallback } = useResourceUIHost();

  return <Fallback error={error} clearError={clearError} />;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  { error?: Error }
> {
  public constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: undefined };
  }
  public static getDerivedStateFromError(error: Error) {
    return { error };
  }
  public render() {
    if (this.state.error) {
      if (this.props.FallBackComponent)
        return <this.props.FallBackComponent error={this.state.error} />;

      return (
        <HostErrorFallback
          error={this.state.error}
          clearError={() => this.setState({ error: undefined })}
        />
      );
    }

    return this.props.children;
  }
}
