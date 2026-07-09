import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  core,
  dataBrowser,
  useCurrentAgent,
  useDrive,
  useDrivePresence,
  useStore,
  type PresenceItem,
  type Store,
} from '@tomic/react';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../../helpers/navigation';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useCurrentSubject } from '../../helpers/useCurrentSubject';
import { sendChatMessage } from '../../views/ChatRoom/ChatRoomView';
import { getOrCreateMeetingsFolder } from '../../helpers/standardLocations';

interface FollowContextValue {
  /** Agent subject currently being followed, if any. */
  followedAgent: string | undefined;
  /** Resource the followed agent is currently viewing, if known. */
  followedResource: string | undefined;
  follow: (agentSubject: string) => void;
  unfollow: () => void;
  /** Navigate to the followed agent's current location. Useful after
   *  browsing away yourself: auto-navigation only fires when THEY move. */
  jumpToFollowed: () => void;
  /** Sessions currently following the signed-in agent. */
  followers: PresenceItem[];
  /** Whether others may follow this user (announced on presence). */
  allowFollow: boolean;
  setAllowFollow: (allow: boolean) => void;
  /** True when `agentSubject` announced that they don't want followers. */
  isFollowDisabledFor: (agentSubject: string) => boolean;
  /** The Meeting of the agent WE follow, from their presence entry
   *  (they're leading it). Opens in the session panel. */
  followedSession: string | undefined;
  /** The Meeting this agent is currently LEADING, if any. While set, the
   *  presence `session` points at it so joiners open the meeting chat. */
  activeMeeting: string | undefined;
  /** Start leading a meeting: creates the Meeting (a ChatRoom with the
   *  Meeting class) in the drive, lists it in the drive's
   *  `currentMeetings`, and announces it on presence. Name is optional
   *  (defaults to a dated title the user can rename). */
  startMeeting: (name?: string) => Promise<string>;
  /** Stop leading: de-lists the meeting (the resource remains as
   *  minutes). */
  endMeeting: () => Promise<void>;
}

const FollowContext = createContext<FollowContextValue>({
  followedAgent: undefined,
  followedResource: undefined,
  follow: () => undefined,
  unfollow: () => undefined,
  jumpToFollowed: () => undefined,
  followers: [],
  allowFollow: true,
  setAllowFollow: () => undefined,
  isFollowDisabledFor: () => false,
  followedSession: undefined,
  activeMeeting: undefined,
  startMeeting: async () => '',
  endMeeting: async () => undefined,
} satisfies FollowContextValue);

/** sessionStorage key for the meeting a tab is leading on a given drive.
 *  Per-tab + per-drive, so a refresh resumes the meeting but a closed tab
 *  forgets it. */
const meetingStorageKey = (drive: string): string =>
  `atomic.activeMeeting:${drive}`;

/** Post a trail entry: a plain chat message linking the visited resource. */
async function postTrailMessage(
  store: Store,
  chatroom: string,
  subject: string,
): Promise<void> {
  const resource = await store.getResource(subject);
  const title = resource.title || subject;
  await sendChatMessage(store, {
    parent: chatroom,
    text: /* @wc-ignore */ `Viewing [${title}](${subject})`,
    extraClasses: [dataBrowser.classes.followEvent],
  });
}

/**
 * Follow mode (issue #1229): while following an agent, navigate to
 * whatever resource their presence says they're viewing, live. Both sides
 * are visible: the follower announces `following` on their presence entry,
 * so the followed agent sees who's tagging along — and can turn following
 * off entirely, which makes followers' clients stop.
 */
