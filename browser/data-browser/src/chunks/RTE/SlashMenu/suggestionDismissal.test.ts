// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Node } from '@tiptap/core';
import { Editor } from '@tiptap/react';
import { SlashCommands, buildSuggestion } from './CommandsExtension';

/**
 * Escape has to keep the slash menu closed in a document other people are
 * editing. @tiptap/suggestion remembers a dismissal by position, and a remote
 * update replaces the whole document, which moves that position: the plugin
 * then treats the same `/quo` as a new suggestion and reopens the menu. See
 * `SuggestionDismissal` in `CommandsExtension`.
 */

const Doc = Node.create({ name: 'doc', topNode: true, content: 'block+' });
const Paragraph = Node.create({
  name: 'paragraph',
  group: 'block',
  content: 'inline*',
  parseHTML: () => [{ tag: 'p' }],
  renderHTML: () => ['p', 0],
});
const TextNode = Node.create({ name: 'text', group: 'inline' });

/** The suggestion plugin's view hooks run after an internal await. */
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

function editorWithSlashMenu() {
  const element = document.createElement('div');
  const container = document.createElement('div');
  document.body.append(element, container);

  const editor = new Editor({
    element,
    extensions: [
      Doc,
      Paragraph,
      TextNode,
      SlashCommands.configure({ suggestion: buildSuggestion(container) }),
    ],
    content: '<p></p>',
  });

  editor.commands.focus();

  return {
    editor,
    // The renderer adopts its element into the container when it mounts, and
    // takes it away when it is destroyed. jsdom never paints the list itself.
    isMenuOpen: () => container.children.length > 0,
    escape: () =>
      editor.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    /** What loro-prosemirror does with a remote update: rebuild everything. */
    receiveRemoteUpdate: () => {
      const { state } = editor.view;
      const text = state.doc.textContent;
      editor.view.dispatch(
        state.tr.replaceWith(
          0,
          state.doc.content.size,
          state.schema.node(
            'paragraph',
            null,
            text ? [state.schema.text(text)] : [],
          ),
        ),
      );
    },
  };
}

describe('slash menu dismissal', () => {
  it('stays closed when a remote update rebuilds the document', async () => {
    const { editor, isMenuOpen, escape, receiveRemoteUpdate } =
      editorWithSlashMenu();

    editor.commands.insertContent('/quo');
    await settle();
    expect(isMenuOpen()).toBe(true);

    escape();
    await settle();
    expect(isMenuOpen()).toBe(false);

    receiveRemoteUpdate();
    await settle();
    expect(isMenuOpen()).toBe(false);

    editor.destroy();
  });

  it('opens again once the query itself changes', async () => {
    const { editor, isMenuOpen, escape } = editorWithSlashMenu();

    editor.commands.insertContent('/quo');
    await settle();
    escape();
    await settle();
    expect(isMenuOpen()).toBe(false);

    editor.commands.insertContent('t');
    await settle();
    expect(isMenuOpen()).toBe(true);

    editor.destroy();
  });
});
