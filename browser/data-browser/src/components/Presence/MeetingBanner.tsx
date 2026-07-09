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
import { LabelButton } from '../NavBarButton';
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
  const { setPanelOpen, activePanel } = useRightPanel();
  const panelOpen = activePanel === 'followSession';
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
      <LabelButton type='button' onClick={handleStart} title='Meet'>
        <FaVideo />
        <span>Meet</span>
      </LabelButton>
    );
  }

  // "Own" means I'm the LEADER of this meeting (I started it) — not
  // merely the same agent, so a second tab (or a same-agent attendee)
  // can still join. Joined = my presence follows the leader.
  const joined = !leading && !!live && followedAgent === live.leader;
  const active = joined || leading;

  // The whole button is one target. Not joined → Join (follow the leader) and
  // open the chat. Already in → toggle the chat panel (open if closed, close
  // if open), matching the Comments / AI nav toggles. Leave and End live in
  // the chat panel header.
  function handleClick() {
    if (active) {
      setPanelOpen('followSession', !panelOpen);

      return;
    }

    if (live) {
      follow(live.leader);
      setPanelOpen('followSession', true);
    }
  }

  const hint = active
    ? panelOpen
      ? 'Close the meeting chat'
      : 'Open the meeting chat'
    : `Join ${title} — led by ${leaderName}`;

  return (
    <LiveMeetingButton
      type='button'
      onClick={handleClick}
      // Blue "current" cue only while I'm in the meeting AND its panel is open,
      // like the other nav toggles. A live meeting I haven't joined keeps its
      // own "Join" call-to-action instead.
      $active={active && panelOpen}
      title={hint}
    >
      {/* Video icon + pulsing dot, both non-<span> so they survive the
       * icon-only collapse. With the red border this stays clearly a live
       * meeting even when the label is hidden on a narrow bar. */}
      <LiveIndicator aria-hidden>
        <FaVideo />
        <LiveDot />
      </LiveIndicator>
      <MeetingLabel>{title}</MeetingLabel>
      {!active && <JoinTag>Join</JoinTag>}
    </LiveMeetingButton>
  );
}

const pulse = keyframes`
  0%, 100% { background: #ff4d4d; }
  50% { background: #ffffff; }
`;

/**
 * A live meeting must read as live even after the label collapses on a narrow
 * bar. The red border is the persistent "there's a meeting" cue; it survives
 * collapse because it's on the button itself, not a hidden label.
 */
const LiveMeetingButton = styled(LabelButton)`
  border: 1px solid #ff4d4d;
  /* Compensate the 1px border so the height matches the borderless siblings. */
  padding: calc(0.25rem - 1px) calc(0.5rem - 1px);
`;

/** Video icon with the pulsing dot as a corner badge. Both are `<i>`/svg (not
 *  `<span>`), so the icon-only rule keeps them when it hides the label. */
const LiveIndicator = styled.i`
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  font-style: normal;
`;

const LiveDot = styled.i`
  position: absolute;
  top: -3px;
  left: -4px;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: #ff4d4d;
  /* Ring in the bar's colour so the dot stays legible over the icon. */
  box-shadow: 0 0 0 2px ${p => p.theme.colors.bg};
  animation: ${pulse} 2s ease-in-out infinite;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const MeetingLabel = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
`;

/** The "Join" call-to-action for a live meeting you haven't joined yet — the
 *  whole button is the target; this just draws the eye. */
const JoinTag = styled.span`
  flex-shrink: 0;
  border-radius: 0.8rem;
  padding: 0.05rem 0.55rem;
  font-size: 0.8rem;
  font-weight: 700;
  background: ${p => p.theme.colors.main};
  color: white;
`;
