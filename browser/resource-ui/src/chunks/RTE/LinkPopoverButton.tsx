import { resourceTheme } from '../../theme.js';
import * as RadixPopover from '@radix-ui/react-popover';
import { FaLink } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { transparentize } from 'polished';
import { useEditorState } from '@tiptap/react';
import { Popover } from '@tomic/ui/components/Popover';
import { EditLinkForm } from './EditLinkForm.js';
import { useTipTapEditor } from './TiptapContext.js';
import { ToggleButton } from './ToggleButton.js';

interface LinkPopoverButtonProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: 'top' | 'bottom';
}

/** Link toggle that opens a small form to set or remove the link's URL. */
export function LinkPopoverButton({
  open,
  onOpenChange,
  side = 'top',
}: LinkPopoverButtonProps): React.JSX.Element {
  const editor = useTipTapEditor();
  const { isLink, canLink } = useEditorState({
    editor,
    selector: snapshot => ({
      isLink: snapshot.editor.isActive('link'),
      canLink: snapshot.editor.can().toggleLink(),
    }),
  });

  return (
    <StyledPopover
      modal
      open={open}
      onOpenChange={onOpenChange}
      side={side}
      Trigger={
        <ToggleButton
          as={RadixPopover.Trigger}
          title='Set link'
          $active={isLink}
          disabled={!canLink}
          type='button'
        >
          <FaLink />
        </ToggleButton>
      }
    >
      <EditLinkForm onDone={() => onOpenChange(false)} />
    </StyledPopover>
  );
}

const StyledPopover = styled(Popover)`
  background-color: ${p => resourceTheme(p.theme).colors.bg};
  backdrop-filter: blur(5px);
  padding: ${p => resourceTheme(p.theme).size()};
  border-radius: ${p => resourceTheme(p.theme).radius};
  border: ${p =>
    resourceTheme(p.theme).darkMode
      ? `1px solid ${resourceTheme(p.theme).colors.bg2}`
      : 'none'};

  @supports (backdrop-filter: blur(5px)) {
    background-color: ${p =>
      transparentize(0.15, resourceTheme(p.theme).colors.bg)};
    backdrop-filter: blur(5px);
  }
`;
