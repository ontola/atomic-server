import { Extension, ReactRenderer } from '@tiptap/react';
import {
  Suggestion,
  type SuggestionOptions,
  type SuggestionProps,
} from '@tiptap/suggestion';
import { computePosition, flip, inline, shift } from '@floating-ui/dom';
import styles from '../floatingMenu.module.css';

import {
  CommandList,
  type CommandListProps,
  type CommandListRefType,
} from './CommandList';
import {
  FaCheck,
  FaCode,
  FaHeading,
  FaImage,
  FaLink,
  FaListOl,
  FaListUl,
  FaParagraph,
  FaQuoteLeft,
} from 'react-icons/fa6';
import type { SuggestionItem } from '../types';

export const SlashCommands = Extension.create({
  name: 'slashCommands',
  addOptions() {
    return {
      suggestion: {
        char: '/',
        // @ts-expect-error Tiptap typing is not very good or clear so they're just any.
        command: ({ editor, range, props }) => {
          props.command({ editor, range });
        },
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});

export const createRenderFunction =
  <ItemType>(container: HTMLElement): SuggestionOptions<ItemType>['render'] =>
  () => {
    let component: ReactRenderer<CommandListRefType, CommandListProps>;

    const updatePosition = (props: SuggestionProps<ItemType, ItemType>) => {
      if (!props.decorationNode) {
        return;
      }

      computePosition(props.decorationNode, component.element, {
        placement: 'bottom-start',
        middleware: [flip(), shift(), inline()],
      }).then(({ x, y }) => {
        component.element.style.setProperty('--left', `${x}px`);
        component.element.style.setProperty('--top', `${y}px`);
        container.appendChild(component.element);
      });
    };

    return {
      onStart(props) {
        component = new ReactRenderer(CommandList, {
          props,
          editor: props.editor,
          className: styles.renderer,
        });

        // Set the initial position, this position might be obstructed so we update the position again after we render the elements.
        updatePosition(props);

        requestAnimationFrame(() => {
          updatePosition(props);
        });
      },

      onUpdate(props) {
        component.updateProps(props);
        updatePosition(props);
      },

      onKeyDown(props) {
        if (props.event.key === 'Escape') {
          component.destroy();

          return true;
        }

        if (!component.ref) {
          return false;
        }

        return component.ref.onKeyDown(props.event);
      },

      onExit() {
        component.destroy();
      },
    };
  };

export const buildSuggestion = (
  container: HTMLElement,
): Partial<SuggestionOptions<SuggestionItem>> => ({
  items: async ({ query }: { query: string }): Promise<SuggestionItem[]> =>
    [
      {
        title: 'Bullet List',
        id: 'bullet-list',
        icon: FaListUl,
        command: ({ editor, range }) =>
          editor.chain().focus().deleteRange(range).toggleBulletList().run(),
      } as SuggestionItem,
      {
        title: 'Ordered List',
        id: 'ordered-list',
        icon: FaListOl,
        command: ({ editor, range }) =>
          editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
      } as SuggestionItem,
      {
        title: 'Task List',
        id: 'task-list',
        icon: FaCheck,
        command: ({ editor, range }) =>
          editor.chain().focus().deleteRange(range).toggleTaskList().run(),
      } as SuggestionItem,
      {
        title: 'Codeblock',
        id: 'codeblock',
        icon: FaCode,
        command: ({ editor, range }) =>
          editor.chain().focus().deleteRange(range).setNode('codeBlock').run(),
      } as SuggestionItem,
      {
        title: 'Quote',
        id: 'quote',
        icon: FaQuoteLeft,
        command: ({ editor, range }) =>
          editor.chain().focus().deleteRange(range).setBlockquote().run(),
      } as SuggestionItem,
      {
        title: 'Image',
        id: 'image',
        icon: FaImage,
        command: ({ editor, range }) =>
          editor.chain().focus().deleteRange(range).setImage({ src: '' }).run(),
      } as SuggestionItem,
      {
        title: 'Resource',
        id: 'resource',
        icon: FaLink,
        command: ({ editor, range }) =>
          editor.chain().focus().deleteRange(range).insertContent('@').run(),
      } as SuggestionItem,
      {
        title: 'Heading 1',
        id: 'heading-1',
        icon: FaHeading,
        command: ({ editor, range }) =>
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .setNode('heading', { level: 1 })
            .run(),
      } as SuggestionItem,
      {
        title: 'Heading 2',
        id: 'heading-2',
        icon: FaHeading,
        command: ({ editor, range }) =>
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .setNode('heading', { level: 2 })
            .run(),
      } as SuggestionItem,
      {
        title: 'Heading 3',
        id: 'heading-3',
        icon: FaHeading,
        command: ({ editor, range }) =>
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .setNode('heading', { level: 3 })
            .run(),
      } as SuggestionItem,
      {
        title: 'Heading 4',
        id: 'heading-4',
        icon: FaHeading,
        command: ({ editor, range }) =>
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .setNode('heading', { level: 4 })
            .run(),
      } as SuggestionItem,
      {
        title: 'Heading 5',
        id: 'heading-5',
        icon: FaHeading,
        command: ({ editor, range }) =>
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .setNode('heading', { level: 5 })
            .run(),
      } as SuggestionItem,
      {
        title: 'Heading 6',
        id: 'heading-6',
        icon: FaHeading,
        command: ({ editor, range }) =>
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .setNode('heading', { level: 6 })
            .run(),
      } as SuggestionItem,
      {
        title: 'Paragraph',
        id: 'paragraph',
        icon: FaParagraph,
        command: ({ editor, range }) =>
          editor.chain().focus().deleteRange(range).setNode('paragraph').run(),
      } as SuggestionItem,
    ].filter(item => item.title.toLowerCase().includes(query.toLowerCase())),

  render: createRenderFunction<SuggestionItem>(container),
});
