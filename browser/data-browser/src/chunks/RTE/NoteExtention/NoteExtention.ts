import { mergeAttributes, Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { NoteComponent } from './NoteComponent';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    note: {
      toggleNote: () => ReturnType;
    };
  }
}

export const Note = Node.create({
  name: 'note-block',
  group: 'block',
  content: 'block*',
  defining: true,
  renderHTML({ HTMLAttributes }) {
    return ['note-block', mergeAttributes(HTMLAttributes), 0];
  },

  parseHTML() {
    return [
      {
        tag: 'note-block',
      },
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(NoteComponent);
  },

  addCommands() {
    return {
      toggleNote:
        () =>
        ({ commands }) => {
          return commands.wrapIn(this.type.name);
        },
    };
  },
});
