import { styled } from 'styled-components';
import { FaEllipsisVertical } from 'react-icons/fa6';
import type { DropdownTriggerComponent } from '../Dropdown/DropdownTrigger';
import { shortcuts } from '../HotKeyWrapper';

const MenuButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  padding: 0.25rem 0.5rem;
  border: none;
  border-radius: ${p => p.theme.radius};
  background: transparent;
  color: ${p => p.theme.colors.textLight};
  cursor: pointer;
  font-size: 0.875rem;

  &:hover {
    background: ${p => p.theme.colors.bg1};
    color: ${p => p.theme.colors.text};
  }
`;

export const ParentContextMenuTrigger: DropdownTriggerComponent = ({
  onClick,
  menuId,
  ref,
}) => (
  <MenuButton
    aria-controls={menuId}
    ref={ref}
    title={`Open menu (${shortcuts.menu})`}
    type='button'
    data-test='context-menu'
    onClick={onClick}
  >
    <FaEllipsisVertical />
    <span>More</span>
  </MenuButton>
);

ParentContextMenuTrigger.displayName = 'ParentContextMenuTrigger';
