import { BubbleMenu as TipTapBubbleMenu } from '@tiptap/react/menus';
import {
  FaBold,
  FaCode,
  FaItalic,
  FaLink,
  FaQuoteLeft,
  FaStrikethrough,
} from 'react-icons/fa6';
import { styled } from 'styled-components';
import * as RadixPopover from '@radix-ui/react-popover';
import { Column, Row } from '../../components/Row';

import { Popover } from '../../components/Popover';
import { useRef, useState } from 'react';
import { transparentize } from 'polished';
import { EditLinkForm } from './EditLinkForm';
import { useTipTapEditor } from './TiptapContext';
import { ToggleButton } from './ToggleButton';
import { NodeSelectMenu } from './NodeSelectMenu';
import { useEditorState } from '@tiptap/react';

interface BubbleMenuProps {
  children?: React.ReactNode;
  extraItems?: React.ReactNode;
  onShow?: () => void;
}

export function BubbleMenu({
  children,
  extraItems,
  onShow,
}: BubbleMenuProps): React.JSX.Element {
  const bubbleMenuElement = useRef<HTMLDivElement>(null);
  const editor = useTipTapEditor();
  const [linkMenuOpen, setLinkMenuOpen] = useState(false);

  const { isBold, isItalic, isStrikethrough, isBlockquote, isCode, isLink } =
    useEditorState({
      editor,
      selector: snapshot => ({
        isBold: snapshot.editor.isActive('bold'),
        isItalic: snapshot.editor.isActive('italic'),
        isStrikethrough: snapshot.editor.isActive('strike'),
        isBlockquote: snapshot.editor.isActive('blockquote'),
        isCode: snapshot.editor.isActive('code'),
        isLink: snapshot.editor.isActive('link'),
      }),
    });

  if (!editor.view) {
    return <></>;
  }

  return (
    <TipTapBubbleMenu
      editor={editor}
      ref={bubbleMenuElement}
      options={{ onShow }}
    >
      <BubbleMenuInner>
        <Row gap='0.5ch'>
          <NodeSelectMenu />
          <ToggleButton
            title='Toggle bold'
            $active={isBold}
            onClick={() => editor.chain().focus().toggleBold().run()}
            disabled={!editor.can().chain().focus().toggleBold().run()}
            type='button'
          >
            <FaBold />
          </ToggleButton>
          <ToggleButton
            title='Toggle italic'
            $active={isItalic}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            disabled={!editor.can().chain().focus().toggleItalic().run()}
            type='button'
          >
            <FaItalic />
          </ToggleButton>
          <ToggleButton
            title='Toggle strikethrough'
            $active={isStrikethrough}
            onClick={() => editor.chain().focus().toggleStrike().run()}
            disabled={!editor.can().chain().focus().toggleStrike().run()}
            type='button'
          >
            <FaStrikethrough />
          </ToggleButton>
          <ToggleButton
            title='Toggle blockquote'
            $active={isBlockquote}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            disabled={!editor.can().chain().focus().toggleBlockquote().run()}
            type='button'
          >
            <FaQuoteLeft />
          </ToggleButton>
          <ToggleButton
            title='Toggle inline code'
            $active={isCode}
            onClick={() => editor.chain().focus().toggleCode().run()}
            disabled={!editor.can().chain().focus().toggleCode().run()}
            type='button'
          >
            <FaCode />
          </ToggleButton>
          <StyledPopover
            modal
            open={linkMenuOpen}
            onOpenChange={setLinkMenuOpen}
            side='top'
            Trigger={
              <ToggleButton
                as={RadixPopover.Trigger}
                $active={isLink}
                disabled={!editor.can().chain().focus().toggleLink().run()}
                type='button'
              >
                <FaLink />
              </ToggleButton>
            }
          >
            <EditLinkForm onDone={() => setLinkMenuOpen(false)} />
          </StyledPopover>
          {children}
        </Row>
        {extraItems}
      </BubbleMenuInner>
    </TipTapBubbleMenu>
  );
}

const BubbleMenuInner = styled(Column)`
  background-color: ${p => p.theme.colors.bg};
  border-radius: ${p => p.theme.radius};
  padding: ${p => p.theme.size(2)};
  box-shadow: ${p => p.theme.boxShadowSoft};
  border: ${p =>
    p.theme.darkMode ? `1px solid ${p.theme.colors.bg2}` : 'none'};
  @supports (backdrop-filter: blur(5px)) {
    background-color: ${p => transparentize(0.15, p.theme.colors.bg)};
    backdrop-filter: blur(5px);
  }
`;

const StyledPopover = styled(Popover)`
  background-color: ${p => p.theme.colors.bg};
  backdrop-filter: blur(5px);
  padding: ${p => p.theme.size()};
  border-radius: ${p => p.theme.radius};
  border: ${p =>
    p.theme.darkMode ? `1px solid ${p.theme.colors.bg2}` : 'none'};

  @supports (backdrop-filter: blur(5px)) {
    background-color: ${p => transparentize(0.15, p.theme.colors.bg)};
    backdrop-filter: blur(5px);
  }
`;
