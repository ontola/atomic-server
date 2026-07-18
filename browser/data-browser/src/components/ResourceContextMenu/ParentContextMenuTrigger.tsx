import { forwardRef } from 'react';
import { FaEllipsisVertical } from 'react-icons/fa6';
import type { DropdownTriggerComponent } from '../Dropdown/DropdownTrigger';
import { shortcuts } from '../HotKeyWrapper';
import { LabelButton } from '../NavBarButton';

export const ParentContextMenuTrigger: DropdownTriggerComponent = forwardRef(
  ({ onClick, menuId }, ref) => (
    <LabelButton
      aria-controls={menuId}
      ref={ref}
      title={`Open menu (${shortcuts.menu})`}
      type='button'
      data-test='context-menu'
      onClick={onClick}
    >
      <FaEllipsisVertical />
      <span>More</span>
    </LabelButton>
  ),
);

ParentContextMenuTrigger.displayName = 'ParentContextMenuTrigger';
