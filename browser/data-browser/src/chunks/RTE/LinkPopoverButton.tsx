import * as RadixPopover from '@radix-ui/react-popover';
import { FaLink } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { transparentize } from 'polished';
import { useEditorState } from '@tiptap/react';
import { Popover } from '../../components/Popover';
import { EditLinkForm } from './EditLinkForm';
import { useTipTapEditor } from './TiptapContext';
import { ToggleButton } from './ToggleButton';

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