export function FollowProvider({
  children,
}: React.PropsWithChildren): React.JSX.Element {
  const store = useStore();
  const [drive] = useDrive();
  const [agent] = useCurrentAgent();
  const agentSubject = agent?.subject;
  const [followedAgent, setFollowedAgent] = useState<string>();
  const [allowFollow, setAllowFollowStored] = useLocalStorage(
    'presenceAllowFollow',
    true,
  );
  const presence = useDrivePresence();
  const navigate = useNavigateWithTransition();
  const [currentSubject] = useCurrentSubject();
  /** The Meeting this agent is currently leading (state is local: a
   *  reload ends leadership; the banner hides once presence expires). */
  const [activeMeeting, setActiveMeeting] = useState<string>();

  const manager = drive ? store.getPresence(drive) : undefined;

  // While leading a meeting, the presence session points at it — joiners
  // read it and open the meeting chat. (Following without a meeting shares
  // navigation only; there's no ad-hoc session chat anymore — start a
  // meeting for that.)
  // Announce the follow-related fields on our presence entry. Runs on
  // manager changes too (drive switch resets the entry).
  useEffect(() => {
    if (manager && agentSubject) {
      manager.patchLocal({
        following: followedAgent,
        session: activeMeeting,
        // Absent means followable — only announce the opt-out.
        allowFollow: allowFollow ? undefined : false,
      });
    }
  }, [manager, agentSubject, followedAgent, allowFollow, activeMeeting]);

  const isFollowDisabledFor = useCallback(
    (subject: string) =>
      presence.some(
        item => item.agent === subject && item.allowFollow === false,
      ),
    [presence],
  );

  // The followed agent may have several sessions (tabs, or a stale entry
  // from before a reload that hasn't hit its TTL). Follow the freshest one.
  const followedResource = useMemo(() => {
    if (!followedAgent) {
      return undefined;
    }

    const sessions = presence
      .filter(item => item.agent === followedAgent && item.resource)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    return sessions[0]?.resource;
  }, [presence, followedAgent]);

  // Only navigate when the followed resource actually changes — the effect
  // may re-run for other reasons (e.g. `navigate` identity), and re-issuing
  // the same navigation would fight the user's own scrolling/focus.
  const lastNavigatedRef = useRef<string>(undefined);

  useEffect(() => {
    if (followedResource && followedResource !== lastNavigatedRef.current) {
      lastNavigatedRef.current = followedResource;
      navigate(constructOpenURL(followedResource));
    }

    if (!followedAgent) {
      lastNavigatedRef.current = undefined;
    }
  }, [followedResource, followedAgent, navigate]);

  // Stop silently when the followed agent goes offline (presence expired)
  // or announces that they don't want to be followed.
  useEffect(() => {
    if (
      followedAgent &&
      (!presence.some(item => item.agent === followedAgent) ||
        isFollowDisabledFor(followedAgent))
    ) {
      setFollowedAgent(undefined);
    }
  }, [presence, followedAgent, isFollowDisabledFor]);

  const followers = useMemo(
    () =>
      agentSubject
        ? presence.filter(item => item.following === agentSubject)
        : [],
    [presence, agentSubject],
  );

  // Resources already logged into the current meeting's trail, so a resource
  // the leader revisits (or that re-fires on a render) never posts a duplicate
  // "Viewing …" entry. Keyed by meeting so a new meeting starts fresh.
  const trailedRef = useRef<Set<string>>(new Set());
  const trailMeetingRef = useRef<string>(undefined);

  // Restore the meeting we're leading on this drive from sessionStorage: it
  // survives a page refresh (so a refreshed leader keeps their meeting going)
  // but clears when the tab closes. Switching drives swaps to that drive's own
  // meeting, or none.
  useEffect(() => {
    if (!drive) {
      setActiveMeeting(undefined);

      return;
    }

    setActiveMeeting(
      sessionStorage.getItem(meetingStorageKey(drive)) ?? undefined,
    );
  }, [drive]);

  // While leading a meeting, log each NEW resource visited into it — the
  // meeting is the shared trail, and late joiners read it back. Each resource
  // is logged at most once per meeting.
  useEffect(() => {
    if (!activeMeeting || !currentSubject) {
      return;
    }

    if (trailMeetingRef.current !== activeMeeting) {
      trailMeetingRef.current = activeMeeting;
      trailedRef.current = new Set();
    }

    if (trailedRef.current.has(currentSubject)) {
      return;
    }

    trailedRef.current.add(currentSubject);
    postTrailMessage(store, activeMeeting, currentSubject).catch(
      () => undefined,
    );
  }, [activeMeeting, currentSubject, store]);

  // The meeting of the agent WE follow, from their presence entry.
  const followedSession = useMemo(() => {
    if (!followedAgent) {
      return undefined;
    }

    return presence.find(item => item.agent === followedAgent && item.session)
      ?.session;
  }, [presence, followedAgent]);

  const follow = useCallback((subject: string) => {
    setFollowedAgent(subject);
  }, []);

  const unfollow = useCallback(() => {
    setFollowedAgent(undefined);
  }, []);

  const jumpToFollowed = useCallback(() => {
    if (followedResource) {
      lastNavigatedRef.current = followedResource;
      navigate(constructOpenURL(followedResource));
    }
  }, [followedResource, navigate]);

  const setAllowFollow = useCallback(
    (allow: boolean) => {
      setAllowFollowStored(allow);
    },
    [setAllowFollowStored],
  );

  const startMeeting = useCallback(
    async (name?: string): Promise<string> => {
      if (!drive) {
        throw new Error('Cannot start a meeting without a drive.');
      }

      // A title is optional — default to a dated name the user can
      // rename by clicking the meeting title.
      const meetingName =
        name?.trim() ||
        `Meeting · ${new Date().toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}`;

      // Meetings live in the drive's Meetings folder (a standard
      // location found via the drive's `meetingsFolder` pointer), not
      // in the drive root.
      const meetingsFolder = await getOrCreateMeetingsFolder(store, drive);

      const meeting = await store.newResource({
        parent: meetingsFolder,
        isA: [dataBrowser.classes.chatroom, dataBrowser.classes.meeting],
        propVals: { [core.properties.name]: meetingName },
      });
      await meeting.save();

      const driveRes = await store.getResource(drive);
      driveRes.push(
        dataBrowser.properties.currentMeetings,
        [meeting.subject],
        true,
      );
      await driveRes.save();

      await sendChatMessage(store, {
        parent: meeting.subject,
        text: /* @wc-ignore */ 'Started the meeting.',
        extraClasses: [dataBrowser.classes.followEvent],
      }).catch(() => undefined);

      setActiveMeeting(meeting.subject);
      sessionStorage.setItem(meetingStorageKey(drive), meeting.subject);

      return meeting.subject;
    },
    [drive, store],
  );

  const endMeeting = useCallback(async (): Promise<void> => {
    if (!activeMeeting) return;

    await sendChatMessage(store, {
      parent: activeMeeting,
      text: /* @wc-ignore */ 'The meeting has ended.',
      extraClasses: [dataBrowser.classes.followEvent],
    }).catch(() => undefined);

    if (drive) {
      try {
        const driveRes = await store.getResource(drive);
        const current = (driveRes.get(dataBrowser.properties.currentMeetings) ??
          []) as string[];
        await driveRes.set(
          dataBrowser.properties.currentMeetings,
          current.filter(subject => subject !== activeMeeting),
        );
        await driveRes.save();
      } catch (e) {
        console.warn('[Meeting] could not de-list meeting:', e);
      }
    }

    setActiveMeeting(undefined);

    if (drive) {
      sessionStorage.removeItem(meetingStorageKey(drive));
    }
  }, [activeMeeting, drive, store]);

  const value = useMemo(
    () => ({
      followedAgent,
      followedResource,
      follow,
      unfollow,
      jumpToFollowed,
      followers,
      allowFollow,
      setAllowFollow,
      isFollowDisabledFor,
      followedSession,
      activeMeeting,
      startMeeting,
      endMeeting,
    }),
    [
      followedAgent,
      followedResource,
      follow,
      unfollow,
      jumpToFollowed,
      followers,
      allowFollow,
      setAllowFollow,
      isFollowDisabledFor,
      followedSession,
      activeMeeting,
      startMeeting,
      endMeeting,
    ],
  );

  return (
    <FollowContext.Provider value={value}>{children}</FollowContext.Provider>
  );
}

export function useFollow(): FollowContextValue {
  return useContext(FollowContext);
}
