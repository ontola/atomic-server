import { BubbleMenu as TipTapBubbleMenu } from '@tiptap/react/menus';
import { styled } from 'styled-components';
import { Column, Row } from '../../components/Row';

import { PopoverContainer } from '../../components/Popover';
import { useCallback, useState } from 'react';
import { transparentize } from 'polished';
import { useTipTapEditor } from './TiptapContext';
import { NodeSelectMenu } from './NodeSelectMenu';
import { useEditorState } from '@tiptap/react';
import { MarkToggleButtons } from './MarkToggleButtons';
import { LinkPopoverButton } from './LinkPopoverButton';

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
  const editor = useTipTapEditor();
  const [linkMenuOpen, setLinkMenuOpen] = useState(false);
  // Focusing the link form blurs the editor, which would hide the menu the
  // popover is anchored to and send it flying to the corner. Keep the menu
  // shown while the form is open; the popover also portals into the menu so
  // the plugin's blur guard sees focus staying inside it.
  const keepShown = useCallback(() => true, []);

  const { isInitialized } = useEditorState({
    editor,
    selector: snapshot => ({
      isInitialized: snapshot.editor.isInitialized,
    }),
  });

  if (!isInitialized) {
    return <></>;
  }

  return (
    <TipTapBubbleMenu
      editor={editor}
      shouldShow={linkMenuOpen ? keepShown : null}
      options={{ onShow }}
    >
      <BubbleMenuInner>
        <PopoverContainer>
          <Row gap='0.5ch'>
            <NodeSelectMenu />
            <MarkToggleButtons />
            <LinkPopoverButton
              open={linkMenuOpen}
              onOpenChange={setLinkMenuOpen}
            />
            {children}
          </Row>
          {extraItems}
        </PopoverContainer>
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
