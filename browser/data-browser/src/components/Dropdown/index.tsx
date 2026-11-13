import {
  DropdownMenu as SharedDropdownMenu,
  type DropdownMenuProps,
} from '@tomic/ui/components/Dropdown/index';
import { useBackToClose } from '../../hooks/useBackToClose';

export * from '@tomic/ui/components/Dropdown/index';

function BackToClose({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useBackToClose(open, onClose);

  return null;
}

/** Atomic routing and translated fallback labels around the shared menu. */
export function DropdownMenu(props: DropdownMenuProps) {
  return (
    <SharedDropdownMenu
      {...props}
      searchPlaceholder={props.searchPlaceholder ?? 'Filter actions…'}
      searchLabel={props.searchLabel ?? 'Filter actions'}
      noMatchText={props.noMatchText ?? 'No matching actions'}
      BackToClose={BackToClose}
    />
  );
}
