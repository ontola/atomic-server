import { useStore } from '@tomic/react';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { styled } from 'styled-components';
import {
  CommandList,
  type CommandListRefType,
} from '../../chunks/RTE/SlashMenu/CommandList';
import type { SuggestionItem } from '../../chunks/RTE/types';
import type { MentionTrigger } from '../../helpers/chatMention';
import { getIconForClass } from '../../helpers/iconMap';
import { findMentionSubjects } from '../../helpers/mentionSearch';
import { useSettings } from '../../helpers/AppSettings';

export interface ChatMentionPickerHandle {
  /** Returns true when the key was used by the list. */
  onKeyDown: (key: string) => boolean;
}

interface ChatMentionPickerProps {
  trigger: MentionTrigger;
  onSelect: (subject: string, label: string) => void;
  handleRef: React.Ref<ChatMentionPickerHandle>;
}

const noop = () => undefined;

/**
 * The `@` suggestion list of the chat composer. Same search and list UI as the
 * `@` menu in documents, anchored above the composer.
 */
export const ChatMentionPicker = ({
  trigger,
  onSelect,
  handleRef,
}: ChatMentionPickerProps) => {
  const store = useStore();
  const { drive } = useSettings();
  const listRef = useRef<CommandListRefType>(null);
  const [results, setResults] = useState<{
    query: string;
    items: SuggestionItem[];
  }>();
  const { query } = trigger;

  useEffect(() => {
    let cancelled = false;

    findMentionSubjects(store, drive, query)
      .then(subjects =>
        Promise.all(subjects.map(subject => store.getResource(subject))),
      )
      .then(resources => {
        if (cancelled) return;
        setResults({
          query,
          items: resources.map(r => ({
            id: r.subject,
            title: r.title,
            icon: getIconForClass(r.getClasses()[0]),
            command: noop,
          })),
        });
      })
      .catch(e => {
        console.error('Mention search failed', e);
        if (!cancelled) setResults({ query, items: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [store, drive, query]);

  // Results for an earlier query are not shown for this one.
  const loading = results?.query !== query;
  const items = loading ? [] : (results?.items ?? []);

  useImperativeHandle(handleRef, () => ({
    onKeyDown: key => {
      if (items.length === 0) return false;

      return (
        listRef.current?.onKeyDown(new KeyboardEvent('keydown', { key })) ??
        false
      );
    },
  }));

  return (
    <Anchor data-testid='chat-mention-picker'>
      <CommandList
        ref={listRef}
        items={items}
        loading={loading}
        command={item => onSelect(item.id, item.title)}
      />
    </Anchor>
  );
};

const Anchor = styled.div`
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 0.25rem;
  z-index: 10;
  max-width: 100%;
`;
