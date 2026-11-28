import { useEffect, useState } from 'react';
import { useCurrentAgent, useServerURL, useStore } from '@tomic/react';
import { useIntegrationProxy } from '@helpers/integrationProxy';
import { AppFrame, type AppFrameProfile } from '@chunks/AppPage/AppFrame';
import { appProfile } from './builtinSyncablesProfile';

export function BuiltinSyncablesApp({
  table,
  drive,
}: {
  table: string;
  drive: string;
}) {
  const store = useStore();
  const [actor] = useCurrentAgent();
  const [server] = useServerURL();
  const origin = useIntegrationProxy();
  const key = JSON.stringify([drive, table, actor?.subject, server, origin]);
  const [state, setState] = useState<{
    key: string;
    profile?: AppFrameProfile;
    error?: string;
  }>();

  useEffect(() => {
    const controller = new AbortController();
    void appProfile(store, drive, table, controller.signal).then(
      profile => {
        if (!controller.signal.aborted) setState({ key, profile });
      },
      (reason: unknown) => {
        if (!controller.signal.aborted)
          setState({
            key,
            error: reason instanceof Error ? reason.message : String(reason),
          });
      },
    );

    return () => controller.abort();
  }, [store, drive, table, key]);

  if (state?.key !== key) return <p role='status'>Opening integration…</p>;
  if (state.error) return <p role='alert'>{state.error}</p>;
  if (!state.profile) return <p role='status'>Opening integration…</p>;

  return (
    <AppFrame key={key} app={table} drive={drive} profile={state.profile} />
  );
}
