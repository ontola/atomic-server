import type { JSX } from 'react';
import { styled } from 'styled-components';
import { FaXmark } from 'react-icons/fa6';
import { useArray, useResource, useTitle } from '@tomic/react';
import { AgentAvatar } from '../Presence/AgentAvatar';
import { AtomicLink } from '../AtomicLink';
import { IconButton } from '../IconButton/IconButton';
import { plural } from '../../helpers/plural';
import { GroupAvatar } from './GroupAvatar';
import { GROUP_MEMBERS, isGroup } from './groups';

interface GroupMemberRowProps {
  subject: string;
  /** Shown instead of the member count / "Person" line. */
  detail?: string;
  onRemove?: () => void;
}

/** One Agent or Group: avatar, name, what it is, and an optional remove button. */
export function GroupMemberRow({
  subject,
  detail,
  onRemove,
}: GroupMemberRowProps): JSX.Element {
  const resource = useResource(subject);
  const [name] = useTitle(resource);
  const [members] = useArray(resource, GROUP_MEMBERS);
  const group = isGroup(resource);

  return (
    <RowWrapper data-testid='group-member' data-subject={subject}>
      {group ? (
        <GroupAvatar />
      ) : (
        <AgentAvatar agentSubject={subject} size='2.6rem' />
      )}
      <Who>
        <Name>
          <MemberLink subject={subject} clean>
            {name}
          </MemberLink>
        </Name>
        <Detail>
          {detail ??
            (group
              ? plural(members.length, ['Group, # member', 'Group, # members'])
              : 'Person')}
        </Detail>
      </Who>
      {onRemove && (
        <IconButton
          type='button'
          title={`Remove ${name}`}
          onClick={onRemove}
          data-testid='group-member-remove'
        >
          <FaXmark />
        </IconButton>
      )}
    </RowWrapper>
  );
}

const RowWrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 0.9rem;
  min-height: 3.6rem;
  padding-block: 0.3rem;
`;

const Who = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
`;

const Name = styled.span`
  font-size: 1.05rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const MemberLink = styled(AtomicLink)`
  color: inherit;
  text-decoration: none;

  &:hover,
  &:focus-visible {
    text-decoration: underline;
  }
`;

const Detail = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.95rem;
`;
