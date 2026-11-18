import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import { useStore, type Resource } from '@tomic/react';
import { LoaderBlock } from '@components/Loader';
import { AppFrame } from './AppFrame';
import { BuiltinSyncablesApp } from '@chunks/PluginRuns/BuiltinSyncablesApp';
import { resolveBuiltinApp, type BuiltinApp } from './builtinApp';

/**
 * An app opens to its view.
 *
 * By name, not by class: the App resource points at its entry point, so none
 * of the class resolution, view slots or precedence rules the class-to-view
 * path needs apply here.
 */
export function AppPage({
  resource,
}: {
  resource: Resource;
}): React.JSX.Element {
  const store = useStore();
  const drive = store.getDrive();
  const [resolved, setResolved] = useState<{
    subject: string;
    drive: string;
    app?: BuiltinApp;
    error?: string;
  }>();
  useEffect(() => {
    if (!drive) return;
    let cancelled = false;
    void resolveBuiltinApp(store, drive, resource.subject)
      .then(app => {
        if (!cancelled) setResolved({ subject: resource.subject, drive, app });
      })
      .catch(reason => {
        if (!cancelled)
          setResolved({
            subject: resource.subject,
            drive,
            error: String(reason?.message ?? reason),
          });
      });

    return () => {
      cancelled = true;
    };
  }, [store, drive, resource.subject]);

  if (
    !drive ||
    resolved?.subject !== resource.subject ||
    resolved.drive !== drive
  ) {
    return <LoaderBlock />;
  }

  return (
    <PageWrapper>
      {resolved.error ? (
        <p role='alert'>{resolved.error}</p>
      ) : resolved.app?.kind === 'syncables' ? (
        <BuiltinSyncablesApp table={resolved.app.table} drive={drive} />
      ) : (
        <AppFrame app={resource.subject} drive={drive} />
      )}
    </PageWrapper>
  );
}

/**
 * An app gets the whole page.
 *
 * Not ContainerFull: its bottom padding exists so a scrolling column of
 * resources clears the navigation bar, but a frame cannot grow into padding —
 * it would just leave a strip of empty page under an app that had already run
 * out of room.
 */
const PageWrapper = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: ${p => p.theme.size()};
`;
