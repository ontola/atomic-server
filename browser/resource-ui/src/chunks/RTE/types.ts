import type { Editor, Range } from '@tiptap/react';
import type { IconType } from 'react-icons';

export type SuggestionItem = {
  id: string;
  title: string;
  icon: IconType;
  command: (props: { editor: Editor; range: Range }) => void;
};
