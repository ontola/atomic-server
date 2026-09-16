import { useResource, type Server } from '@tomic/react';
import { styled } from 'styled-components';
import { ErrorBoundary } from '../../../views/ErrorPage';
import { FilePreviewThumbnail } from '../../../views/File/FilePreviewThumbnail';

interface FilePickerItemProps {
  subject: string;
  onClick?: () => void;
  allowedMimes?: Set<string>;
}

export function FilePickerItem({
  subject,
  allowedMimes,
  onClick,
}: FilePickerItemProps): React.JSX.Element {
  const resource = useResource<Server.File>(subject);

  const isAllowed = allowedMimes?.has(resource.props.mimetype ?? '') ?? true;

  if (resource.error) {
    return (
      <ItemWrapper disabled>
        <ItemCard></ItemCard>
        <span>Resource not found</span>
      </ItemWrapper>
    );
  }

  if (resource.loading) {
    return <div>loading</div>;
  }

  return (
    <ErrorBoundary FallBackComponent={ItemError}>
      <ItemWrapper onClick={onClick} disabled={!isAllowed}>
        <ItemCard>
          <FilePreviewThumbnail resource={resource} />
        </ItemCard>
        <span>{resource.title}</span>
      </ItemWrapper>
    </ErrorBoundary>
  );
}

const ItemCard = styled.div`
  background-color: var(--color-bg-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
  box-shadow: var(--shadow), var(--interaction-shadow);
  border: 1px solid var(--color-border);
  height: 100%;
  width: 100%;
  touch-action: none;
  pointer-events: none;
  user-select: none;
  transition:
    border 0.1s ease-in-out,
    box-shadow 0.1s ease-in-out;
`;

const ItemWrapper = styled.button`
  appearance: none;
  text-align: start;
  border: none;
  padding: 0;
  background-color: transparent;
  --shadow:
    0px 0.7px 1.3px rgba(0, 0, 0, 0.06), 0px 1.8px 3.2px rgba(0, 0, 0, 0.043),
    0px 3.4px 6px rgba(0, 0, 0, 0.036), 0px 6px 10.7px rgba(0, 0, 0, 0.03),
    0px 11.3px 20.1px rgba(0, 0, 0, 0.024), 0px 27px 48px rgba(0, 0, 0, 0.017);
  --interaction-shadow: 0px 0px 0px 0px var(--color-accent);
  --card-banner-height: 0px;
  display: flex;
  gap: 0.5rem;
  flex-direction: column;
  align-items: center;
  outline: none;
  text-decoration: none;
  color: var(--color-text);
  width: 100%;
  aspect-ratio: 1 / 1;

  &:not(:disabled):is(:hover, :focus) ${ItemCard} {
    --interaction-shadow: 0px 0px 0px 1px var(--color-accent);
    border: 1px solid var(--color-accent);
  }

  &:not(:disabled):is(:hover, :focus) {
    cursor: pointer;
    color: var(--color-accent);
  }

  &:disabled {
    opacity: 0.3;
  }
`;

interface ItemErrorProps {
  error: Error;
}

const ItemError: React.FC<ItemErrorProps> = ({ error }) => {
  return <ItemErrorWrapper>{error.message}</ItemErrorWrapper>;
};

const ItemErrorWrapper = styled.div`
  color: var(--color-alert);
  text-align: center;
`;
