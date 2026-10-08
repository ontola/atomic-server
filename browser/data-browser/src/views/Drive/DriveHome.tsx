import {
  core,
  dataBrowser,
  useDrivePresence,
  useResource,
  useTitle,
  useArray,
} from '@tomic/react';
import { useState, type JSX } from 'react';
import {
  FaComment,
  FaFileLines,
  FaFolder,
  FaTable,
  FaVideo,
} from 'react-icons/fa6';
import type { IconType } from 'react-icons';
import { styled } from 'styled-components';
import { AtomicLink } from '@components/AtomicLink';
import { ResourceGlyph } from '@components/ResourceGlyph';
import { PresenceAvatarMenu } from '@components/Presence/PresenceAvatarMenu';
import { useNewResourceUI } from '@components/forms/NewForm/useNewResourceUI';
import { getRecentResources } from '@helpers/recentResources';

const MAX_RECENT = 6;
const MAX_PEOPLE = 6;

const QUICK_CREATE: { label: string; classSubject: string; Icon: IconType }[] =
  [
    {
      label: 'Document',
      classSubject: dataBrowser.classes.documentV2,
      Icon: FaFileLines,
    },
    { label: 'Table', classSubject: dataBrowser.classes.table, Icon: FaTable },
    {
      label: 'Folder',
      classSubject: dataBrowser.classes.folder,
      Icon: FaFolder,
    },
    {
      label: 'Meeting',
      classSubject: dataBrowser.classes.meeting,
      Icon: FaVideo,
    },
    {
      label: 'Chat room',
      classSubject: dataBrowser.classes.chatroom,
      Icon: FaComment,
    },
  ];

/** Larger labelled shortcuts for the classes people create most. */
export function QuickCreateCards({ parent }: { parent: string }): JSX.Element {
  const createNewResource = useNewResourceUI();

  return (
    <CardRow aria-label='Create'>
      {QUICK_CREATE.map(({ label, classSubject, Icon }) => (
        <CreateCard
          key={classSubject}
          type='button'
          onClick={() => createNewResource(classSubject, parent)}
        >
          <Icon />
          <span>{label}</span>
        </CreateCard>
      ))}
    </CardRow>
  );
}

/** Avatars of the people currently on the drive, one per agent. */
export function DrivePeople(): JSX.Element | null {
  const presence = useDrivePresence();
  const agents = Array.from(new Set(presence.map(item => item.agent)));

  if (agents.length === 0) {
    return null;
  }

  return (
    <People aria-label='Currently on this drive'>
      {agents.slice(0, MAX_PEOPLE).map(agent => (
        <PresenceAvatarMenu key={agent} agentSubject={agent} size='1.9rem' />
      ))}
      {agents.length > MAX_PEOPLE && <More>+{agents.length - MAX_PEOPLE}</More>}
    </People>
  );
}

/** Resources opened recently on this drive, newest first. Renders nothing when there are none. */
export function RecentlyOpened({
  drive,
}: {
  drive: string;
}): JSX.Element | null {
  const [recent] = useState(() =>
    getRecentResources(drive).slice(0, MAX_RECENT),
  );

  if (recent.length === 0) {
    return null;
  }

  return (
    <section>
      <SectionTitle>Recently opened</SectionTitle>
      <Tiles>
        {recent.map(subject => (
          <ResourceTile key={subject} subject={subject} />
        ))}
      </Tiles>
    </section>
  );
}

export function ResourceTiles({
  subjects,
}: {
  subjects: string[];
}): JSX.Element {
  return (
    <Tiles>
      {subjects.map(subject => (
        <ResourceTile key={subject} subject={subject} />
      ))}
    </Tiles>
  );
}

function ResourceTile({ subject }: { subject: string }): JSX.Element {
  const resource = useResource(subject, { allowIncomplete: true });
  const [title] = useTitle(resource);
  const [isA] = useArray(resource, core.properties.isA);
  const classResource = useResource(isA[0]);
  const [className] = useTitle(classResource);

  return (
    <Tile subject={subject} clean>
      <TileGlyph>
        <ResourceGlyph resource={resource} />
      </TileGlyph>
      <TileText>
        <TileTitle>{title}</TileTitle>
        {isA[0] && <TileClass>{className}</TileClass>}
      </TileText>
    </Tile>
  );
}

export const SectionTitle = styled.h2`
  font-size: 0.85rem;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: ${p => p.theme.colors.textLight};
  margin: 0 0 0.75rem;
`;

const CardRow = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(6rem, 1fr));
  gap: 0.75rem;
`;

const CreateCard = styled.button`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 1rem 0.5rem;
  font: inherit;
  font-size: 0.9rem;
  cursor: pointer;
  color: ${p => p.theme.colors.text1};
  background: ${p => p.theme.colors.bg};
  border: 1px dashed ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  transition:
    border-color 0.1s,
    color 0.1s,
    background-color 0.1s;

  svg {
    font-size: 1.4rem;
    color: ${p => p.theme.colors.main};
  }

  &:hover,
  &:focus-visible {
    border-style: solid;
    border-color: ${p => p.theme.colors.main};
    background: ${p => p.theme.colors.mainSelectedBg};
    color: ${p => p.theme.colors.main};
  }
`;

const Tiles = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
  gap: 0.75rem;

  @media (max-width: 480px) {
    grid-template-columns: 1fr;
  }
`;

const Tile = styled(AtomicLink)`
  display: flex;
  align-items: center;
  gap: 0.85rem;
  min-width: 0;
  padding: 0.85rem 1rem;
  background: ${p => p.theme.colors.bg1};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  color: ${p => p.theme.colors.text1};
  text-decoration: none;
  transition:
    border-color 0.1s,
    box-shadow 0.1s;

  &:hover,
  &:focus-visible {
    border-color: ${p => p.theme.colors.main};
    box-shadow: 0 0 0 1px ${p => p.theme.colors.main};
    color: ${p => p.theme.colors.text1};
  }
`;

const TileGlyph = styled.span`
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 2.5rem;
  height: 2.5rem;
  font-size: 1.25rem;
  color: ${p => p.theme.colors.main};
  background: ${p => p.theme.colors.mainSelectedBg};
  border-radius: ${p => p.theme.radius};
`;

const TileText = styled.span`
  display: flex;
  flex-direction: column;
  min-width: 0;
`;

const TileTitle = styled.span`
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const TileClass = styled.span`
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const People = styled.span`
  display: inline-flex;
  align-items: center;

  & > *:not(:first-child) {
    margin-left: -0.4rem;
  }
`;

const More = styled.span`
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
  margin-left: 0.3rem;
`;
