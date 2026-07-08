import { useMemo } from 'react';
import { styled } from 'styled-components';
import {
  FaBan,
  FaComments,
  FaLocationArrow,
  FaLocationCrosshairs,
  FaUser,
} from 'react-icons/fa6';
import { DropdownMenu, type DropdownItem } from '../Dropdown';
import type { DropdownTriggerProps } from '../Dropdown/DropdownTrigger';
import { AgentAvatar } from './AgentAvatar';
import { useFollow } from './FollowContext';
import { useRightPanel } from '../RightPanel/RightPanelContext';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../../helpers/navigation';

/**
 * Compact follow-mode status for the navbar: the followed agent's avatar
 * with a small "Following" badge overlapping it, and the follower facepile
 * with a "Following you" badge when others follow the signed-in agent.
 * Pressing either opens its actions. Renders nothing when neither applies.
 */
export function FollowStatus(): React.JSX.Element | null {
  const {
    followedAgent,
    unfollow,
    jumpToFollowed,
    followers,
    allowFollow,
    setAllowFollow,
    sessionChatroom,
    followedSession,
  } = useFollow();
  const navigate = useNavigateWithTransition();
  const { togglePanel } = useRightPanel();

  const followerAgents = useMemo(
    () => Array.from(new Set(followers.map(item => item.agent))),
    [followers],
  );

  const followingItems = useMemo((): DropdownItem[] => {
    const items: DropdownItem[] = [
      {
        id: 'jump-to-followed',
        label: 'Jump to their location',
        helper: 'Go to the resource they are viewing right now.',
        icon: <FaLocationCrosshairs />,
        onClick: jumpToFollowed,
      },
      {
        id: 'stop-following',
        label: 'Stop following',
        icon: <FaLocationArrow />,
        onClick: unfollow,
      },
      {
        id: 'show-profile',
        label: 'Show profile',
        icon: <FaUser />,
        onClick: () =>
          followedAgent && navigate(constructOpenURL(followedAgent)),
      },
    ];

    if (followedSession) {
      items.push({
        id: 'open-session-chat',
        label: 'Open session chat',
        helper: 'Chat and the log of resources visited during the session.',
        icon: <FaComments />,
        onClick: () => togglePanel('followSession'),
      });
    }

    return items;
  }, [
    jumpToFollowed,
    unfollow,
    navigate,
    followedAgent,
    followedSession,
    togglePanel,
  ]);

  const followerItems = useMemo((): DropdownItem[] => {
    const items: DropdownItem[] = [];

    if (sessionChatroom) {
      items.push({
        id: 'open-session-chat',
        label: 'Open session chat',
        helper: 'Chat and the log of resources you visited while followed.',
        icon: <FaComments />,
        onClick: () => togglePanel('followSession'),
      });
    }

    items.push({
      id: 'disallow-follow',
      label: 'Don’t allow following me',
      helper: 'Disconnects current followers.',
      icon: <FaBan />,
      onClick: () => setAllowFollow(false),
    });

    return items;
  }, [setAllowFollow, sessionChatroom, togglePanel]);

  const FollowingTrigger = useMemo(
    () =>
      followedAgent
        ? buildBadgedTrigger(
            <AgentAvatar agentSubject={followedAgent} size='1.6rem' />,
            'Following',
            'Following — press for actions',
          )
        : undefined,
    [followedAgent],
  );

  const FollowersTrigger = useMemo(
    () =>
      buildBadgedTrigger(
        <Facepile>
          {followerAgents.slice(0, 3).map(agent => (
            <AgentAvatar key={agent} agentSubject={agent} size='1.6rem' />
          ))}
        </Facepile>,
        'Following you',
        'These users follow you — press for actions',
      ),
    [followerAgents],
  );

  if (!allowFollow) {
    // Disabled: keep a quiet affordance in the same spot to re-enable.
    return (
      <MutedPill>
        <FaBan />
        <ReEnableButton type='button' onClick={() => setAllowFollow(true)}>
          Enable following
        </ReEnableButton>
      </MutedPill>
    );
  }

  if (!followedAgent && followerAgents.length === 0) {
    return null;
  }

  return (
    <Row>
      {FollowingTrigger && (
        <DropdownMenu items={followingItems} Trigger={FollowingTrigger} />
      )}
      {followerAgents.length > 0 && (
        <DropdownMenu items={followerItems} Trigger={FollowersTrigger} />
      )}
    </Row>
  );
}

/** Avatar (or facepile) trigger with a tiny badge overlapping its bottom. */
const buildBadgedTrigger = (
  content: React.ReactNode,
  badge: string,
  title: string,
): React.FC<DropdownTriggerProps> => {
  const Comp = ({
    onClick,
    menuId,
    isActive,
    ref,
    id,
  }: DropdownTriggerProps) => (
    <BadgedButton
      id={id}
      type='button'
      aria-controls={menuId}
      aria-expanded={isActive}
      aria-haspopup='menu'
      title={title}
      onClick={onClick}
      ref={ref}
    >
      {content}
      <Badge>{badge}</Badge>
    </BadgedButton>
  );

  Comp.displayName = 'BadgedFollowTrigger';

  return Comp;
};

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: ${p => p.theme.size(2)};
`;

const BadgedButton = styled.button`
  position: relative;
  display: inline-flex;
  border: none;
  background: none;
  padding: 0;
  margin-bottom: 0.35rem;
  cursor: pointer;
  border-radius: 50%;

  &:focus-visible {
    outline: 2px solid ${p => p.theme.colors.main};
    outline-offset: 1px;
  }
`;

const Badge = styled.span`
  position: absolute;
  bottom: -0.35rem;
  left: 50%;
  transform: translateX(-50%);
  padding: 0 0.3rem;
  border-radius: 0.5rem;
  background-color: ${p => p.theme.colors.main};
  color: white;
  font-size: 0.55rem;
  font-weight: bold;
  line-height: 1.5;
  white-space: nowrap;
  pointer-events: none;
`;

const Facepile = styled.span`
  display: inline-flex;
  align-items: center;

  & > *:not(:first-child) {
    margin-left: -0.5rem;
  }
`;

const MutedPill = styled.div`
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.1rem 0.5rem;
  border-radius: 1rem;
  background-color: ${p => p.theme.colors.bg1};
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85rem;
  white-space: nowrap;
`;

const ReEnableButton = styled.button`
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  color: ${p => p.theme.colors.main};
  font-size: 0.85rem;
  text-decoration: underline;
`;
