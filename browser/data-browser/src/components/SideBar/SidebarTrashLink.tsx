import { FaTrash } from 'react-icons/fa6';
import type { JSX } from 'react';
import { useCurrentSubject } from '../../helpers/useCurrentSubject';
import {
  SideBarMenuItemLink,
  SideBarMenuRow,
  SideBarMenuRowIcon,
  SideBarMenuRowLabel,
} from './SideBarMenuItem';

interface SidebarTrashLinkProps {
  /** The drive's Trash folder. */
  subject: string;
  onClick?: () => void;
}

/** Row below the tree that opens the Trash folder. */
export function SidebarTrashLink({
  subject,
  onClick,
}: SidebarTrashLinkProps): JSX.Element {
  const [currentSubject] = useCurrentSubject();

  return (
    <SideBarMenuItemLink subject={subject} clean data-testid='sidebar-trash'>
      <SideBarMenuRow onClick={onClick} current={currentSubject === subject}>
        <SideBarMenuRowIcon>
          <FaTrash />
        </SideBarMenuRowIcon>
        <SideBarMenuRowLabel>Trash</SideBarMenuRowLabel>
      </SideBarMenuRow>
    </SideBarMenuItemLink>
  );
}
