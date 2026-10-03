import {
  FaBold,
  FaCode,
  FaItalic,
  FaQuoteLeft,
  FaStrikethrough,
} from 'react-icons/fa6';
import { useEditorState } from '@tiptap/react';
import { useTipTapEditor } from './TiptapContext';
import { ToggleButton } from './ToggleButton';

/**
 * Bold, italic, strikethrough, blockquote and inline code toggles. Shared by
 * the selection bubble menu and the formatting toolbar so both offer the same
 * set in the same order.
 */
export function MarkToggleButtons(): React.JSX.Element {
  const editor = useTipTapEditor();

  const {
    isBold,
    isItalic,
    isStrikethrough,
    isBlockquote,
    isCode,
    canBold,
    canItalic,
    canStrike,
    canBlockquote,
    canCode,
  } = useEditorState({
    editor,
    selector: snapshot => ({
      isBold: snapshot.editor.isActive('bold'),
      isItalic: snapshot.editor.isActive('italic'),
      isStrikethrough: snapshot.editor.isActive('strike'),
      isBlockquote: snapshot.editor.isActive('blockquote'),
      isCode: snapshot.editor.isActive('code'),
      canBold: snapshot.editor.can().toggleBold(),
      canItalic: snapshot.editor.can().toggleItalic(),
      canStrike: snapshot.editor.can().toggleStrike(),
      canBlockquote: snapshot.editor.can().toggleBlockquote(),
      canCode: snapshot.editor.can().toggleCode(),
    }),
  });

  return (
    <>
      <ToggleButton
        title='Toggle bold'
        $active={isBold}
        onClick={() => editor.chain().focus().toggleBold().run()}
        disabled={!canBold}
        type='button'
      >
        <FaBold />
      </ToggleButton>
      <ToggleButton
        title='Toggle italic'
        $active={isItalic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        disabled={!canItalic}
        type='button'
      >
        <FaItalic />
      </ToggleButton>
      <ToggleButton
        title='Toggle strikethrough'
        $active={isStrikethrough}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        disabled={!canStrike}
        type='button'
      >
        <FaStrikethrough />
      </ToggleButton>
      <ToggleButton
        title='Toggle blockquote'
        $active={isBlockquote}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        disabled={!canBlockquote}
        type='button'
      >
        <FaQuoteLeft />
      </ToggleButton>
      <ToggleButton
        title='Toggle inline code'
        $active={isCode}
        onClick={() => editor.chain().focus().toggleCode().run()}
        disabled={!canCode}
        type='button'
      >
        <FaCode />
      </ToggleButton>
    </>
  );
}
