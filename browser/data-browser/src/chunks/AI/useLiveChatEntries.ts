import { useEffect, useRef } from 'react';
import {
  core,
  useCollection,
  useStore,
  type Ai,
  type Resource,
} from '@tomic/react';
import { ONLY_CHAT_LOGS } from '@helpers/chatLog';
import {
  loadChatMessages,
  mergeLiveMessages,
  pagesOf,
  queueChatWrite,
  savedMessageId,
  type AiMessageRef,
} from './chatConversionUtils';
import type { AtomicUIMessage } from './types';

/**
 * Keeps a saved chat on screen in step with its log: entries another device or
 * tab adds (or edits) appear without a refresh. It follows the chat's pages
 * (a new page shows up in the collection) and reloads when any of them
 * changes. Nothing happens while a reply is being generated, so the in-flight
 * message is never touched.
 *
 * `onSynced` gets the refs of the messages that were added or replaced, so
 * the parent can keep its message to ref map complete.
 */
export function useLiveChatEntries({
  chatSubject,
  idle,
  messages,
  setMessages,
  onSynced,
}: {
  chatSubject: string | undefined;
  /** No reply is streaming or being sent. */
  idle: boolean;
  messages: AtomicUIMessage[];
  setMessages: (messages: AtomicUIMessage[]) => void;
  onSynced?: (added: Map<AtomicUIMessage, AiMessageRef>) => void;
}) {
  const store = useStore();
  // The collection is live: a page created elsewhere changes its size.
  const { collection } = useCollection({
    property: core.properties.parent,
    // A draft chat has no server side; this asks for nothing that exists.
    value: chatSubject ?? 'did:ad:none',
    filters: ONLY_CHAT_LOGS,
  });
  const pageCount = collection.totalMembers;

  const latest = useRef({ messages, idle, setMessages, onSynced });
  latest.current = { messages, idle, setMessages, onSynced };

  useEffect(() => {
    if (!chatSubject || !idle) return;

    let disposed = false;
    const unsubscribers: Array<() => void> = [];

    const reload = async (chat: Resource<Ai.AiChat>) => {
      // After the writes still queued, so a message just saved is known by its ref.
      const loaded = await queueChatWrite(chat, () =>
        loadChatMessages(chat, store),
      );

      if (disposed || !latest.current.idle) return;

      const all = Array.from(loaded.keys());
      const summary = all.findLastIndex(m => m.metadata?.isSummary);
      const visible = summary > 0 ? all.slice(summary) : all;
      const { messages: merged, changed } = mergeLiveMessages(
        latest.current.messages,
        visible,
        m => savedMessageId(chat, m),
      );

      if (!changed) return;

      const shown = new Set(merged);
      latest.current.setMessages(merged);
      latest.current.onSynced?.(
        new Map([...loaded].filter(([message]) => shown.has(message))),
      );
    };

    void (async () => {
      const chat = await store.getResource<Ai.AiChat>(chatSubject);
      const pages = await pagesOf(chat, store, { refresh: true });

      if (disposed) return;

      const onChange = () => void reload(chat).catch(console.warn);

      for (const page of pages) {
        unsubscribers.push(store.subscribe(page, onChange));
      }

      // A page that arrived since the last look.
      onChange();
    })().catch(error => console.warn('Could not follow the chat', error));

    return () => {
      disposed = true;
      unsubscribers.forEach(unsubscribe => unsubscribe());
    };
  }, [chatSubject, idle, pageCount, store]);
}
