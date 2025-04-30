import { EditorContent, useEditor } from '@tiptap/react';
import { FloatingMenu } from '@tiptap/react/menus';
import { StarterKit } from '@tiptap/starter-kit';
import { Link } from '@tiptap/extension-link';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Typography } from '@tiptap/extension-typography';
import { Markdown } from '@tiptap/markdown';
import { EditorEvents } from './EditorEvents';
import { FaCode } from 'react-icons/fa6';
import { useCallback, useState } from 'react';
import { BubbleMenu } from './BubbleMenu';
import { TiptapContextProvider } from './TiptapContext';
import { SlashCommands, buildSuggestion } from './SlashMenu/CommandsExtension';
import { TableKit } from '@tiptap/extension-table';
import { ExtendedImage } from './ImagePicker';
import { usePopoverContainer } from '../../components/Popover';
import {
  StyledEditorWrapper,
  RawEditor,
  FloatingMenuText,
  FloatingCodeButton,
} from './sharedEditorStyles';
import { TaskItem, TaskList } from '@tiptap/extension-list';

export type AsyncMarkdownEditorProps = {
  placeholder?: string;
  initialContent?: string;
  autoFocus?: boolean;
  onChange?: (content: string) => void;
  id?: string;
  labelId?: string;
  onBlur?: () => void;
};

export default function AsyncMarkdownEditor({
  placeholder,
  initialContent,
  autoFocus,
  id,
  labelId,
  onChange,
  onBlur,
}: AsyncMarkdownEditorProps): React.JSX.Element {
  const containerRef = usePopoverContainer();

  /* eslint-disable-next-line react-hooks/refs */
  const container = containerRef.current ?? document.body;

  /* eslint-disable-next-line react-hooks/refs */
  const [extensions] = useState(() => [
    StarterKit.configure({
      link: false,
    }),
    Markdown.configure({
      markedOptions: {
        gfm: true,
      },
    }),
    Typography,
    TableKit,
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
    TaskList,
    TaskItem.configure({
      nested: true,
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
  ]);

  const [markdown, setMarkdown] = useState(initialContent ?? '');
  const [codeMode, setCodeMode] = useState(false);

  const editor = useEditor({
    extensions,
    content: markdown,
    contentType: 'markdown',
    onBlur,
    autofocus: !!autoFocus,
    editorProps: {
      attributes: {
        ...(id && { id }),
        ...(labelId && { 'aria-labelledby': labelId }),
        'data-testid': 'markdown-editor',
      },
    },
  });

  const handleChange = useCallback(() => {
    const value = editor.getMarkdown();

    setMarkdown(value);
    onChange?.(value);
  }, [onChange, editor]);

  const handleRawChange = useCallback(
    (val: string) => {
      setMarkdown(val);
      onChange?.(val);
    },
    [onChange],
  );

  const handleCodeModeChange = (enable: boolean) => {
    setCodeMode(enable);

    if (!enable) {
      editor?.commands.setContent(markdown, { contentType: 'markdown' });
    }
  };

  return (
    <TiptapContextProvider editor={editor}>
      <StyledEditorWrapper hideEditor={codeMode}>
        {codeMode && (
          <RawEditor
            placeholder={placeholder ?? 'Start typing...'}
            onChange={e => handleRawChange(e.target.value)}
            value={markdown}
          />
        )}
        <EditorContent key='rich-editor' editor={editor}>
          <FloatingMenu editor={editor ?? null}>
            <FloatingMenuText>Type &apos;/&apos; for options</FloatingMenuText>
          </FloatingMenu>
          <BubbleMenu />
          <EditorEvents onChange={handleChange} />
        </EditorContent>
        <FloatingCodeButton
          type='button'
          $active={codeMode}
          title='Edit raw markdown'
          onClick={() => handleCodeModeChange(!codeMode)}
        >
          <FaCode />
        </FloatingCodeButton>
      </StyledEditorWrapper>
    </TiptapContextProvider>
  );
}
