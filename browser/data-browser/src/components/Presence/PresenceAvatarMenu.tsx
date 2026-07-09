import { useMemo } from 'react';
import { styled } from 'styled-components';
import {
  useCurrentAgent,
  useDrivePresence,
  useResource,
  useTitle,
} from '@tomic/react';
import { FaLocationArrow, FaUser } from 'react-icons/fa6';
import { DropdownMenu, type DropdownItem } from '../Dropdown';
import type { DropdownTriggerProps } from '../Dropdown/DropdownTrigger';
import { AgentAvatar } from './AgentAvatar';
import { useFollow } from './FollowContext';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../../helpers/navigation';

interface PresenceAvatarMenuProps {
  agentSubject: string;
  /** Avatar diameter, forwarded to {@link AgentAvatar}. */
  size?: string;
}

/**
 * A presence avatar that opens a context menu on click: show the agent's
 * profile, or — when they're online and followable — follow them around the
 * drive (issue #1229). An online agent gets a green presence dot. Used
 * everywhere an agent avatar appears (facepiles, chat) so the menu is
 * consistent. Renders as a focusable span so it stays valid markup inside
 * sidebar row links.
 */
export function PresenceAvatarMenu({
  agentSubject,
  size,
}: PresenceAvatarMenuProps): React.JSX.Element {
  const navigate = useNavigateWithTransition();
  const { followedAgent, follow, unfollow, isFollowDisabledFor } = useFollow();
  const presence = useDrivePresence();
  const [currentAgent] = useCurrentAgent();
  const agentResource = useResource(agentSubject);
  const [name] = useTitle(agentResource);
  const isFollowing = followedAgent === agentSubject;
  const followDisabled = isFollowDisabledFor(agentSubject);
  const isSelf = currentAgent?.subject === agentSubject;
  const online = useMemo(
    () => presence.some(item => item.agent === agentSubject),
    [presence, agentSubject],
  );

  const items = useMemo((): DropdownItem[] => {
    const result: DropdownItem[] = [
      {
        id: 'show-profile',
        label: 'Show profile',
        icon: <FaUser />,
        onClick: () => navigate(constructOpenURL(agentSubject)),
      },
    ];

    // Following only makes sense for someone else who's here now.
    if (isFollowing) {
      result.push({
        id: 'follow',
        label: 'Stop following',
        icon: <FaLocationArrow />,
        onClick: unfollow,
      });
    } else if (online && !isSelf && !followDisabled) {
      result.push({
        id: 'follow',
        label: 'Follow',
        icon: <FaLocationArrow />,
        onClick: () => follow(agentSubject),
      });
    }

    return result;
  }, [
    agentSubject,
    isFollowing,
    online,
    isSelf,
    followDisabled,
    navigate,
    follow,
    unfollow,
  ]);

  const Trigger = useMemo(
    () => buildAvatarTrigger(agentSubject, name, size, isFollowing, online),
    [agentSubject, name, size, isFollowing, online],
  );

  return <DropdownMenu items={items} Trigger={Trigger} />;
}

/** Trigger rendering the avatar itself. A `role="button"` span rather than
 *  a real `<button>`: sidebar avatars live inside the row's `<a>`, where a
 *  nested button is invalid HTML. Click/keyboard events stop propagating so
 *  opening the menu doesn't also navigate the row. */
const buildAvatarTrigger = (
  agentSubject: string,
  name: string,
  size: string | undefined,
  following: boolean,
  online: boolean,
): React.FC<DropdownTriggerProps> => {
  const Comp = ({
    onClick,
    menuId,
    isActive,
    ref,
    id,
  }: DropdownTriggerProps) => (
    <AvatarButton
      id={id}
      role='button'
      tabIndex={0}
      aria-controls={menuId}
      aria-expanded={isActive}
      aria-haspopup='menu'
      aria-label={name}
      $following={following}
      ref={ref as unknown as React.Ref<HTMLSpanElement>}
      onClick={e => {
        e.preventDefault();
        e.stopPropagation();
        onClick(e);
      }}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onClick(e as unknown as React.MouseEvent);
        }
      }}
    >
      <AgentAvatar agentSubject={agentSubject} size={size} online={online} />
    </AvatarButton>
  );

  Comp.displayName = 'PresenceAvatarTrigger';

  return Comp;
};

const AvatarButton = styled.span<{ $following: boolean }>`
  display: inline-flex;
  border-radius: 50%;
  cursor: pointer;
  outline: ${p => (p.$following ? `2px solid ${p.theme.colors.main}` : 'none')};
  outline-offset: 1px;

  &:hover,
  &:focus-visible {
    outline: 2px solid ${p => p.theme.colors.main};
  }
`;
