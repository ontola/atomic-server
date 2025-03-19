import { EditorContent, FloatingMenu, useEditor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Link } from '@tiptap/extension-link';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Typography } from '@tiptap/extension-typography';
import { styled } from 'styled-components';
import { Markdown } from 'tiptap-markdown';
import { EditorEvents } from './EditorEvents';
import { FaCode } from 'react-icons/fa6';
import { useCallback, useState } from 'react';
import { BubbleMenu } from './BubbleMenu';
import { TiptapContextProvider } from './TiptapContext';
import { ToggleButton } from './ToggleButton';
import { SlashCommands, buildSuggestion } from './SlashMenu/CommandsExtension';
import { ExtendedImage } from './ImagePicker';
import { transition } from '../../helpers/transition';
import { usePopoverContainer } from '../../components/Popover';
import { EditorWrapperBase } from './EditorWrapperBase';

export type AsyncMarkdownEditorProps = {
  placeholder?: string;
  initialContent?: string;
  autoFocus?: boolean;
  onChange?: (content: string) => void;
  id?: string;
  labelId?: string;
  onBlur?: () => void;
};

const MIN_EDITOR_HEIGHT = '10rem';
// The lineheight of a textarea.
const LINE_HEIGHT = 1.15;

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

  const container = containerRef.current ?? document.body;

  const [extensions] = useState(() => [
    StarterKit,
    Markdown,
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
  ]);

  const [markdown, setMarkdown] = useState(initialContent ?? '');
  const [codeMode, setCodeMode] = useState(false);

  const editor = useEditor({
    extensions,
    content: markdown,
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

  const handleChange = useCallback(
    (value: string) => {
      setMarkdown(value);
      onChange?.(value);
    },
    [onChange],
  );

  const handleCodeModeChange = (enable: boolean) => {
    setCodeMode(enable);

    if (!enable) {
      editor?.commands.setContent(markdown);
    }
  };

  return (
    <TiptapContextProvider editor={editor}>
      <StyledEditorWrapper hideEditor={codeMode}>
        {codeMode && (
          <RawEditor
            placeholder={placeholder ?? 'Start typing...'}
            onChange={e => handleChange(e.target.value)}
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

// Textareas do not automatically grow when the content exceeds the height of the textarea.
// This function calculates the height of the textarea based on the number of lines in the content.
const calcHeight = (value: string) => {
  const lines = value.split('\n').length;

  return `calc(${lines * LINE_HEIGHT}em + 5px)`;
};

const StyledEditorWrapper = styled(EditorWrapperBase)`
  min-height: ${MIN_EDITOR_HEIGHT};
  border-radius: ${p => p.theme.radius};
  box-shadow: 0 0 0 1px ${p => p.theme.colors.bg2};
  min-height: ${MIN_EDITOR_HEIGHT};
  padding: ${p => p.theme.size()};
  ${transition('box-shadow')}

  &:focus-within {
    box-shadow: 0 0 0 2px ${p => p.theme.colors.main};
  }

  & .tiptap {
    width: min(100%, 75ch);
    min-height: ${MIN_EDITOR_HEIGHT};
  }
`;

const RawEditor = styled.textarea.attrs(p => ({
  style: { height: calcHeight((p.value as string) ?? '') },
}))`
  border: none;
  width: 100%;
  min-height: ${MIN_EDITOR_HEIGHT};
  outline: none;
  overflow: visible;
  height: fit-content;
  background-color: transparent;
  color: ${p => p.theme.colors.text};
  resize: none;
`;

const FloatingMenuText = styled.span`
  color: ${p => p.theme.colors.textLight};
`;

const FloatingCodeButton = styled(ToggleButton)`
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
`;
