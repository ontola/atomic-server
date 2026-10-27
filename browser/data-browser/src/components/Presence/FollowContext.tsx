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
  useDrivePresenceManager,
  useStore,
  type PresenceItem,
  type Store,
} from '@tomic/react';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../../helpers/navigation';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useCurrentSubject } from '../../helpers/useCurrentSubject';
import { sendChatMessage } from '../../views/ChatRoom/ChatRoomView';
import { isEmbedded } from '../../helpers/embedMode';
import { hostFollow, hostUnfollow } from '../../embed/hostActions';
import { useHostFollow } from '../../embed/presenceBridge';

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
  /** Create a Meeting agenda without making it live. */
  createMeeting: (name?: string) => Promise<string>;
  /** Start a prepared Meeting, or create one for quick-start. */
  startMeeting: (name?: string, subject?: string) => Promise<string>;
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
  createMeeting: async () => '',
  startMeeting: async () => '',
  endMeeting: async () => undefined,
} satisfies FollowContextValue);

/** sessionStorage key for the meeting a tab is leading on a given drive.
 *  Per-tab + per-drive, so a refresh resumes the meeting but a closed tab
 *  forgets it. */
const meetingStorageKey = (drive: string): string =>
  `atomic.activeMeeting:${drive}`;

/** sessionStorage key marking that this tab already announced joining a given
 *  meeting. Per-tab + per-meeting, so a refresh mid-meeting doesn't re-post
 *  "Joined", but a closed/reopened tab announces again. */
const joinAnnounceKey = (meeting: string): string =>
  `atomic.joinedMeeting:${meeting}`;

/** Record that this agent joined a live meeting — the same follow-event trail
 *  as Start/End, authored by the joiner so the chat shows who arrived. */
async function postMeetingJoin(store: Store, meeting: string): Promise<void> {
  await sendChatMessage(store, {
    parent: meeting,
    text: /* @wc-ignore */ 'Joined the meeting.',
    extraClasses: [dataBrowser.classes.followEvent],
  });
}

/** Record a departure — but only while the meeting is still live. Once it has
 *  ended, "The meeting has ended." already closes the log, and every
 *  follower's auto-unfollow would otherwise post a redundant "Left". */
