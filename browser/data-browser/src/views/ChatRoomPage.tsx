import { useRef } from 'react';
import { styled } from 'styled-components';
import { Column } from '../components/Row';
import { EditableTitle } from '../components/EditableTitle';
import { ResourceCoverImage } from '../components/ResourceDecorations';
import { ResourcePageProps } from './ResourcePage';
import { ChatRoomView } from './ChatRoom/ChatRoomView';

/** Full page ChatRoom that shows a message list and a form to add Messages. */
export function ChatRoomPage({ resource }: ResourcePageProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  return (
    <PageWrapper>
      <ResourceCoverImage resource={resource} />
      <FullPageWrapper>
        <Column fullHeight>
          <EditableTitle
            resource={resource}
            onCommit={() => inputRef.current?.focus()}
            withDecorations
          />
          <ChatRoomView
            resource={resource}
            inputRef={inputRef}
            viewTransition
          />
        </Column>
      </FullPageWrapper>
    </PageWrapper>
  );
}

const PageWrapper = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
`;

const FullPageWrapper = styled.div`
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 1rem;
  flex: 1;
`;
