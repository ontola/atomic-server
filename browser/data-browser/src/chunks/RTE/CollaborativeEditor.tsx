import { EditorContent, useEditor } from '@tiptap/react';
import { FloatingMenu } from '@tiptap/react/menus';
import { StarterKit } from '@tiptap/starter-kit';
import { Link } from '@tiptap/extension-link';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Typography } from '@tiptap/extension-typography';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { useState } from 'react';
import { BubbleMenu } from './BubbleMenu';
import { TiptapContextProvider } from './TiptapContext';
import { SlashCommands, buildSuggestion } from './SlashMenu/CommandsExtension';
import { ExtendedImage } from './ImagePicker';
import { usePopoverContainer } from '../../components/Popover';
import { StyledEditorWrapper, FloatingMenuText } from './sharedEditorStyles';
import * as Y from 'yjs';
import { useDebouncedSave, type Resource } from '@tomic/react';
import { EditorEvents } from './EditorEvents';
import { useAwareness } from './useAwareness';
import { randomItem } from '@helpers/randomItem';

export type CollaborativeEditorProps = {
  placeholder?: string;
  doc: Y.Doc;
  autoFocus?: boolean;
  // onChange?: (content: string) => void;
  resource: Resource;

  id?: string;
  labelId?: string;
  onBlur?: () => void;
};

const COLORS = ['#70d6ff', '#ff70a6', '#ff9770', '#ffd670', '#e9ff70'];

export default function CollaborativeEditor({
  placeholder,
  autoFocus,
  doc,
  id,
  labelId,
  resource,
  onBlur,
}: CollaborativeEditorProps): React.JSX.Element {
  const [save] = useDebouncedSave(resource, 500);
  const containerRef = usePopoverContainer();

  const container = containerRef.current ?? document.body;

  const awareness = useAwareness(resource, doc);

  const [extensions] = useState(() => [
    StarterKit.configure({
      undoRedo: false,
    }),
    Typography,
    Link.configure({
      protocols: [
        'http',
        'https',
        'mailto',
        {
          scheme: 'tel',
          optionalSlashes: true,
        },
      ],
      HTMLAttributes: {
        class: 'tiptap-link',
        rel: 'noopener noreferrer',
        target: '_blank',
      },
    }),
    ExtendedImage.configure({
      HTMLAttributes: {
        class: 'tiptap-image',
      },
    }),
    Placeholder.configure({
      placeholder: placeholder ?? 'Start typing...',
    }),
    SlashCommands.configure({
      suggestion: buildSuggestion(container),
    }),
    Collaboration.configure({
      document: doc,
      field: 'content',
    }),
    CollaborationCaret.configure({
      provider: {
        awareness,
      },
      user: {
        name: 'Pieter Post',
        color: randomItem(COLORS),
      },
    }),
  ]);

  const editor = useEditor({
    extensions,
    // content: markdown,
    onBlur,
    autofocus: !!autoFocus,
    editorProps: {
      attributes: {
        ...(id && { id }),
        ...(labelId && { 'aria-labelledby': labelId }),
      },
    },
  });

  return (
    <TiptapContextProvider editor={editor}>
      <StyledEditorWrapper hideEditor={false}>
        <EditorContent key='rich-editor' editor={editor}>
          <FloatingMenu editor={editor ?? null}>
            <FloatingMenuText>Type &apos;/&apos; for options</FloatingMenuText>
          </FloatingMenu>
          <BubbleMenu />
          <EditorEvents onChange={save} />
        </EditorContent>
      </StyledEditorWrapper>
    </TiptapContextProvider>
  );
}
