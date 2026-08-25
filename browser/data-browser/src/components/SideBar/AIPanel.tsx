import { styled } from 'styled-components';
import {
  ai,
  commits,
  core,
  StoreEvents,
  unknownSubject,
  useArray,
  useCanWrite,
  useChildren,
  useCollection,
  useResource,
  useStore,
  useString,
} from '@tomic/react';
import { useEffect, useState, type JSX } from 'react';
import { FaPlus } from 'react-icons/fa6';
import { usePrivateDrive } from '@hooks/usePrivateDrive';
import { useCreateAndNavigate } from '@hooks/useCreateAndNavigate';
import { getOrCreateAiChatsFolder } from '@helpers/standardLocations';
import { SharedWithMeLink } from './SharedWithMeLink';
import {
  SideBarMenuRow,
  SideBarMenuRowIcon,
  SideBarMenuRowLabel,
} from './SideBarMenuItem';

/**
 * Lists the user's AI chats: the children of the personal drive's "AI Chats"
 * folder (a standard location), newest first, plus any legacy chats that still
 * live directly under the drive root. Rows match the Favorites / Shared-with-me
 * panels. Listing children directly (instead of full-text search) means the
 * panel is populated as soon as the resources are, with no index lag.
 */
export function AIChatsPanel(): JSX.Element | null {
  const store = useStore();
  const { privateDrive, loading } = usePrivateDrive();
  const driveResource = useResource(privateDrive);
  const canWriteToDrive = useCanWrite(driveResource);
  const [aiChatsFolder] = useString(driveResource, ai.properties.aiChatsFolder);
  const folderChats = useNewestFirstChildren(aiChatsFolder);
  const { subjects: rootChildren } = useChildren(
    privateDrive ?? unknownSubject,
  );
  const createAndNavigate = useCreateAndNavigate();
  // Chats created from this panel, shown instantly (the collection catches up
  // through its live-membership bridge).
  const [justCreated, setJustCreated] = useState<string[]>([]);

  useEffect(() => {
    return store.on(StoreEvents.ResourceRemoved, subject => {
      setJustCreated(prev => prev.filter(s => s !== subject));
    });
  }, [store]);

  const createNewChat = async () => {
    if (!privateDrive) {
      return;
    }

    const folder = await getOrCreateAiChatsFolder(store, privateDrive);

    createAndNavigate(
      ai.classes.aiChat,
      {
        [core.properties.name]: 'Untitled Chat',
      },
      {
        parent: folder,
        onCreated: newChat => {
          setJustCreated(prev => [newChat.subject, ...prev]);
        },
        // The folder is hidden from the drive tree; no need to notify it.
        skipNotify: true,
      },
    );
  };

  const seen = new Set<string>();
  const chats = [...justCreated, ...folderChats].filter(subject =>
    seen.has(subject) ? false : (seen.add(subject), true),
  );

  return (
    <Wrapper>
      {!loading && canWriteToDrive && privateDrive && (
        <NewChatButton onClick={createNewChat}>
          <SideBarMenuRowIcon>
            <FaPlus />
          </SideBarMenuRowIcon>
          <SideBarMenuRowLabel>New Chat</SideBarMenuRowLabel>
        </NewChatButton>
      )}
      {chats.map(subject => (
        <SharedWithMeLink key={subject} subject={subject} />
      ))}
      {rootChildren.map(subject => (
        <LegacyRootChat key={subject} subject={subject} />
      ))}
    </Wrapper>
  );
}

/**
 * Children of the given folder, newest first. Live: the collection updates
 * membership from store events without refetching.
 */
function useNewestFirstChildren(folder: string | undefined): string[] {
  const [subjects, setSubjects] = useState<string[]>([]);

  const { collection, ready } = useCollection(
    {
      property: core.properties.parent,
      value: folder ?? unknownSubject,
      sort_by: commits.properties.createdAt,
      sort_desc: true,
    },
    { pageSize: 100 },
  );

  useEffect(() => {
    if (!ready || !folder) {
      setSubjects([]);

      return;
    }

    let cancelled = false;

    const extract = async () => {
      const members: string[] = [];

      for (let i = 0; i < collection.totalMembers; i++) {
        const member = await collection.getMemberWithIndex(i);

        if (member) {
          members.push(member);
        }
      }

      if (!cancelled) {
        setSubjects(members);
      }
    };

    extract();

    return () => {
      cancelled = true;
    };
  }, [collection, ready, folder]);

  return subjects;
}

/** Chats from before the AI Chats folder existed sit directly under the drive root. */
function LegacyRootChat({ subject }: { subject: string }): JSX.Element | null {
  const resource = useResource(subject);
  const [isA] = useArray(resource, core.properties.isA);

  if (!isA.includes(ai.classes.aiChat)) {
    return null;
  }

  return <SharedWithMeLink subject={subject} />;
}

const Wrapper = styled.div`
  max-height: 20rem;
  overflow-y: auto;
`;

/** Same row look as the menu links, but a real button. */
const NewChatButton = styled(SideBarMenuRow).attrs({ as: 'button' })`
  border: none;
  background: none;
  cursor: pointer;
  font: inherit;
`;
