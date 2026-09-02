import { FaEllipsisVertical } from 'react-icons/fa6';
import { DropdownTriggerComponent } from '../Dropdown/DropdownTrigger';
import { shortcuts } from '../HotKeyWrapper';
import { IconButton } from '../IconButton/IconButton';

export const MenuBarDropdownTrigger: DropdownTriggerComponent = ({
  onClick,
  menuId,
  ref,
}) => (
  <IconButton
    aria-controls={menuId}
    ref={ref}
    title={`Open menu (${shortcuts.menu})`}
    type='button'
    data-test='context-menu'
    onClick={onClick}
  >
    <FaEllipsisVertical />
  </IconButton>
);

MenuBarDropdownTrigger.displayName = 'MenuBarDropdownTrigger';
