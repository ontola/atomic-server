import { styled } from 'styled-components';
import {
  ai,
  commits,
  core,
  unknownSubject,
  useArray,
  useChildren,
  useCollection,
  useResource,
  useString,
} from '@tomic/react';
import { useEffect, useState, type JSX } from 'react';
import { FaPlus, FaRegComment } from 'react-icons/fa6';
import { IconButton } from '@components/IconButton/IconButton';
import { useAISidebar } from '@components/AI/AISidebarContext';
import { dataBrowser, useTitle } from '@tomic/react';
import { usePrivateDrive } from '@hooks/usePrivateDrive';
import {
  SideBarMenuRow,
  SideBarMenuRowLabel,
  SideBarMenuRowIcon,
  SideBarMenuItemLink,
} from './SideBarMenuItem';

/**
 * Lists the user's AI chats: the children of the personal drive's "AI Chats"
 * folder (a standard location), newest first, plus any legacy chats that still
 * live directly under the drive root. Rows match the Favorites / Shared-with-me
 * panels. Listing children directly (instead of full-text search) means the
 * panel is populated as soon as the resources are, with no index lag.
 */
export function AIChatsPanel(): JSX.Element | null {
  const { privateDrive } = usePrivateDrive();
  const driveResource = useResource(privateDrive);
  const [aiChatsFolder] = useString(driveResource, ai.properties.aiChatsFolder);
  const folderChats = useNewestFirstChildren(aiChatsFolder);
  const { subjects: rootChildren } = useChildren(
    privateDrive ?? unknownSubject,
  );
  const chats = folderChats;

  return (
    <Wrapper>
      {chats.map(subject => (
        <ChatLink key={subject} subject={subject} />
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

  return <ChatLink subject={subject} />;
}

const Wrapper = styled.div`
  max-height: 20rem;
  overflow-y: auto;
`;

export function NewSidebarChatButton() {
  const { openChat } = useAISidebar();

  return (
    <IconButton
      title='New Chat'
      size='small'
      color='textLight'
      onClick={() => openChat()}
    >
      <FaPlus />
    </IconButton>
  );
}

function ChatLink({ subject }: { subject: string }) {
  const resource = useResource(subject);
  const [title] = useTitle(resource);
  const emoji = resource.get(dataBrowser.properties.emoji) as
    | string
    | undefined;
  const { openChat } = useAISidebar();

  return (
    <SideBarMenuItemLink
      subject={subject}
      clean
      onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        openChat(subject);
      }}
    >
      <SideBarMenuRow>
        <SideBarMenuRowIcon>
          {emoji ? <span aria-hidden>{emoji}</span> : <FaRegComment />}
        </SideBarMenuRowIcon>
        <SideBarMenuRowLabel>{title || 'Untitled Chat'}</SideBarMenuRowLabel>
      </SideBarMenuRow>
    </SideBarMenuItemLink>
  );
}
