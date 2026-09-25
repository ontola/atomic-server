import type { JSX } from 'react';
import { FaMagnifyingGlass } from 'react-icons/fa6';
import {
  DropdownMenu,
  type DropdownItem,
  type MenuItemMinimial,
} from '@components/Dropdown';
import type { DropdownTriggerComponent } from '@components/Dropdown/DropdownTrigger';
import { openSearchOverlay } from '@components/overlayState';

interface ColumnFilterDropdownProps {
  items: DropdownItem[];
  Trigger: DropdownTriggerComponent;
}

/**
 * The menu that picks a column to filter the table by. Its input finds a
 * column, not rows or pages, and says so: in user testing "Filter actions"
 * read as a search box, and someone typed another table's name into it. When
 * the text matches no column, it offers to search the drive for it instead.
 */
export function ColumnFilterDropdown({
  items,
  Trigger,
}: ColumnFilterDropdownProps): JSX.Element {
  return (
    <DropdownMenu
      Trigger={Trigger}
      items={items}
      searchPlaceholder='Find a column…'
      searchLabel='Find a column to filter by'
      noMatchText='No column matches'
      noMatchItem={(query): MenuItemMinimial => ({
        id: 'search-drive',
        label: `Search the drive for “${query}”`,
        icon: <FaMagnifyingGlass />,
        onClick: () => openSearchOverlay(query),
      })}
    />
  );
}
