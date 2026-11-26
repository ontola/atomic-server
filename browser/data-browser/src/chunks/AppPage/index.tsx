import { styled } from 'styled-components';
import { useStore, type Resource } from '@tomic/react';
import { LoaderBlock } from '@tomic/ui/components/Loader';
import { AppFrame } from './AppFrame';
import { HostedLitewriteFrame } from './HostedLitewriteFrame';

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

  if (!drive) {
    return <LoaderBlock />;
  }

  // Development preview for a dedicated Litewrite app and its own table.
  const preview = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get('hostedPreview')
    : null;
  const origin = preview === 'litewrite-local'
    ? 'http://localhost:8000'
    : preview === 'litewrite'
      ? 'https://litewrite.pondersource.com'
      : undefined;

  return (
    <PageWrapper>
      {origin && origin !== window.location.origin ? (
        <HostedLitewriteFrame
          key={JSON.stringify([drive, resource.subject, origin])}
          app={resource.subject}
          drive={drive}
          origin={origin}
        />
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
 * out of room. No padding either: the app draws its own edges, and a margin
 * the app cannot remove only gets in its way.
 */
const PageWrapper = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
`;
