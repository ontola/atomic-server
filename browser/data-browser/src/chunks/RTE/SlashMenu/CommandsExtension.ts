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

/**
 * The suggestion the user dismissed with Escape, shared between the renderer
 * (which sees the key) and `shouldResetDismissed` (which decides when the menu
 * is allowed back). One per suggestion instance.
 *
 * @tiptap/suggestion keeps a `dismissedRange` of its own, but two things about
 * it do not survive a collaborative document:
 *
 * 1. A dismissal is remembered by POSITION, and the range is remapped through
 *    every transaction. When a remote update lands, loro-prosemirror replaces
 *    the whole document, and a full-document ReplaceStep maps the dismissed
 *    start (1) to the end of the replacement (6). The plugin then sees a fresh
 *    match at 1 that no longer equals the dismissal at 6, drops the dismissal
 *    and reopens the menu the user just closed. Typing in a shared document
 *    produces exactly such an echo, so the menu came back on its own.
 * 2. Editing the query does NOT bring a dismissed menu back: the dismissal is
 *    only cleared by whitespace, by deleting the trigger, or by moving away.
 *    So after Escape, `/quo` → Backspace → `o` stayed closed, and in a shared
 *    document it reopened only because the echo above happened to land.
 *
 * Together those made the slash and mention menus reopen on a network event
 * and not on a keystroke. Tracking the dismissed text ourselves fixes both:
 * the renderer ignores a reopen of the very token that was dismissed, and
 * `shouldResetDismissed` lets the menu back the moment the user edits it.
 */
export type SuggestionDismissal = {
  current: { from: number; text: string } | undefined;
};

export const createSuggestionDismissal = (): SuggestionDismissal => ({
  current: undefined,
});

/**
 * Let a dismissed suggestion become active again as soon as the user changes
 * the token it was dismissed on, rather than only on whitespace or a delete.
 */
export const resetDismissedOnEdit =
  (dismissal: SuggestionDismissal): SuggestionOptions['shouldResetDismissed'] =>
  ({ match }) =>
    dismissal.current !== undefined && match.text !== dismissal.current.text;

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
  <ItemType>(
    container: HTMLElement,
    dismissal: SuggestionDismissal = createSuggestionDismissal(),
  ): SuggestionOptions<ItemType>['render'] =>
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
      // `component` is unset once the renderer is destroyed, and the
      // `requestAnimationFrame` in `onStart` can land after that: measuring
      // then would reach through an already-unmounted element.
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

    const mount = (props: SuggestionProps<ItemType, ItemType>) => {
      dismissal.current = undefined;
      component = new ReactRenderer(CommandList, {
        props: { ...props, ownerDocument: container.ownerDocument },
        editor: props.editor,
      });

      // Set the initial position, this position might be obstructed so we update the position again after we render the elements.
      updatePosition(props);

      requestAnimationFrame(() => {
        updatePosition(props);
      });
    };

    // A reopen of the exact token the user dismissed, at the position it was
    // dismissed at, is never something the user asked for: editing the token
    // changes its text, and a new trigger elsewhere has another position. It
    // is the remote echo described on `SuggestionDismissal`.
    const isDismissed = (props: SuggestionProps<ItemType, ItemType>) =>
      dismissal.current !== undefined &&
      dismissal.current.from === props.range.from &&
      dismissal.current.text === props.text;

    return {
      onStart(props) {
        if (isDismissed(props)) {
          return;
        }

        mount(props);
      },

      onUpdate(props) {
        if (!component) {
          // Nothing is mounted while a dismissal stands, and the plugin keeps
          // reporting updates for the token it reactivated. Mount as soon as
          // one of them carries a token the user has actually changed.
          if (!isDismissed(props)) {
            mount(props);
          }

          return;
        }

        component.updateProps(props);
        updatePosition(props);
      },

      onKeyDown(props) {
        if (props.event.key === 'Escape') {
          // Recorded from the document rather than from a remembered prop:
          // this is the only hook that sees the key, and it runs before
          // @tiptap/suggestion dispatches its own exit.
          dismissal.current = {
            from: props.range.from,
            text: props.view.state.doc.textBetween(
              props.range.from,
              props.range.to,
            ),
          };
          destroyComponent();

          return true;
        }

        if (!component?.ref) {
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

/**
 * `render` and `shouldResetDismissed` sharing one dismissal, so a menu the user
 * closed with Escape stays closed until they edit the token themselves. See
 * `SuggestionDismissal`.
 */
export const dismissableRenderer = <ItemType>(
  container: HTMLElement,
): Pick<SuggestionOptions<ItemType>, 'render' | 'shouldResetDismissed'> => {
  const dismissal = createSuggestionDismissal();

  return {
    render: createRenderFunction<ItemType>(container, dismissal),
    shouldResetDismissed: resetDismissedOnEdit(dismissal),
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

  ...dismissableRenderer<SuggestionItem>(container),
});