async function postMeetingLeave(store: Store, meeting: string): Promise<void> {
  const resource = await store.getResource(meeting);

  if (resource.get(dataBrowser.properties.meetingEndedAt)) {
    return;
  }

  await sendChatMessage(store, {
    parent: meeting,
    text: /* @wc-ignore */ 'Left the meeting.',
    extraClasses: [dataBrowser.classes.followEvent],
  });
}

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
  // In the Flutter app's embed the app owns following: it navigates and keeps
  // who is followed, the page mirrors it and asks (`hostFollow`).
  const embedded = isEmbedded();
  const hostFollowed = useHostFollow();
  const [ownFollowed, setFollowedAgent] = useState<string>();
  const followedAgent = embedded ? hostFollowed : ownFollowed;
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

  // Not the drive's channel when this agent can't read the drive.
  const manager = useDrivePresenceManager();

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
    // The app navigates to the leader when embedded; doing it here too would
    // be a second implementation fighting the first.
    if (embedded) return;

    if (followedResource && followedResource !== lastNavigatedRef.current) {
      lastNavigatedRef.current = followedResource;
      navigate(constructOpenURL(followedResource));
    }

    if (!followedAgent) {
      lastNavigatedRef.current = undefined;
    }
  }, [embedded, followedResource, followedAgent, navigate]);

  // Stop silently when the followed agent goes offline (presence expired)
  // or announces that they don't want to be followed.
  useEffect(() => {
    if (!followedAgent) {
      return;
    }

    if (embedded) {
      // The app stops on its own when the leader leaves the drive; the opt-out
      // is only known here.
      if (isFollowDisabledFor(followedAgent)) hostUnfollow();

      return;
    }

    if (
      !presence.some(item => item.agent === followedAgent) ||
      isFollowDisabledFor(followedAgent)
    ) {
      setFollowedAgent(undefined);
    }
  }, [embedded, presence, followedAgent, isFollowDisabledFor]);

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
  const meetingNarrationRef = useRef<Promise<void>>(Promise.resolve());

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
    // The app does not post it twice: nothing here when embedded.
    if (!activeMeeting || !currentSubject || embedded) {
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
  }, [activeMeeting, currentSubject, embedded, store]);

  // The meeting of the agent WE follow, from their presence entry.
  const followedSession = useMemo(() => {
    if (!followedAgent) {
      return undefined;
    }

    return presence.find(item => item.agent === followedAgent && item.session)
      ?.session;
  }, [presence, followedAgent]);

  // Record join/leave in the meeting chat, mirroring Start/End. The leader is
  // already recorded by the Start marker, so only a *joiner* announces here —
  // and the meeting a joiner is in is exactly `followedSession`. Announce when
  // it appears, and a departure when we explicitly leave (unfollow); a meeting
  // that simply ended is filtered out by `postMeetingLeave` so it doesn't spam
  // "Left" for every follower on top of "The meeting has ended.".
  const announcedJoinRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const joined = activeMeeting ? undefined : followedSession;
    const previous = announcedJoinRef.current;

    if (joined === previous || !agentSubject) {
      return;
    }

    announcedJoinRef.current = joined;

    if (previous && sessionStorage.getItem(joinAnnounceKey(previous))) {
      sessionStorage.removeItem(joinAnnounceKey(previous));
      void postMeetingLeave(store, previous).catch(() => undefined);
    }

    if (joined && !sessionStorage.getItem(joinAnnounceKey(joined))) {
      sessionStorage.setItem(joinAnnounceKey(joined), '1');
      void postMeetingJoin(store, joined).catch(() => undefined);
    }
  }, [activeMeeting, followedSession, agentSubject, store]);

  const follow = useCallback(
    (subject: string) => {
      if (embedded) {
        hostFollow(subject);
      } else {
        setFollowedAgent(subject);
      }
    },
    [embedded],
  );

  const unfollow = useCallback(() => {
    if (embedded) {
      hostUnfollow();
    } else {
      setFollowedAgent(undefined);
    }
  }, [embedded]);

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

  const createMeeting = useCallback(
    async (name?: string): Promise<string> => {
      if (!drive) {
        throw new Error('Cannot create a meeting without a drive.');
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

      const meeting = await store.newResource({
        parent: drive,
        isA: dataBrowser.classes.meeting,
        propVals: { [core.properties.name]: meetingName },
      });
      await meeting.save();

      return meeting.subject;
    },
    [drive, store],
  );

  const startMeeting = useCallback(
    async (name?: string, preparedSubject?: string): Promise<string> => {
      if (!drive || !agentSubject) {
        throw new Error('Cannot start a meeting without a drive and agent.');
      }

      const subject = preparedSubject ?? (await createMeeting(name));
      const meeting = await store.getResource(subject);
      const startedAt = meeting.get(dataBrowser.properties.meetingStartedAt) as
        | number
        | undefined;

      if (!startedAt) {
        await meeting.set(
          dataBrowser.properties.meetingStartedAt,
          Date.now(),
          false,
        );
        await meeting.set(
          dataBrowser.properties.meetingLeader,
          agentSubject,
          false,
        );
        await meeting.save();
      }

      const driveRes = await store.getResource(drive);
      const current = (driveRes.get(dataBrowser.properties.currentMeetings) ??
        []) as string[];

      if (!current.includes(subject)) {
        await driveRes.set(dataBrowser.properties.currentMeetings, [
          ...current,
          subject,
        ]);
        await driveRes.save();
      }

      trailMeetingRef.current = subject;
      trailedRef.current = new Set([subject]);
      setActiveMeeting(subject);
      sessionStorage.setItem(meetingStorageKey(drive), subject);
      navigate(constructOpenURL(subject));

      // Chat narration is useful history, but it must not block the visible
      // start transition or make the top-bar button appear unresponsive.
      if (!startedAt) {
        const startMessage = sendChatMessage(store, {
          parent: subject,
          text: /* @wc-ignore */ 'Started the meeting.',
          extraClasses: [dataBrowser.classes.followEvent],
        }).catch(() => undefined);
        meetingNarrationRef.current = startMessage;

        if (!embedded) {
          void startMessage
            .then(() => postTrailMessage(store, subject, subject))
            .catch(() => undefined);
        }
      }

      return subject;
    },
    [agentSubject, createMeeting, drive, embedded, navigate, store],
  );

  const endMeeting = useCallback(async (): Promise<void> => {
    if (!activeMeeting) return;

    const endingMeeting = activeMeeting;
    const meeting = await store.getResource(endingMeeting);
    const endedAt = meeting.get(dataBrowser.properties.meetingEndedAt) as
      | number
      | undefined;

    if (!endedAt) {
      // Preserve marker order when Start's non-blocking narration is still
      // being persisted.
      await meetingNarrationRef.current;
      await sendChatMessage(store, {
        parent: endingMeeting,
        text: /* @wc-ignore */ 'The meeting has ended.',
        extraClasses: [dataBrowser.classes.followEvent],
      }).catch(() => undefined);
      await meeting.set(dataBrowser.properties.meetingEndedAt, Date.now());
      await meeting.save();
    }

    if (drive) {
      try {
        const driveRes = await store.getResource(drive);
        const current = (driveRes.get(dataBrowser.properties.currentMeetings) ??
          []) as string[];
        await driveRes.set(
          dataBrowser.properties.currentMeetings,
          current.filter(subject => subject !== endingMeeting),
        );
        await driveRes.save();
      } catch (e) {
        console.warn('[Meeting] could not de-list meeting:', e);
      }
    }

    // Do not let a slow End completion clear a newer meeting that was started
    // from the top bar in the meantime.
    setActiveMeeting(current =>
      current === endingMeeting ? undefined : current,
    );

    if (drive) {
      const storageKey = meetingStorageKey(drive);

      if (sessionStorage.getItem(storageKey) === endingMeeting) {
        sessionStorage.removeItem(storageKey);
      }
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
      createMeeting,
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
      createMeeting,
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
