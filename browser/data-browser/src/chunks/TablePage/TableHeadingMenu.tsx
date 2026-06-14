import {
  Resource,
  properties,
  useCanWrite,
  useResource,
  useString,
  core,
} from '@tomic/react';
import { useCallback, useContext, useMemo, useState, type JSX } from 'react';
import { DropdownMenu, DropdownItem } from '@components/Dropdown';
import { buildDefaultTrigger } from '@components/Dropdown/DefaultTrigger';
import {
  FaPencil,
  FaEllipsisVertical,
  FaEye,
  FaEyeSlash,
  FaXmark,
  FaFilter,
} from 'react-icons/fa6';
import { styled } from 'styled-components';
import { EditPropertyDialog } from './PropertyForm/EditPropertyDialog';
import { TablePageContext } from './tablePageContext';
import {
  ConfirmationDialog,
  ConfirmationDialogTheme,
} from '@components/ConfirmationDialog';
import { ResourceInline } from '@views/ResourceInline';
import { ResourceUsage } from '@components/ResourceUsage';
import { constructOpenURL } from '../../helpers/navigation';
import { Checkbox, CheckboxLabel } from '@components/forms/Checkbox';
import { Column } from '@components/Row';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';

interface TableHeadingMenuProps {
  resource: Resource;
}

const Trigger = buildDefaultTrigger(<FaEllipsisVertical />, 'Edit column');

const useIsExternalProperty = (property: Resource) => {
  const { tableClassSubject } = useContext(TablePageContext);
  const [parent] = useString(property, properties.parent);

  return parent !== tableClassSubject;
};

export function TableHeadingMenu({
  resource,
}: TableHeadingMenuProps): JSX.Element {
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog_internal] = useState(false);
  const [fullDelete, setFullDelete] = useState(false);

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
        label: 'Edit',
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
      resource.subject,
      setShowDeleteDialog,
    ],
  );

  return (
    <Wrapper>
      <DropdownMenu Trigger={Trigger} items={items} />
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
    color: ${p => p.theme.colors.textLight};
  }
`;
