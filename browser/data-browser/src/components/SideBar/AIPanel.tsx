import { styled } from 'styled-components';
import {
  ai,
  core,
  removeCachedSearchResults,
  StoreEvents,
  unknownSubject,
  useCanWrite,
  useResource,
  useStore,
} from '@tomic/react';
import { Row } from '@components/Row';
import { AtomicLink } from '@components/AtomicLink';
import { ScrollArea } from '@components/ScrollArea';
import { ErrorLook } from '@components/ErrorLook';
import { useCallback, useEffect, useState, type JSX } from 'react';
import { useSettings } from '@helpers/AppSettings';
import { SideBarItem } from './SideBarItem';
import { FaPlus } from 'react-icons/fa6';
import { useCreateAndNavigate } from '@hooks/useCreateAndNavigate';

export function AIChatsPanel(): JSX.Element | null {
  const store = useStore();
  const [chats, setChats] = useState<string[]>([]);
  const { drive } = useSettings();
  const driveResource = useResource(drive);
  const canWriteToDrive = useCanWrite(driveResource);
  const createAndNavigate = useCreateAndNavigate();

  const createNewChat = () => {
    createAndNavigate(
      ai.classes.aiChat,
      {
        [core.properties.name]: 'Untitled Chat',
      },
      {
        parent: drive,
        onCreated: newChat => {
          setChats(prev => [newChat.subject, ...prev]);
        },
        // By skipping the notification we avoid adding the chat to the sidebar.
        skipNotify: true,
      },
    );
  };

  const search = useCallback(async () => {
    removeCachedSearchResults(store);

    const result = await store.search('', {
      filters: {
        [core.properties.isA]: ai.classes.aiChat,
      },
      parents: drive,
    });

    return result.toSorted((a, b) => b.localeCompare(a));
  }, [store, drive]);

  useEffect(() => {
    search().then(setChats);
  }, [drive, search]);

  useEffect(() => {
    const unsubRemove = store.on(StoreEvents.ResourceRemoved, subject => {
      setChats(prev => prev.filter(s => s !== subject));
    });

    const unsubSave = store.on(StoreEvents.ResourceSaved, resource => {
      if (chats.includes(resource.subject)) {
        // Chat is already displayed in the list.
        return;
      }

      if (resource.hasClasses(ai.classes.aiChat)) {
        // Wait 5 seconds for the search index to catch up.
        setTimeout(() => {
          search().then(setChats);
        }, 5000);
      }
    });

    return () => {
      unsubRemove();
      unsubSave();
    };
  }, [store, search, chats]);

  return (
    <Wrapper>
      <StyledScrollArea key={drive} type='hover'>
        {canWriteToDrive && (
          <SideBarItem onClick={createNewChat}>
            <Row gap='1ch' center>
              <FaPlus />
              New Chat
            </Row>
          </SideBarItem>
        )}
        {chats.map(subject => (
          <Item key={subject} subject={subject} />
        ))}
      </StyledScrollArea>
    </Wrapper>
  );
}

const Wrapper = styled.div`
  padding-top: 0;
  max-height: 20rem;
  overflow: hidden;
`;

const StyledScrollArea = styled(ScrollArea)`
  height: 20rem;
  overflow: hidden;
`;

interface ItemProps {
  subject: string;
}

function Item({ subject }: ItemProps): JSX.Element {
  const resource = useResource(subject);

  if (resource.loading) {
    return <div>loading</div>;
  }

  if (resource.error || resource.subject === unknownSubject) {
    return (
      <SideBarItem>
        <ErrorLook>Invalid Resource</ErrorLook>
      </SideBarItem>
    );
  }

  return (
    <StyledLink subject={subject} clean>
      <SideBarItem>
        <Row gap='1ch' center>
          {resource.title}
        </Row>
      </SideBarItem>
    </StyledLink>
  );
}

const StyledLink = styled(AtomicLink)`
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
`;
