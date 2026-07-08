import { useEffect, useMemo } from 'react';
import { styled, keyframes } from 'styled-components';
import { FaVideo } from 'react-icons/fa6';
import {
  dataBrowser,
  unknownSubject,
  useArray,
  useCurrentAgent,
  useDrive,
  useDrivePresence,
  useResource,
  useTitle,
} from '@tomic/react';
import { useFollow } from './FollowContext';
import { useRightPanel } from '../RightPanel/RightPanelContext';
import { useCurrentSubject } from '../../helpers/useCurrentSubject';

/**
 * The meeting's front door in the top bar. Three states, one spot:
 *  - No live meeting → a subtle "Start meeting" button.
 *  - A live meeting you're not in → a vibrant Join pill.
 *  - You're in (leader or joined) → the pill opens the meeting chat;
 *    Leave / End live in the chat panel header.
 *
 * A meeting is "live" when it's in the drive's `currentMeetings` and
 * its leader's presence announces it (`session === meeting`).
 */
export function MeetingBanner(): React.JSX.Element | null {
  const [drive] = useDrive();
  const driveResource = useResource(drive);
  const [currentMeetings] = useArray(
    driveResource,
    dataBrowser.properties.currentMeetings,
  );
  const presence = useDrivePresence();
  const [agent] = useCurrentAgent();
  const { follow, followedAgent, activeMeeting, startMeeting } = useFollow();
  const { setPanelOpen } = useRightPanel();
  const [currentSubject] = useCurrentSubject();

  // The most recently announced live meeting: listed on the drive AND
  // carried by some presence entry's `session`.
  const live = useMemo(() => {
    let freshest: { meeting: string; leader: string; at: number } | undefined;

    for (const meeting of currentMeetings) {
      for (const item of presence) {
        if (item.session !== meeting) continue;

        const at = item.updatedAt ?? 0;

        if (!freshest || at > freshest.at) {
          freshest = { meeting, leader: item.agent, at };
        }
      }
    }

    return freshest;
  }, [currentMeetings, presence]);

  const leading = !!activeMeeting;
  const meetingSubject = activeMeeting ?? live?.meeting ?? unknownSubject;
  const meetingResource = useResource(meetingSubject);
  const [title] = useTitle(meetingResource);
  const leaderResource = useResource(live?.leader ?? unknownSubject);
  const [leaderName] = useTitle(leaderResource);

  // Opening a live meeting resource IS joining it: follow the leader
  // and open the chat, same as pressing Join. (Ended meetings — not in
  // `currentMeetings` — are just read as minutes, no auto-follow.)
  const shouldAutoJoin =
    !!live &&
    currentSubject === live.meeting &&
    !activeMeeting &&
    followedAgent !== live.leader;

  useEffect(() => {
    if (shouldAutoJoin && live) {
      follow(live.leader);
      setPanelOpen('followSession', true);
    }
  }, [shouldAutoJoin, live, follow, setPanelOpen]);

  // No live meeting → offer to start one (same spot Join would appear).
  if (meetingSubject === unknownSubject) {
    if (!agent || !drive) return null;

    const handleStart = () => {
      void startMeeting().then(() => setPanelOpen('followSession', true));
    };

    return (
      <StartButton
        type='button'
        onClick={handleStart}
        title='Start a meeting — invite everyone in this drive to follow you live'
      >
        <FaVideo />
        <span>Meet</span>
      </StartButton>
    );
  }

  // "Own" means I'm the LEADER of this meeting (I started it) — not
  // merely the same agent, so a second tab (or a same-agent attendee)
  // can still join. Joined = my presence follows the leader.
  const joined = !leading && !!live && followedAgent === live.leader;
  const active = joined || leading;

  // The whole banner is one big target. Not joined → Join (follow the
  // leader) and open the chat. Already in → just open the chat; Leave
  // and End live in the chat panel header.
  function handleClick() {
    if (active) {
      setPanelOpen('followSession', true);

      return;
    }

    if (live) {
      follow(live.leader);
      setPanelOpen('followSession', true);
    }
  }

  const hint = active
    ? 'Open the meeting chat'
    : `Join ${title} — led by ${leaderName}`;

  return (
    <Banner type='button' onClick={handleClick} $active={active} title={hint}>
      <LiveDot aria-hidden />
      <Label>{title}</Label>
      {!active && <JoinTag>Join</JoinTag>}
    </Banner>
  );
}

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
`;

const Banner = styled.button<{ $active: boolean }>`
  display: flex;
  align-items: center;
  gap: ${p => p.theme.size(2)};
  max-width: 18rem;
  padding: 0.3rem 0.7rem;
  border-radius: 1rem;
  cursor: pointer;
  background: ${p => (p.$active ? p.theme.colors.bg1 : p.theme.colors.main)};
  color: ${p => (p.$active ? p.theme.colors.text : 'white')};
  border: 1px solid ${p => p.theme.colors.main};
  font-size: 0.85rem;
  white-space: nowrap;

  &:hover,
  &:focus-visible {
    background: ${p =>
      p.$active ? p.theme.colors.bg2 : p.theme.colors.mainDark};
  }
`;

const LiveDot = styled.span`
  width: 0.5rem;
  height: 0.5rem;
  flex-shrink: 0;
  border-radius: 50%;
  background: #ff4d4d;
  animation: ${pulse} 2s ease-in-out infinite;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

/** "Start meeting" affordance shown when no meeting is live — styled
 *  like the other nav-bar actions (Share, Comments). Kept in sync with
 *  NavBar's `LabelButton` (a shared import would be circular: NavBar
 *  imports this component). */
const StartButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  padding: 0.25rem 0.5rem;
  border: none;
  border-radius: ${p => p.theme.radius};
  background: transparent;
  color: ${p => p.theme.colors.textLight};
  cursor: pointer;
  font-size: 0.875rem;
  white-space: nowrap;

  &:hover,
  &:focus-visible {
    background: ${p => p.theme.colors.bg1};
    color: ${p => p.theme.colors.text};
  }
`;

const Label = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
`;

/** A read-only "Join" affordance — the whole banner is the button. */
const JoinTag = styled.span`
  flex-shrink: 0;
  border-radius: 0.8rem;
  padding: 0.05rem 0.55rem;
  font-size: 0.8rem;
  font-weight: 700;
  background: white;
  color: ${p => p.theme.colors.main};
`;
