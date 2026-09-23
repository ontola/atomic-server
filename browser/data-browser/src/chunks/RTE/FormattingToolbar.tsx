import { useState } from 'react';
import { styled } from 'styled-components';
import { transparentize } from 'polished';
import { useEditorState, type Editor } from '@tiptap/react';
import {
  FaAt,
  FaCheck,
  FaImage,
  FaListOl,
  FaListUl,
  FaXmark,
} from 'react-icons/fa6';
import { MdTextFormat } from 'react-icons/md';
import { IconButton } from '@components/IconButton/IconButton';
import { useLocalStorage } from '@hooks/useLocalStorage';
import { useTipTapEditor } from './TiptapContext';
import { NodeSelectMenu } from './NodeSelectMenu';
import { MarkToggleButtons } from './MarkToggleButtons';
import { LinkPopoverButton } from './LinkPopoverButton';
import { ToggleButton } from './ToggleButton';

const SHOW_TOOLBAR_KEY = 'atomic.rte.showToolbar';

/**
 * Formatting toolbar above the document editor, for people who don't know
 * the `/` and `@` commands yet. It can be hidden; that choice is remembered
 * per browser and applies to every document and meeting.
 */
export function FormattingToolbar(): React.JSX.Element {
  const [showToolbar, setShowToolbar] = useLocalStorage(SHOW_TOOLBAR_KEY, true);

  if (!showToolbar) {
    return (
      <CollapsedRow>
        <IconButton
          title='Show formatting toolbar'
          size='1.2rem'
          color='textLight'
          onClick={() => setShowToolbar(true)}
        >
          <MdTextFormat />
        </IconButton>
      </CollapsedRow>
    );
  }

  return <Toolbar onHide={() => setShowToolbar(false)} />;
}

interface ToolbarProps {
  onHide: () => void;
}

function Toolbar({ onHide }: ToolbarProps): React.JSX.Element {
  const editor = useTipTapEditor();
  const [linkMenuOpen, setLinkMenuOpen] = useState(false);

  const { isBulletList, isOrderedList, isTaskList } = useEditorState({
    editor,
    selector: snapshot => ({
      isBulletList: snapshot.editor.isActive('bulletList'),
      isOrderedList: snapshot.editor.isActive('orderedList'),
      isTaskList: snapshot.editor.isActive('taskList'),
    }),
  });

  // Pressing a button would otherwise move focus out of the editor, which
  // closes the on-screen keyboard on touch devices. The `<select>` still
  // needs its default so it can open.
  const keepEditorFocus = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) {
      e.preventDefault();
    }
  };

  return (
    <ToolbarWrapper
      role='toolbar'
      aria-label='Formatting'
      onMouseDown={keepEditorFocus}
    >
      <Group>
        <NodeSelectMenu />
      </Group>
      <Group>
        <MarkToggleButtons />
        <LinkPopoverButton
          open={linkMenuOpen}
          onOpenChange={setLinkMenuOpen}
          side='bottom'
        />
      </Group>
      <Group>
        <ToggleButton
          title='Bullet list'
          $active={isBulletList}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          type='button'
        >
          <FaListUl />
        </ToggleButton>
        <ToggleButton
          title='Numbered list'
          $active={isOrderedList}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          type='button'
        >
          <FaListOl />
        </ToggleButton>
        <ToggleButton
          title='Task list'
          $active={isTaskList}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
          type='button'
        >
          <FaCheck />
        </ToggleButton>
      </Group>
      <Group>
        <ToggleButton
          title='Insert image'
          $active={false}
          onClick={() => editor.chain().focus().setImage({ src: '' }).run()}
          type='button'
        >
          <FaImage />
        </ToggleButton>
        <ToggleButton
          title='Mention a resource (@)'
          $active={false}
          onClick={() => insertMentionTrigger(editor)}
          type='button'
        >
          <FaAt />
        </ToggleButton>
      </Group>
      <HideButton
        title='Hide toolbar (type / or @ instead)'
        $active={false}
        onClick={onHide}
        type='button'
      >
        <FaXmark />
      </HideButton>
    </ToolbarWrapper>
  );
}

// The `@` menu only opens at the start of a line or after a space, so pad
// the trigger when the caret sits right after a word.
function insertMentionTrigger(editor: Editor) {
  const { $from } = editor.state.selection;
  const charBefore = $from.parent.textBetween(
    Math.max(0, $from.parentOffset - 1),
    $from.parentOffset,
  );
  const needsSpace = charBefore !== '' && !/\s/.test(charBefore);

  editor
    .chain()
    .focus()
    .insertContent(needsSpace ? ' @' : '@')
    .run();
}

const ToolbarWrapper = styled.div`
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: ${p => p.theme.size(2)};
  margin-bottom: ${p => p.theme.size(3)};
  padding-block: ${p => p.theme.size(1)};
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
  background-color: ${p => p.theme.colors.bg};
  cursor: default;
  /* Narrow screens scroll the buttons sideways instead of wrapping onto
   * several rows that would push the text down. */
  overflow-x: auto;
  scrollbar-width: none;

  @supports (backdrop-filter: blur(5px)) {
    background-color: ${p => transparentize(0.1, p.theme.colors.bg)};
    backdrop-filter: blur(5px);
  }

  @media print {
    display: none;
  }
`;

const Group = styled.div`
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 0.25ch;

  & + & {
    padding-left: ${p => p.theme.size(2)};
    border-left: 1px solid ${p => p.theme.colors.bg2};
  }
`;

const HideButton = styled(ToggleButton)`
  flex-shrink: 0;
  margin-left: auto;
`;

const CollapsedRow = styled.div`
  display: flex;
  justify-content: flex-end;
  cursor: default;

  @media print {
    display: none;
  }
`;
