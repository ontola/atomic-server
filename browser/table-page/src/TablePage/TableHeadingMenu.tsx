import { Resource, useCanWrite, useResource } from '@tomic/react';
import { useContext, type JSX, type Ref } from 'react';
import { DropdownMenu } from '@tomic/resource-ui/components/Dropdown/index';
import { buildDefaultTrigger } from '@tomic/resource-ui/components/Dropdown/DefaultTrigger';
import { AutoOpenTrigger } from '@tomic/ui/components/Dropdown/AutoOpenTrigger';
import { FaEllipsisVertical } from 'react-icons/fa6';
import {
  TablePropertyMenu,
  type TablePropertyMenuHandle,
  type TablePropertyMenuPresentation,
} from '@tomic/table';
import { TablePageContext } from './tablePageContext.js';
import {
  useNavigateWithTransition,
  useResourceNavigation,
} from '@tomic/resource-ui/ResourceUIHost';

export type { TablePropertyMenuHandle as TableHeadingMenuHandle } from '@tomic/table';

interface TableHeadingMenuProps {
  resource: Resource;
  ref?: Ref<TablePropertyMenuHandle>;
}

const Trigger = buildDefaultTrigger(
  <FaEllipsisVertical />,
  () => 'Edit column',
);

export function TableHeadingMenu({
  resource,
  ref,
}: TableHeadingMenuProps): JSX.Element {
  const {
    tableClassSubject,
    addFilter,
    hideColumn,
    requestColumnRemoval,
    requestColumnEdit,
  } = useContext(TablePageContext);
  const tableClassResource = useResource(tableClassSubject);
  const canWriteClass = useCanWrite(tableClassResource);
  const canWriteProperty = useCanWrite(resource);
  const { constructOpenURL } = useResourceNavigation();
  const navigate = useNavigateWithTransition();

  return (
    <>
      <TablePropertyMenu
        ref={ref}
        Menu={AtomicPropertyMenu}
        actions={{
          view: {
            run: () => {
              navigate(constructOpenURL(resource.subject));
            },
          },
          filter: { run: () => addFilter(resource.subject) },
          hide: { run: () => hideColumn(resource.subject) },
          edit: {
            run: () => requestColumnEdit(resource.subject),
            disabled: !canWriteProperty,
          },
          remove: {
            run: () => requestColumnRemoval(resource.subject),
            disabled: !canWriteClass,
          },
        }}
        messages={{
          label: 'Edit column',
          view: 'View',
          filter: 'Filter',
          hide: 'Hide in this view',
          edit: 'Edit',
          editUnavailable: 'Edit unavailable',
          remove: 'Remove',
        }}
      />
    </>
  );
}

function AtomicPropertyMenu({
  items,
  point,
  onContextClose,
}: TablePropertyMenuPresentation): JSX.Element {
  const commands = items.map(item => ({
    id: item.key,
    label: item.label,
    icon: item.icon,
    disabled: item.disabled,
    helper: item.reason,
    onClick: item.run,
  }));

  return (
    <>
      <DropdownMenu Trigger={Trigger} items={commands} />
      {point && (
        <DropdownMenu
          Trigger={AutoOpenTrigger}
          items={commands}
          anchorPoint={point}
          bindActive={active => {
            if (!active) onContextClose();
          }}
        />
      )}
    </>
  );
}
