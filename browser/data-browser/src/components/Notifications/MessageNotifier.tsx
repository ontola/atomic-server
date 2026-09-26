import { useEffect, useEffectEvent, useRef } from 'react';
import toast from 'react-hot-toast';
import { styled } from 'styled-components';
import {
  core,
  dataBrowser,
  StoreEvents,
  useCurrentAgent,
  useStore,
  type Resource,
  type Store,
} from '@tomic/react';
import { AgentAvatar } from '../Presence/AgentAvatar';
import { useRightPanel } from '../RightPanel/RightPanelContext';
import { useCurrentSubject } from '../../helpers/useCurrentSubject';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../../helpers/navigation';
import {
  classifyMessage,
  isCandidate,
  type MessageFacts,
  type MessageNotification,
} from '../../helpers/notifications/messageNotification';
import { showOsNotification } from '../../helpers/notifications/osNotifications';
import {
  markReadAbout,
  recordNotification,
} from '../../helpers/notifications/inbox';
import { usePrivateDrive } from '../../hooks/usePrivateDrive';

const TEXT_MAX = 140;

/** Messages created before the app started are backlog, not news. */
const APP_STARTED = Date.now();

function factsOf(resource: Resource): MessageFacts {
  const stable = resource.stable;

  const str = (prop: string) => {
    const v = stable.get(prop);

    return typeof v === 'string' ? v : undefined;
  };

  return {
    subject: stable.subject,
    isA: (stable.get(core.properties.isA) as string[] | undefined) ?? [],
    createdAt: stable.getCreatedAt(),
    createdBy: stable.getCreatedBy(),
    parent: str(core.properties.parent),
    about: str(dataBrowser.properties.about),
    replyTo: str(dataBrowser.properties.replyTo),
  };
}

async function loadAll(store: Store, subjects: (string | undefined)[]) {
  const loaded = new Map<string, Resource>();
  await Promise.all(
    subjects.map(async s => {
      if (!s) return;
      const r = await store.getResource(s);
      if (!r.error) loaded.set(s, r);
    }),
  );

  return loaded;
}

function headline(
  kind: MessageNotification['kind'],
  author: string,
  on: string,
) {
  switch (kind) {
    case 'reply':
      return `${author} replied to you`;
    case 'comment':
      return `${author} commented on ${on}`;
    case 'chat':
      return `${author} in ${on}`;
  }
}

/**
 * Tells you about new chat messages, comments on things you made and replies
 * to you, while the app is open. A toast when you're looking at the app, an
 * OS notification when you aren't (another tab, window or app), and nothing
 * when you're already looking at the conversation. Only messages created
 * after the app started count: the backlog is not news. Renders nothing.
 */
export function MessageNotifier(): null {
  const store = useStore();
  const [agent] = useCurrentAgent();
  const [currentSubject] = useCurrentSubject();
  const { activePanel, setPanelOpen } = useRightPanel();
  const navigate = useNavigateWithTransition();
  const { privateDrive } = usePrivateDrive();

  const handled = useRef(new Set<string>());
  // Inbox writes still in flight, per target, so reading waits for them.
  const recording = useRef(new Map<string, Promise<unknown>>());

  const readAbout = useEffectEvent((target: string) => {
    if (!privateDrive) return;

    const pending = recording.current.get(target) ?? Promise.resolve();

    void pending
      .then(() => markReadAbout(store, privateDrive, target))
      .catch(e => console.error('Could not mark notifications read:', e));
  });

  const open = useEffectEvent((n: MessageNotification) => {
    navigate(constructOpenURL(n.target));
    if (n.openComments) setPanelOpen('comments', true);
    readAbout(n.target);
  });

  // Opening something reads what the Inbox says about it.
  useEffect(() => {
    if (currentSubject) readAbout(currentSubject);
  }, [currentSubject]);

  const isLookingAt = useEffectEvent((n: MessageNotification) => {
    if (document.hidden || !document.hasFocus()) return false;
    if (!currentSubject) return false;

    if (
      store.normalizeSubject(currentSubject) !==
      store.normalizeSubject(n.target)
    ) {
      return false;
    }

    return !n.openComments || activePanel === 'comments';
  });

  const onUpdate = useEffectEvent(async (resource: Resource) => {
    const subject = resource.stable.subject;

    if (handled.current.has(subject)) return;

    const facts = factsOf(resource);
    const ctx = { me: agent?.subject, since: APP_STARTED };
    const candidate = isCandidate(facts, ctx);

    // Not decidable yet: its genesis hasn't arrived. A later update will ask again.
    if (candidate === undefined) return;

    handled.current.add(subject);

    if (!candidate) return;

    const related = await loadAll(store, [
      facts.parent,
      facts.about,
      facts.replyTo,
      facts.createdBy,
    ]);
    const n = classifyMessage(facts, {
      ...ctx,
      classesOf: s =>
        related.get(s)?.get(core.properties.isA) as string[] | undefined,
      creatorOf: s => related.get(s)?.getCreatedBy(),
    });

    if (!n) return;

    if (isLookingAt(n)) {
      // Another open device may still record it; read that copy too.
      setTimeout(() => readAbout(n.target), 3000);

      return;
    }

    const authorName = related.get(n.author)?.title ?? 'Someone';
    const targetTitle = related.get(n.target)?.title ?? '';
    const title = headline(n.kind, authorName, targetTitle);
    const text =
      (resource.stable.get(core.properties.description) as
        | string
        | undefined) ?? '';
    const body = text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text;

    if (privateDrive) {
      const before = recording.current.get(n.target);
      const record = recordNotification(store, privateDrive, {
        source: subject,
        about: n.target,
        kind: n.kind,
        actor: n.author,
        title,
        body,
        occurredAt: facts.createdAt ?? Date.now(),
      }).catch(e => console.error('Could not add to the inbox:', e));
      const all = Promise.all([before, record]);
      recording.current.set(n.target, all);
      void all.then(() => {
        if (recording.current.get(n.target) === all) {
          recording.current.delete(n.target);
        }
      });
    }

    if (!document.hidden && document.hasFocus()) {
      toast.custom(
        t => (
          <ToastCard
            type='button'
            onClick={() => {
              open(n);
              toast.dismiss(t.id);
            }}
          >
            <AgentAvatar agentSubject={n.author} size='1.8rem' />
            <ToastBody>
              <ToastTitle>{title}</ToastTitle>
              <ToastText>{body}</ToastText>
            </ToastBody>
          </ToastCard>
        ),
        { duration: 6000, id: subject },
      );

      return;
    }

    showOsNotification({ title, body, tag: subject, onClick: () => open(n) });
  });

  useEffect(
    () =>
      store.on(StoreEvents.ResourceUpdated, resource => {
        void onUpdate(resource).catch(e =>
          console.error('Could not show a notification:', e),
        );
      }),
    [store],
  );

  return null;
}

const ToastCard = styled.button`
  display: flex;
  align-items: center;
  gap: 0.6rem;
  max-width: 22rem;
  padding: 0.6rem 0.8rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg};
  box-shadow: ${p => p.theme.boxShadowSoft};
  cursor: pointer;
  text-align: left;
  color: ${p => p.theme.colors.text};
`;

const ToastBody = styled.span`
  display: flex;
  flex-direction: column;
  min-width: 0;
`;

const ToastTitle = styled.span`
  font-weight: 600;
  font-size: 0.8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const ToastText = styled.span`
  font-size: 0.85rem;
  color: ${p => p.theme.colors.textLight};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;
