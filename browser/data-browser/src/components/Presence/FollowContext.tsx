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
  dataBrowser,
  useCurrentAgent,
  useDrive,
  useDrivePresence,
  useResource,
  useStore,
  useString,
  type PresenceItem,
  type Store,
} from '@tomic/react';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../../helpers/navigation';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useCurrentSubject } from '../../helpers/useCurrentSubject';
import { getOrCreateFollowSessionsChatroom } from '../../helpers/standardLocations';
import { sendChatMessage } from '../../views/ChatRoom/ChatRoomView';

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
  /** ChatRoom logging OUR follow sessions (we are the one being followed). */
  sessionChatroom: string | undefined;
  /** ChatRoom logging the followed agent's session (we are the follower). */
  followedSession: string | undefined;
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
  sessionChatroom: undefined,
  followedSession: undefined,
});

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
  // The drive's pointer is the live source of truth for the session
  // chatroom. Two leaders racing on first creation each write it; LWW picks
  // one, and this subscription makes every client converge on the winner.
  const driveResource = useResource(drive);
  const [sessionChatroom] = useString(
    driveResource,
    dataBrowser.properties.followSessionsChatroom,
  );
  // What THIS client created during the race, so it can clean up on loss.
  const createdChatroomRef = useRef<string>(undefined);

  const manager = drive ? store.getPresence(drive) : undefined;

  // Announce the follow-related fields on our presence entry. Runs on
  // manager changes too (drive switch resets the entry).
  useEffect(() => {
    if (manager && agentSubject) {
      manager.patchLocal({
        following: followedAgent,
        session: sessionChatroom,
        // Absent means followable — only announce the opt-out.
        allowFollow: allowFollow ? undefined : false,
      });
    }
  }, [manager, agentSubject, followedAgent, allowFollow, sessionChatroom]);

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

  // === Session trail (we are the one being followed) ===
  // While followed, log which resources we visit into the drive's
  // follow-sessions ChatRoom, so sessions can be reviewed and discussed
  // afterwards. Plain Messages — no new primitive.
  const hasFollowers = followers.length > 0;
  const sessionActiveRef = useRef(false);
  const lastTrailRef = useRef<string>(undefined);

  // The chatroom belongs to the drive; reset session state when switching.
  useEffect(() => {
    sessionActiveRef.current = false;
    createdChatroomRef.current = undefined;
  }, [drive]);

  useEffect(() => {
    if (!hasFollowers || !drive || sessionChatroom) {
      return;
    }

    getOrCreateFollowSessionsChatroom(store, drive)
      .then(created => {
        createdChatroomRef.current = created;
      })
      .catch(e => console.warn('[Follow] session chatroom unavailable:', e));
  }, [hasFollowers, drive, sessionChatroom, store]);

  // Race lost: another leader's pointer write won. Our freshly created
  // chatroom (holding at most our own session marker) is an orphan in the
  // drive — remove it and continue in the winner.
  useEffect(() => {
    const created = createdChatroomRef.current;

    if (!created || !sessionChatroom || created === sessionChatroom) {
      return;
    }

    createdChatroomRef.current = undefined;
    store
      .getResource(created)
      .then(orphan => orphan.destroy())
      .catch(e => console.warn('[Follow] orphan cleanup failed:', e));
  }, [sessionChatroom, store]);

  // Session start / end markers.
  useEffect(() => {
    if (!sessionChatroom) {
      return;
    }

    if (hasFollowers && !sessionActiveRef.current) {
      sessionActiveRef.current = true;
      lastTrailRef.current = undefined;
      sendChatMessage(store, {
        parent: sessionChatroom,
        text: /* @wc-ignore */ 'Started a follow session.',
        extraClasses: [dataBrowser.classes.followEvent],
      }).catch(() => undefined);
    } else if (!hasFollowers && sessionActiveRef.current) {
      sessionActiveRef.current = false;
      sendChatMessage(store, {
        parent: sessionChatroom,
        text: /* @wc-ignore */ 'Ended the follow session.',
        extraClasses: [dataBrowser.classes.followEvent],
      }).catch(() => undefined);
    }
  }, [hasFollowers, sessionChatroom, store]);

  // One trail entry per visited resource while followed.
  useEffect(() => {
    if (!hasFollowers || !sessionChatroom || !currentSubject) {
      return;
    }

    if (lastTrailRef.current === currentSubject) {
      return;
    }

    lastTrailRef.current = currentSubject;
    postTrailMessage(store, sessionChatroom, currentSubject).catch(
      () => undefined,
    );
  }, [hasFollowers, sessionChatroom, currentSubject, store]);

  // The session chatroom of the agent WE follow, from their presence entry.
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
      sessionChatroom,
      followedSession,
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
      sessionChatroom,
      followedSession,
    ],
  );

  return (
    <FollowContext.Provider value={value}>{children}</FollowContext.Provider>
  );
}

export function useFollow(): FollowContextValue {
  return useContext(FollowContext);
}
