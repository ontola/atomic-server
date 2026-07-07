import { useRef } from 'react';
import { styled } from 'styled-components';
import { Column } from '../components/Row';
import { EditableTitle } from '../components/EditableTitle';
import { ResourcePageProps } from './ResourcePage';
import { ChatRoomView } from './ChatRoom/ChatRoomView';

/** Full page ChatRoom that shows a message list and a form to add Messages. */
export function ChatRoomPage({ resource }: ResourcePageProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  return (
    <FullPageWrapper>
      <Column fullHeight>
        <EditableTitle
          resource={resource}
          onCommit={() => inputRef.current?.focus()}
        />
        <ChatRoomView resource={resource} inputRef={inputRef} viewTransition />
      </Column>
    </FullPageWrapper>
  );
}

const FullPageWrapper = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 1rem;
  flex: 1;
`;
