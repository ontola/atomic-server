import {
  core,
  dataBrowser,
  server,
  useResource,
  useString,
  useTitle,
} from '@tomic/react';
import { useCallback, useMemo, type JSX } from 'react';
import { styled } from 'styled-components';
import { constructOpenURL } from '../../../helpers/navigation';
import { getIconForClass } from '../../../helpers/iconMap';
import { BookmarkGridItem } from './BookmarkGridItem';
import { BasicGridItem } from './BasicGridItem';
import { GridCard, GridItemTitle, GridItemWrapper } from './components';
import { DefaultGridItem } from './DefaultGridItem';
import { GridItemViewProps } from './GridItemViewProps';
import { FaFolder } from 'react-icons/fa6';
import { ChatRoomGridItem } from './ChatRoomGridItem';
import { DocumentGridItem } from './DocumentGridItem';
import { DocumentV2GridItem } from './DocumentV2GridItem';
import { ErrorBoundary } from '../../ErrorPage';
import { useNavigateWithTransition } from '../../../hooks/useNavigateWithTransition';
import { LoaderBlock } from '../../../components/Loader';
import { ArticleGridItem } from './ArticleGridItem';
import { FilePreviewThumbnail } from '../../File/FilePreviewThumbnail';
import { CommentCountBadge } from '../../../components/CommentCountBadge';

export interface ResourceGridItemProps {
  subject: string;
}

const gridItemMap = new Map<string, React.FC<GridItemViewProps>>([
  [dataBrowser.classes.bookmark, BookmarkGridItem],
  [core.classes.class, BasicGridItem],
  [core.classes.property, BasicGridItem],
  [dataBrowser.classes.chatroom, ChatRoomGridItem],
  [dataBrowser.classes.document, DocumentGridItem],
  [dataBrowser.classes.documentV2, DocumentV2GridItem],
  [server.classes.file, FilePreviewThumbnail],
  [dataBrowser.classes.article, ArticleGridItem],
]);

function getResourceRenderer(
  classSubject: string,
): React.FC<GridItemViewProps> {
  return gridItemMap.get(classSubject) ?? DefaultGridItem;
}

export function ResourceGridItem({
  subject,
}: ResourceGridItemProps): JSX.Element {
  const navigate = useNavigateWithTransition();
  const resource = useResource(subject);
  const [title] = useTitle(resource);

  const [classTypeSubject] = useString(resource, core.properties.isA);
  const classType = useResource(classTypeSubject);
  const [classTypeName] = useTitle(classType);

  const Icon = getIconForClass(classTypeSubject ?? '');

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();

      navigate(constructOpenURL(subject));
    },
    [subject, navigate],
  );

  const Resource = useMemo(() => {
    return getResourceRenderer(classTypeSubject ?? '');
  }, [classTypeSubject]);

  if (classTypeSubject === undefined) {
    return <Loader />;
  }

  const isFolder = classTypeSubject === dataBrowser.classes.folder;

  const transitionSubject = isFolder ? undefined : subject;

  return (
    <GridItemWrapper onClick={handleClick} href={subject}>
      <CornerBadge subject={subject} />
      <GridItemTitle subject={transitionSubject}>{title}</GridItemTitle>
      {isFolder ? (
        <FolderIcon />
      ) : (
        <GridCard subject={transitionSubject}>
          <ClassBanner>
            <Icon />
            <span>{classTypeName}</span>
          </ClassBanner>
          <ErrorBoundary FallBackComponent={GridItemError}>
            <Resource resource={resource} />
          </ErrorBoundary>
        </GridCard>
      )}
    </GridItemWrapper>
  );
}

const CornerBadge = styled(CommentCountBadge)`
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  z-index: 1;
  box-shadow: var(--shadow);
`;

const ClassBanner = styled.div`
  display: flex;
  background-color: var(--color-bg);
  border-top-left-radius: var(--radius-md);
  border-top-right-radius: var(--radius-md);
  align-items: center;
  gap: 0.5rem;
  justify-content: center;
  padding-block: var(--card-banner-padding);
  color: var(--color-text-subtle);

  border-bottom: 1px solid var(--color-border);
  span {
    text-transform: capitalize;
  }
`;

const FolderIcon = styled(FaFolder)`
  height: 100%;
  width: 100%;
  color: var(--color-text-subtle);
  transition: color 0.1s ease-in-out;

  ${GridItemWrapper}:hover & {
    color: var(--color-accent);
  }
`;

interface GridItemErrorProps {
  error: Error;
}

const GridItemError: React.FC<GridItemErrorProps> = ({ error }) => {
  return <GridItemErrorWrapper>{error.message}</GridItemErrorWrapper>;
};

const GridItemErrorWrapper = styled.div`
  color: var(--color-alert);
  text-align: center;
`;

const Loader = styled(LoaderBlock)`
  --loader-bg-to: var(--color-bg-body);
  height: unset;
  aspect-ratio: 1/1;
`;
