import { ReactRenderer } from '@tiptap/react';
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
import styles from '../floatingMenu.module.css';
import { computePosition, flip, inline, offset, shift } from '@floating-ui/dom';

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

      const setPosition = (
        props: SuggestionProps<SearchSuggestion, SearchSuggestion>,
      ) => {
        if (!props.decorationNode) {
          console.error('No decoration node');

          return;
        }

        computePosition(props.decorationNode, component.element, {
          placement: 'top',
          middleware: [flip(), shift(), inline(), offset(10)],
        }).then(({ x, y }) => {
          component.element.style.setProperty('--left', `${x}px`);
          component.element.style.setProperty('--top', `${y}px`);
          document.body.appendChild(component.element);
        });
      };

      const update = (
        newP: SuggestionProps<SearchSuggestion, SearchSuggestion>,
      ) => {
        component.updateProps(newP);

        if (!newP.clientRect) {
          return;
        }

        setPosition(newP);
      };

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
            className: styles.renderer,
          });

          setPosition(props);
        },

        onUpdate(oldProps) {
          const props = editPropsForMenus(oldProps);
          update(props);
        },

        onKeyDown(props) {
          if (props.event.key === 'Escape') {
            component.destroy();

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
          component.destroy();
        },
      };
    },
  };
}
