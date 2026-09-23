import { Extension, type Editor, type Range } from '@tiptap/react';
import { Suggestion, type SuggestionOptions } from '@tiptap/suggestion';
import type { Store } from '@tomic/react';
import type { SuggestionItem } from '../types';
import { getIconForClass } from '@helpers/iconMap';
import { PluginKey } from '@tiptap/pm/state';
import { createRenderFunction } from '../SlashMenu/CommandsExtension';
import { getRecentResources } from '@helpers/recentResources';

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

const MAX_SUGGESTIONS = 10;

/** With nothing typed yet, offer what the user opened recently in this drive,
 * topped up with the drive's own children so a fresh drive isn't empty. */
const getSubjectsWithoutQuery = async (
  store: Store,
  drive: string,
  exclude: string | undefined,
): Promise<string[]> => {
  const subjects = getRecentResources(drive).filter(s => s !== exclude);

  if (subjects.length < MAX_SUGGESTIONS) {
    try {
      const driveResource = await store.getResource(drive);
      const children =
        await driveResource.getChildrenCollection(MAX_SUGGESTIONS);

      for (const child of await children.getMembersOnPage(0)) {
        if (child !== exclude && !subjects.includes(child)) {
          subjects.push(child);
        }
      }
    } catch (e) {
      console.error('Could not list drive children for @ mentions', e);
    }
  }

  const resources = await Promise.all(
    subjects.map(subject => store.getResource(subject)),
  );

  // Recents can point at resources that were deleted or are no longer
  // readable since they were opened.
  return resources
    .filter(r => !r.error && r.title)
    .slice(0, MAX_SUGGESTIONS)
    .map(r => r.subject);
};

export const buildResourceSuggestion = (
  container: HTMLElement,
  store: Store,
  drive: string,
  /** The resource being edited, left out of the suggestions. */
  currentSubject?: string,
): Partial<SuggestionOptions> => ({
  items: async ({ query }: { query: string }): Promise<SuggestionItem[]> => {
    const results = query.trim()
      ? await store.search(query.toLowerCase(), {
          limit: MAX_SUGGESTIONS,
          // Including the results could lead to weird behavior when the document itself is returned from the server.
          include: false,
          parents: [drive],
        })
      : await getSubjectsWithoutQuery(store, drive, currentSubject);

    const resources = await Promise.all(results.map(x => store.getResource(x)));

    return resources.map(r => ({
      title: r.title,
      id: r.subject,
      icon: getIconForClass(r.getClasses()[0]),
      command: ({ editor, range }) => {
        const subject = r.subject;
        const isBlockContext = getIsBlockContext(editor, range);
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

const getIsBlockContext = (editor: Editor, range: Range) => {
  const { from } = range;

  // Resolve the position and the parent node
  const $pos = editor.state.doc.resolve(from);

  // Text offset tells us the distance to a previous node. This is 0 if there is no previous node meaning we are in a block context.
  return $pos.textOffset === 0;
};
