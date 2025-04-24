import { Extension, type Editor, type Range } from '@tiptap/react';
import { Suggestion, type SuggestionOptions } from '@tiptap/suggestion';
import type { Store } from '@tomic/react';
import type { SuggestionItem } from '../types';
import { getIconForClass } from '@helpers/iconMap';
import { PluginKey } from '@tiptap/pm/state';
import { createRenderFunction } from '../SlashMenu/CommandsExtension';

const resourceSuggestionPluginKey = new PluginKey('resourceSuggestion');

export const ResourceCommands = Extension.create({
  name: 'resourceCommands',
  addOptions() {
    return {
      suggestion: {
        char: '@',
        // @ts-expect-error I'm not really sure how to type this.
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
        pluginKey: resourceSuggestionPluginKey,
        ...this.options.suggestion,
      }),
    ];
  },
});

export const buildResourceSuggestion = (
  container: HTMLElement,
  store: Store,
  drive: string,
): Partial<SuggestionOptions> => ({
  items: async ({ query }: { query: string }): Promise<SuggestionItem[]> => {
    const results = await store.search(query, {
      limit: 10,
      // Including the results could lead to weird behavior when the document itself is returned from the server.
      include: false,
      parents: [drive],
    });

    const resources = await Promise.all(results.map(x => store.getResource(x)));

    return resources.map(r => ({
      title: r.title,
      id: r.subject,
      icon: getIconForClass(r.getClasses()[0]),
      command: ({ editor, range }) => {
        const subject = r.subject;
        const textBeforeQuery = getTextBeforeQuery(editor, range);

        // If there is text before the query we are in not in a block context and the resource should be inserted inline.
        const isBlockContext = textBeforeQuery.length === 0;

        const command = editor.chain().focus().deleteRange(range);

        if (isBlockContext) {
          command.setResource({ subject }).run();
        } else {
          command.setResourceInline({ subject }).insertContent(' ').run();
        }
      },
    }));
  },

  render: createRenderFunction<SuggestionItem>(container),
});

const getTextBeforeQuery = (editor: Editor, range: Range) => {
  const { from } = range;

  const queryText = editor.state.doc.textBetween(range.from, range.to);

  // Resolve the position and the parent node
  const $pos = editor.state.doc.resolve(from);
  const parentNode = $pos.parent;

  // Calculate the offset within the parent node where the query starts
  const startOfQueryOffset = $pos.parentOffset - queryText.length;

  return parentNode.textContent.substring(0, startOfQueryOffset).trim();
};
