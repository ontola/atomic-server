import { ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';
import { computePosition, flip, inline, offset, shift } from '@floating-ui/dom';
import { getAllSkills } from '@chunks/AI/skills/skill';
import {
  MentionList,
  type MentionListProps,
  type MentionListRef,
} from './MentionList';
import type {
  CommandSuggestion,
  SearchSuggestion,
  SkillSuggestion,
} from './types';
import styles from '../floatingMenu.module.css';

enum CommandState {
  PickingCommand,
  PickingSkill,
}

const TOP_LEVEL_COMMANDS: CommandSuggestion[] = [
  {
    type: 'slash-command',
    id: 'compact',
    label: 'compact',
    description: 'Summarize and compress the conversation context',
  },
  {
    type: 'slash-command',
    id: 'skill',
    label: 'skill',
    description: 'Use a skill in this conversation',
  },
];

export function skillSuggestionBuilder(
  onCompact?: () => void,
): Partial<SuggestionOptions<SearchSuggestion>> {
  let state = CommandState.PickingCommand;
  let currentProps: SuggestionProps<SearchSuggestion, SearchSuggestion>;

  const items = ({ query }: { query: string }): SearchSuggestion[] => {
    const normalized = query.trim().toLowerCase();

    if (state === CommandState.PickingCommand) {
      const commands = onCompact
        ? TOP_LEVEL_COMMANDS
        : TOP_LEVEL_COMMANDS.filter(c => c.id !== 'compact');

      return normalized
        ? commands.filter(
            c =>
              c.id.includes(normalized) ||
              c.description.toLowerCase().includes(normalized),
          )
        : commands;
    }

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

    return filtered.map(
      (skill): SkillSuggestion => ({
        type: 'skill',
        id: skill.meta.id,
        label: skill.meta.name,
        description: skill.meta.description,
      }),
    );
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
          if (item.type === 'slash-command') {
            if (item.id === 'compact') {
              currentProps.editor
                .chain()
                .focus()
                .deleteRange(currentProps.range)
                .run();
              onCompact?.();
            } else if (item.id === 'skill') {
              state = CommandState.PickingSkill;

              // Delete the typed query text (e.g. "skill") while keeping the "/" trigger,
              // so the user doesn't need to backspace before searching for a skill.
              if (currentProps.query.length > 0) {
                currentProps.editor
                  .chain()
                  .focus()
                  .deleteRange({
                    from: currentProps.range.from + 1,
                    to: currentProps.range.to,
                  })
                  .run();
              }

              // Immediately show all skills without waiting for Tiptap's next onUpdate,
              // since currentProps.items still holds the stale command list.
              const newItems = items({ query: '' });
              component.updateProps(
                editPropsForMenu({
                  ...currentProps,
                  items: newItems,
                  query: '',
                }),
              );
              setPosition(currentProps);
            }

            return;
          }

          props.command(item);
        };

        // @ts-expect-error There is no way to type extra props of the component without causing type errors in the suggestion plugin.
        newProps.onSelect = onSelect;

        return newProps;
      };

      return {
        onStart: props => {
          currentProps = props;
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
          currentProps = oldProps;
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
          state = CommandState.PickingCommand;
          component.destroy();
        },
      };
    },
  };
}
