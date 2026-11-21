import { resourceTheme } from '@tomic/resource-ui/theme';
import {
  Resource,
  properties,
  useCanWrite,
  useResource,
  useString,
  core,
} from '@tomic/react';
import {
  useCallback,
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
import {
  ConfirmationDialog,
  ConfirmationDialogTheme,
} from '@tomic/resource-ui/components/ConfirmationDialog';
import { ResourceInline } from '@tomic/resource-ui/views/ResourceInline/index';
import { ResourceUsage } from '@tomic/resource-ui/components/ResourceUsage/index';
import { useResourceNavigation } from '@tomic/resource-ui/ResourceUIHost';
import { Checkbox, CheckboxLabel } from '@tomic/ui/components/forms/Checkbox';
import { Column } from '@tomic/ui/components/Row';
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

const useIsExternalProperty = (property: Resource) => {
  const { tableClassSubject } = useContext(TablePageContext);
  const [parent] = useString(property, properties.parent);

  return parent !== tableClassSubject;
};

export function TableHeadingMenu({
  resource,
  ref,
}: TableHeadingMenuProps): JSX.Element {
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog_internal] = useState(false);
  const [fullDelete, setFullDelete] = useState(false);
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

  const setShowDeleteDialog = useCallback((show: boolean) => {
    setShowDeleteDialog_internal(show);

    if (!show) {
      setFullDelete(false);
    }
  }, []);

  const { tableClassSubject, addFilter, hideColumn } =
    useContext(TablePageContext);
  const tableClassResource = useResource(tableClassSubject);
  const canWriteClass = useCanWrite(tableClassResource);
  const canWriteProperty = useCanWrite(resource);
  const { constructOpenURL } = useResourceNavigation();
  const navigate = useNavigateWithTransition();

  const isExternalProperty = useIsExternalProperty(resource);

  const removeProperty = useCallback(async () => {
    const recommends = tableClassResource.getArray(
      core.properties.recommends,
    ) as string[];
    const requires = tableClassResource.getArray(
      core.properties.requires,
    ) as string[];

    await tableClassResource.set(
      core.properties.recommends,
      recommends.filter(r => r !== resource.subject),
    );

    await tableClassResource.set(
      core.properties.requires,
      requires.filter(r => r !== resource.subject),
    );

    await tableClassResource.save();
  }, [tableClassResource, resource]);

  const deleteProperty = useCallback(async () => {
    await removeProperty();

    resource.destroy();
  }, [removeProperty, resource]);

  const onConfirm = useCallback(() => {
    if (isExternalProperty) {
      removeProperty();
    } else {
      deleteProperty();
    }
  }, [deleteProperty, removeProperty, isExternalProperty]);

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
        onClick: () => setShowDeleteDialog(true),
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
      resource.subject,
      setShowDeleteDialog,
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
      <ConfirmationDialog
        title={fullDelete ? 'Delete property' : 'Remove column'}
        confirmLabel={fullDelete ? 'Delete' : 'Remove'}
        show={showDeleteDialog}
        bindShow={setShowDeleteDialog}
        theme={ConfirmationDialogTheme.Alert}
        onConfirm={onConfirm}
      >
        <Column>
          <p>
            Remove <ResourceInline subject={resource.subject} /> from{' '}
            <ResourceInline subject={tableClassSubject} />
          </p>
          <ResourceUsage resource={resource} />
          <CheckboxLabel>
            <Checkbox checked={fullDelete} onChange={setFullDelete} />
            Delete property and its children
          </CheckboxLabel>
        </Column>
      </ConfirmationDialog>
    </Wrapper>
  );
}

const Wrapper = styled.div`
  margin-left: auto;

  & > button {
    color: ${p => resourceTheme(p.theme).colors.textLight};
  }
`;
