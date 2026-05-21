import { useEffect, useState, lazy, Suspense } from 'react';
import {
  useResource,
  Resource,
  type OptionalClass,
  dataBrowser,
  collections,
  server,
  core,
  ai,
  useArray,
} from '@tomic/react';

import { ContainerNarrow } from '../components/Containers';
import Collection from '../views/CollectionPage';
import EndpointPage from './EndpointPage';
import DrivePage from './Drive/DrivePage';
import InvitePage from './InvitePage';
import { DocumentPage } from './DocumentPage';
import ErrorPage, { ErrorBoundary } from './ErrorPage';
import { ClassPage } from './ClassPage';
import { FilePage } from './File/FilePage';
import { ResourcePageDefault } from './ResourcePageDefault';
import { Spinner } from '../components/Spinner';
import { ChatRoomPage } from './ChatRoomPage';
import { MessagePage } from './MessagePage';
import { BookmarkPage } from './BookmarkPage/BookmarkPage';
import { ImporterPage } from './ImporterPage.jsx';
import { FolderPage } from './FolderPage';
import { ArticlePage } from './Article';
import { Main } from '../components/Main';
import { OntologyPage } from './OntologyPage';
import { TagPage } from './TagPage/TagPage';
import { AIChatPage } from '@views/AIChat/AIChatPage';
import { DocumentV2FullPage } from './Document/DocumentV2FullPage';
import { CanvasPage } from './Canvas/CanvasPage';
import { canvas } from '@tomic/lib';
import { PluginPage } from '@views/Plugin/PluginPage';
import { useCustomViews } from '@components/CustomViewProvider';
import { PluginView } from './PluginView/PluginView';

const TablePage = lazy(() =>
  import('../chunks/TablePage').then(m => ({ default: m.TablePage })),
);

/** These properties are passed to every View at Page level */
export type ResourcePageProps<Subject extends OptionalClass = never> = {
  resource: Resource<Subject>;
};

type Props = {
  subject: string;
};

/**
 * Renders a Resource and all its Properties. Title
 * is rendered prominently at the top. If the Resource has a
 * particular Class, it will render a different Component.
 */
const ResourcePage: React.FC<Props> = ({ subject }) => {
  const resource = useResource(subject);
  const { getPluginForClass, loading } = useCustomViews();
  const [isAList] = useArray(resource, core.properties.isA);
  const isA = isAList[0];

  // The body can have an inert attribute when the user navigated from an open dialog.
  // we remove it to make the page interactive again.
  useEffect(() => {
    document.body.removeAttribute('inert');
  }, []);

  // Guard against stuck `loading=true` placeholders. If the request orphans
  // (e.g. the server responds under a different normalized subject), the
  // `.loading` flag stays true forever. Surface a real error after 15s so the
  // user isn't staring at a spinner indefinitely.
  const [loadingExceeded, setLoadingExceeded] = useState(false);

  useEffect(() => {
    if (!resource.loading) {
      setLoadingExceeded(false);

      return;
    }

    const id = setTimeout(() => setLoadingExceeded(true), 15000);

    return () => clearTimeout(id);
  }, [resource.loading, subject]);

  if (resource.loading && !loadingExceeded) {
    return (
      <Main subject={subject}>
        <ContainerNarrow>
          <p>Loading...</p>
          <Spinner />
        </ContainerNarrow>
      </Main>
    );
  }

  if (resource.loading && loadingExceeded) {
    return (
      <Main subject={subject}>
        <ContainerNarrow>
          <h2>Still loading…</h2>
          <p>
            The resource at <code>{subject}</code> hasn't loaded after 15
            seconds. It may not exist, or the server may be unreachable.
          </p>
          <p>Check the browser console for details, or try navigating back.</p>
        </ContainerNarrow>
      </Main>
    );
  }

  if (resource.error) {
    return (
      <Main subject={subject}>
        <ErrorPage resource={resource} />
      </Main>
    );
  }

  let ReturnComponent = selectComponent(isA);

  if (ReturnComponent === ResourcePageDefault) {
    if (loading) return null;

    const plugin = getPluginForClass(isA);

    if (plugin) {
      return (
        <Main subject={subject}>
          <ErrorBoundary>
            <Suspense fallback={<Spinner />}>
              <PluginView resource={resource} plugin={plugin} />
            </Suspense>
          </ErrorBoundary>
        </Main>
      );
    }
  }

  return (
    <Main subject={subject}>
      <ErrorBoundary>
        <Suspense fallback={<Spinner />}>
          <ReturnComponent resource={resource} />
        </Suspense>
      </ErrorBoundary>
    </Main>
  );
};

function selectComponent(klass: string | undefined) {
  switch (klass) {
    case collections.classes.collection:
      return Collection;
    case server.classes.endpoint:
      return EndpointPage;
    case server.classes.drive:
      return DrivePage;
    case server.classes.invite:
    case server.classes.redirect:
      return InvitePage;
    case dataBrowser.classes.document:
      return DocumentPage;
    case core.classes.class:
      return ClassPage;
    case server.classes.file:
      return FilePage;
    case dataBrowser.classes.chatroom:
      return ChatRoomPage;
    case dataBrowser.classes.message:
      return MessagePage;
    case dataBrowser.classes.bookmark:
      return BookmarkPage;
    case dataBrowser.classes.importer:
      return ImporterPage;
    case dataBrowser.classes.folder:
      return FolderPage;
    case dataBrowser.classes.article:
      return ArticlePage;
    case dataBrowser.classes.table:
      return TablePage;
    case core.classes.ontology:
      return OntologyPage;
    case dataBrowser.classes.tag:
      return TagPage;
    case ai.classes.aiChat:
      return AIChatPage;
    case dataBrowser.classes.documentV2:
      return DocumentV2FullPage;
    case canvas.classes.canvas:
      return CanvasPage;
    case server.classes.plugin:
      return PluginPage;
    default:
      return ResourcePageDefault;
  }
}

export default ResourcePage;
