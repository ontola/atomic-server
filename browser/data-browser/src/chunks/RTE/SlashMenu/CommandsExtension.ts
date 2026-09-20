import { Extension, ReactRenderer } from '@tiptap/react';
import {
  Suggestion,
  type SuggestionOptions,
  type SuggestionProps,
} from '@tiptap/suggestion';
import { computePosition, flip, inline, shift } from '@floating-ui/dom';

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
    let component:
      | ReactRenderer<CommandListRefType, CommandListProps>
      | undefined;

    // Escape and `onExit` both end the popup, and either can run first — the
    // list is dismissed with Escape and @tiptap/suggestion then exits the
    // same suggestion. Dropping the reference as it is destroyed keeps the
    // later call from unmounting an already-unmounted renderer, and keeps
    // `onUpdate`/`onKeyDown` from addressing one: both bail on a missing
    // `component`, but neither could tell a live renderer from a dead one.
    const destroyComponent = () => {
      component?.destroy();
      component = undefined;
    };

    const updatePosition = (props: SuggestionProps<ItemType, ItemType>) => {
      // `onStart` schedules a second call on the next frame, and Escape can
      // destroy the renderer in between, so the reference is checked here
      // rather than only at the call sites.
      if (!props.decorationNode || !component) {
        return;
      }

      const element = component.element;
      // Adopt into the editor document before measuring iframe coordinates.
      container.appendChild(element);
      Object.assign(element.style, {
        position: 'absolute',
        width: 'max-content',
        zIndex: '1000',
      });
      computePosition(props.decorationNode, element, {
        placement: 'bottom-start',
        middleware: [flip(), shift(), inline()],
      }).then(({ x, y }) => {
        element.style.left = `${x}px`;
        element.style.top = `${y}px`;
      });
    };

    return {
      onStart(props) {
        component = new ReactRenderer(CommandList, {
          props: { ...props, ownerDocument: container.ownerDocument },
          editor: props.editor,
        });

        // Set the initial position, this position might be obstructed so we update the position again after we render the elements.
        updatePosition(props);

        requestAnimationFrame(() => {
          updatePosition(props);
        });
      },

      onUpdate(props) {
        if (!component) {
          return;
        }

        component.updateProps(props);
        updatePosition(props);
      },

      onKeyDown(props) {
        if (!component) {
          return false;
        }

        if (props.event.key === 'Escape') {
          destroyComponent();

          return true;
        }

        if (!component.ref) {
          return false;
        }

        return component.ref.onKeyDown(props.event);
      },

      onExit() {
        // `onStart` (which assigns `component`) runs after an internal
        // `await` in @tiptap/suggestion's plugin view update. If the editor
        // is destroyed in that window, `onExit` can fire before `onStart`
        // ever ran.
        destroyComponent();
      },
    };
  };

export const buildSuggestion = (
  container: HTMLElement,
  extraItems: SuggestionItem[] = [],
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
      ...extraItems,
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
