import { ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';
import { computePosition, flip, inline, offset, shift } from '@floating-ui/dom';
import { getAllSkills } from '@chunks/AI/skills/skill';
import {
  MentionList,
  type MentionListProps,
  type MentionListRef,
} from './MentionList';
import type { SearchSuggestion, SkillSuggestion } from './types';
import styles from '../floatingMenu.module.css';

export function skillSuggestionBuilder(): Partial<
  SuggestionOptions<SearchSuggestion>
> {
  const items = ({ query }: { query: string }): SkillSuggestion[] => {
    const normalized = query.trim().toLowerCase();
    const skills = getAllSkills();

    const filtered = normalized
      ? skills.filter(skill => {
          const nameMatch = skill.meta.name.toLowerCase().includes(normalized);
          const descMatch = skill.meta.description
            .toLowerCase()
            .includes(normalized);

          return nameMatch || descMatch;
        })
      : skills;

    return filtered.map(skill => ({
      type: 'skill' as const,
      id: skill.meta.id,
      label: skill.meta.name,
      description: skill.meta.description,
    }));
  };

  return {
    items,
    render() {
      let component: ReactRenderer<MentionListRef, MentionListProps>;

      const setPosition = (
        props: SuggestionProps<SearchSuggestion, SearchSuggestion>,
      ) => {
        if (!props.decorationNode) {
          return;
        }

        if (!component.element.parentElement) {
          document.body.appendChild(component.element);
        }

        computePosition(props.decorationNode, component.element, {
          placement: 'top',
          middleware: [flip(), shift(), inline(), offset(10)],
        }).then(({ x, y }) => {
          component.element.style.setProperty('--left', `${x}px`);
          component.element.style.setProperty('--top', `${y}px`);
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

      const editPropsForMenu = (
        props: SuggestionProps<SearchSuggestion, SearchSuggestion>,
      ): SuggestionProps<SearchSuggestion, SearchSuggestion> => {
        const newProps = { ...props };

        const onSelect = (item: SearchSuggestion) => {
          props.command(item);
        };

        // @ts-expect-error There is no way to type extra props of the component without causing type errors in the suggestion plugin.
        newProps.onSelect = onSelect;

        return newProps;
      };

      return {
        onStart: props => {
          const newProps = editPropsForMenu(props);
          component = new ReactRenderer(MentionList, {
            props: newProps,
            editor: props.editor,
            className: styles.renderer,
          });

          setPosition(props);

          requestAnimationFrame(() => {
            setPosition(props);
          });
        },

        onUpdate(oldProps) {
          const props = editPropsForMenu(oldProps);
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
          component.destroy();
        },
      };
    },
  };
}
