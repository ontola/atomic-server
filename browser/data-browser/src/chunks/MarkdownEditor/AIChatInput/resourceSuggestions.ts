import { ReactRenderer } from '@tiptap/react';
import tippy, { type Instance } from 'tippy.js';
import {
  MentionList,
  type MentionListProps,
  type MentionListRef,
  type SearchSuggestion,
} from './MentionList';
import type { Store } from '@tomic/react';
import type { SuggestionOptions } from '@tiptap/suggestion';

export const searchSuggestionBuilder = (
  store: Store,
  drive: string,
): Partial<SuggestionOptions> => ({
  items: async ({ query }: { query: string }): Promise<SearchSuggestion[]> => {
    const results = await store.search(query, {
      limit: 10,
      include: true,
      parents: [drive],
    });

    const resultResources = await Promise.all(
      results.map(subject => store.getResource(subject)),
    );

    return resultResources.map(resource => ({
      id: resource.subject,
      label: resource.title,
    }));
  },

  render: () => {
    let component: ReactRenderer<MentionListRef, MentionListProps>;
    let popup: Instance[];

    return {
      onStart: props => {
        component = new ReactRenderer(MentionList, {
          props,
          editor: props.editor,
        });

        if (!props.clientRect) {
          return;
        }

        popup = tippy('body', {
          getReferenceClientRect: props.clientRect as () => DOMRect,
          appendTo: () => document.body,
          content: component.element,
          showOnCreate: true,
          interactive: true,
          trigger: 'manual',
          placement: 'bottom-start',
        });
      },

      onUpdate(props) {
        component.updateProps(props);

        if (!props.clientRect) {
          return;
        }

        popup[0].setProps({
          getReferenceClientRect: props.clientRect as () => DOMRect,
        });
      },

      onKeyDown(props) {
        if (props.event.key === 'Escape') {
          popup[0].hide();

          return true;
        }

        if (!component.ref) {
          return false;
        }

        return component.ref.onKeyDown(props);
      },

      onExit() {
        popup[0].destroy();
        component.destroy();
      },
    };
  },
});
