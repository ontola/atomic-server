import { ReactRenderer } from '@tiptap/react';
import tippy, { type Instance } from 'tippy.js';
import {
  MentionList,
  type MentionListProps,
  type MentionListRef,
} from './MentionList';
import type { Store } from '@tomic/react';
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';
import type { SearchResourcesOfServer } from '@components/AI/MCP/useMcpServers';
import type { MCPServer } from '@chunks/AI/types';
import type { CategorySuggestion, SearchSuggestion } from './types';

enum SuggestionState {
  PickingCategory,
  PickingAtomicResource,
  PickingMCPResource,
}

export function searchSuggestionBuilder(
  store: Store,
  drive: string,
  servers: MCPServer[],
  searchInServer: SearchResourcesOfServer,
): Partial<SuggestionOptions<SearchSuggestion>> {
  let state = SuggestionState.PickingCategory;
  let currentCategory: string;

  const buildCategoryList = (): CategorySuggestion[] => {
    return [
      {
        type: 'category',
        id: 'category-atomic-data',
        label: 'Atomic Data',
      },
      ...servers.map(server => ({
        type: 'category' as const,
        id: `category-mcp-${server.id}`,
        label: server.name,
      })),
    ];
  };

  const items = async ({
    query,
  }: {
    query: string;
  }): Promise<SearchSuggestion[]> => {
    if (state === SuggestionState.PickingCategory) {
      return buildCategoryList();
    }

    if (state === SuggestionState.PickingAtomicResource) {
      const results = await store.search(query, {
        limit: 10,
        include: true,
        parents: [drive],
      });

      const resultResources = await Promise.all(
        results.map(subject => store.getResource(subject)),
      );

      return resultResources.map(resource => ({
        type: 'atomic-resource',
        id: resource.subject,
        label: resource.title,
        isA: resource.getClasses(),
      }));
    }

    if (state === SuggestionState.PickingMCPResource) {
      try {
        const serverId = currentCategory.replace(/^category-mcp-/, '');
        const results = await searchInServer(serverId, query, 10);

        return results.map(resource => ({
          type: 'mcp-resource',
          id: resource.uri,
          serverId,
          label: resource.name,
          mimeType: resource.mimeType,
        }));
      } catch (error) {
        console.error(error);

        return [];
      }
    }

    throw new Error('Invalid state');
  };

  return {
    items,
    render() {
      let component: ReactRenderer<MentionListRef, MentionListProps>;
      let popup: Instance[];

      const update = (
        newP: SuggestionProps<SearchSuggestion, SearchSuggestion>,
      ) => {
        component.updateProps(newP);

        if (!newP.clientRect) {
          return;
        }

        popup[0].setProps({
          getReferenceClientRect: newP.clientRect as () => DOMRect,
        });
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const editPropsForMenus = (
        props: SuggestionProps<SearchSuggestion, SearchSuggestion>,
      ): SuggestionProps<SearchSuggestion, SearchSuggestion> => {
        const newProps = { ...props };

        if (state === SuggestionState.PickingCategory && props.query) {
          state = SuggestionState.PickingAtomicResource;
        }

        const onSelect = async (item: SearchSuggestion) => {
          if (item.type === 'category') {
            currentCategory = item.id;

            if (item.id === 'category-atomic-data') {
              state = SuggestionState.PickingAtomicResource;
            } else if (item.id.startsWith('category-mcp-')) {
              state = SuggestionState.PickingMCPResource;
            }

            const newList = await items({ query: props.query });
            newProps.items = newList;

            update(newProps);
          } else {
            props.command(item);
          }
        };

        // @ts-expect-error There is no way to type extra props of the component without causing type errors in the suggestion plugin.
        newProps.onSelect = onSelect;

        return newProps;
      };

      return {
        onStart: props => {
          state = SuggestionState.PickingCategory;

          const newProps = editPropsForMenus(props);
          component = new ReactRenderer(MentionList, {
            props: newProps,
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
            placement: 'top-start',
          });
        },

        onUpdate(oldProps) {
          const props = editPropsForMenus(oldProps);
          update(props);
        },

        onKeyDown(props) {
          if (props.event.key === 'Escape') {
            popup[0].hide();

            return true;
          }

          if (!component.ref) {
            return false;
          }

          // @ts-expect-error Tiptap uses a different event type from React but the core properties are the same.
          return component.ref.onKeyDown(props);
        },

        onExit() {
          state = SuggestionState.PickingCategory;
          popup[0].destroy();
          component.destroy();
        },
      };
    },
  };
}
