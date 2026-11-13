import {
  Resource,
  properties,
  useCanWrite,
  useResource,
  useString,
  core,
} from '@tomic/react';
import { useCallback, useContext, useState, type JSX, type Ref } from 'react';
import { DropdownMenu } from '@components/Dropdown';
import { buildDefaultTrigger } from '@components/Dropdown/DefaultTrigger';
import { AutoOpenTrigger } from '@components/Dropdown/AutoOpenTrigger';
import { FaEllipsisVertical } from 'react-icons/fa6';
import toast from 'react-hot-toast';
import {
  executeTableColumnRemoval,
  TablePropertyMenu,
  type TablePropertyMenuHandle,
  type TablePropertyMenuPresentation,
} from '@tomic/table';
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

export type { TablePropertyMenuHandle as TableHeadingMenuHandle } from '@tomic/table';

interface TableHeadingMenuProps {
  resource: Resource;
  ref?: Ref<TablePropertyMenuHandle>;
}

const Trigger = buildDefaultTrigger(<FaEllipsisVertical />, 'Edit column');

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

  const canDeleteDefinition = !isExternalProperty && canWriteProperty;
  const onConfirm = useCallback(() => {
    return executeTableColumnRemoval(
      {
        deleteDefinition: fullDelete,
        canRemove: canWriteClass,
        canDeleteDefinition,
      },
      {
        removeFromSchema: removeProperty,
        deleteDefinition: () => resource.destroy(),
      },
    ).catch(error => {
      toast.error(`Failed to remove column: ${error.message}`);
    });
  }, [
    fullDelete,
    canWriteClass,
    canDeleteDefinition,
    removeProperty,
    resource,
  ]);

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
            run: () => setShowEditDialog(true),
            disabled: !canWriteProperty,
          },
          remove: {
            run: () => setShowDeleteDialog(true),
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
            <Checkbox
              checked={fullDelete}
              disabled={!canDeleteDefinition && !fullDelete}
              onChange={checked => {
                if (!checked || canDeleteDefinition) setFullDelete(checked);
              }}
            />
            Delete property and its children
          </CheckboxLabel>
        </Column>
      </ConfirmationDialog>
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
