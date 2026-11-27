import { resourceTheme } from '@tomic/resource-ui/theme';
import { Resource, useCanWrite, useResource } from '@tomic/react';
import {
  useContext,
  useImperativeHandle,
  useMemo,
  useState,
  type JSX,
  type Ref,
} from 'react';
import {
  DropdownMenu,
  DropdownItem,
} from '@tomic/resource-ui/components/Dropdown/index';
import { buildDefaultTrigger } from '@tomic/resource-ui/components/Dropdown/DefaultTrigger';
import { AutoOpenTrigger } from '@tomic/ui/components/Dropdown/AutoOpenTrigger';
import {
  FaPencil,
  FaEllipsisVertical,
  FaEye,
  FaEyeSlash,
  FaXmark,
  FaFilter,
} from 'react-icons/fa6';
import { styled } from 'styled-components';
import { EditPropertyDialog } from './PropertyForm/EditPropertyDialog.js';
import { TablePageContext } from './tablePageContext.js';
import { useResourceNavigation } from '@tomic/resource-ui/ResourceUIHost';
import { useNavigateWithTransition } from '@tomic/resource-ui/ResourceUIHost';

/** Imperative handle so the header can open this menu on right-click. */
export interface TableHeadingMenuHandle {
  openAt: (event: React.MouseEvent) => void;
}

interface TableHeadingMenuProps {
  resource: Resource;
  ref?: Ref<TableHeadingMenuHandle>;
}

const Trigger = buildDefaultTrigger(
  <FaEllipsisVertical />,
  () => 'Edit column',
);

export function TableHeadingMenu({
  resource,
  ref,
}: TableHeadingMenuProps): JSX.Element {
  const [showEditDialog, setShowEditDialog] = useState(false);
  // Cursor point of a right-click-opened menu (undefined = closed). Shares its
  // `items` and dialogs with the kebab-triggered menu below.
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number }>();

  useImperativeHandle(
    ref,
    () => ({
      openAt: (event: React.MouseEvent) => {
        event.preventDefault();
        setMenuPoint({ x: event.clientX, y: event.clientY });
      },
    }),
    [],
  );

  const { tableClassSubject, addFilter, hideColumn, requestColumnRemoval } =
    useContext(TablePageContext);
  const tableClassResource = useResource(tableClassSubject);
  const canWriteClass = useCanWrite(tableClassResource);
  const canWriteProperty = useCanWrite(resource);
  const { constructOpenURL } = useResourceNavigation();
  const navigate = useNavigateWithTransition();

  const items = useMemo(
    (): DropdownItem[] => [
      {
        id: 'view',
        label: 'View',
        onClick: () => {
          navigate(constructOpenURL(resource.subject));
        },
        icon: <FaEye />,
      },
      {
        id: 'filter',
        label: 'Filter',
        onClick: () => addFilter(resource.subject),
        icon: <FaFilter />,
      },
      {
        id: 'hide',
        label: 'Hide in this view',
        onClick: () => hideColumn(resource.subject),
        icon: <FaEyeSlash />,
      },
      {
        id: 'edit',
        label: canWriteProperty ? 'Edit' : 'Edit unavailable',
        onClick: () => setShowEditDialog(true),
        icon: <FaPencil />,
        disabled: !canWriteProperty,
      },
      {
        id: 'remove',
        label: 'Remove',
        onClick: () => requestColumnRemoval(resource),
        icon: <FaXmark />,
        disabled: !canWriteClass,
      },
    ],
    [
      addFilter,
      hideColumn,
      canWriteClass,
      canWriteProperty,
      navigate,
      constructOpenURL,
      resource,
      requestColumnRemoval,
    ],
  );

  return (
    <Wrapper>
      <DropdownMenu Trigger={Trigger} items={items} />
      {menuPoint && (
        <DropdownMenu
          Trigger={AutoOpenTrigger}
          items={items}
          anchorPoint={menuPoint}
          bindActive={active => !active && setMenuPoint(undefined)}
        />
      )}
      <EditPropertyDialog
        resource={resource}
        showDialog={showEditDialog}
        bindShow={setShowEditDialog}
      />
    </Wrapper>
  );
}

const Wrapper = styled.div`
  margin-left: auto;

  & > button {
    color: ${p => resourceTheme(p.theme).colors.textLight};
  }
`;
