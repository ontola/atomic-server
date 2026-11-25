import { resourceTheme } from '@tomic/resource-ui/theme';
import {
  useCallback,
  useId,
  useMemo,
  useState,
  Suspense,
  type JSX,
} from 'react';
import { core, useString, useResource, useCanWrite } from '@tomic/react';
import { useNavigate } from '@tomic/resource-ui/ResourceUIHost';
import {
  useResourceUIHost,
  type WorkspaceSection,
} from '@tomic/resource-ui/ResourceUIHost';
import { useTableFormColumns } from '@tomic/resource-ui/chunks/FormBuilder/useTableFormColumns';
import { EditPropertyDialog } from './PropertyForm/EditPropertyDialog.js';
import { styled } from 'styled-components';
import { ContainerFull } from '@tomic/ui/components/Containers';
import { EditableTitle } from '@tomic/resource-ui/components/EditableTitle';
import { ResourceCoverImage } from '@tomic/resource-ui/components/ResourceDecorations';
import type { ResourcePageProps } from '@tomic/resource-ui/ResourceUIHost';
import { Row as FlexRow, Column } from '@tomic/ui/components/Row';
import { FaFileCsv, FaPlug, FaWandMagicSparkles } from 'react-icons/fa6';
import { TableForms } from './TableForms.js';
import { TableExportDialog } from './TableExportDialog.js';
import { TableResource } from './TableResource.js';
import { useCustomContextItems } from '@tomic/resource-ui/components/ResourceContextMenu/CustomContextItemsContext';
import { DIVIDER } from '@tomic/resource-ui/components/Dropdown/index';
import { useSettings } from '@tomic/resource-ui/ResourceUIHost';

export function TablePage({ resource }: ResourcePageProps): JSX.Element {
  const titleId = useId();
  const { search, WorkspaceControls } = useResourceUIHost();
  const navigate = useNavigate();
  const column = useResource(search.editColumn);
  const [classSubject] = useString(resource, core.properties.classtype);
  const { columns } = useTableFormColumns(classSubject ?? '');
  const canWrite = useCanWrite(resource);
  const editColumn =
    !!search.editColumn &&
    canWrite &&
    columns.some(p => p.subject === search.editColumn);

  const { drive } = useSettings();

  const [showExportDialog, setShowExportDialog] = useState(false);
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection>();
  const closeWorkspaceControls = useCallback(
    () => setWorkspaceSection(undefined),
    [],
  );

  const customMenuItems = useMemo(
    () => [
      DIVIDER,
      ...(drive
        ? [
            {
              id: 'connections',
              label: 'Connections',
              onClick: () => setWorkspaceSection('connections'),
              icon: <FaPlug />,
            },
            {
              id: 'automations',
              label: 'Automations',
              onClick: () => setWorkspaceSection('automations'),
              icon: <FaWandMagicSparkles />,
            },
          ]
        : []),
      {
        id: 'export-csv',
        label: 'Export to CSV',
        onClick: () => setShowExportDialog(true),
        icon: <FaFileCsv />,
      },
    ],
    [drive],
  );

  useCustomContextItems(customMenuItems);

  const focusTable = () => {
    // Focus the first editable cell (row 0, col 1)
    const firstCell = document.querySelector<HTMLElement>(
      '[role="row"][aria-rowindex="2"] > [role="gridcell"][aria-colindex="2"]',
    );

    if (firstCell) {
      firstCell.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
      );
      firstCell.focus();
    } else {
      document.querySelector<HTMLElement>('[role="grid"]')?.focus();
    }
  };

  return (
    <>
      <ResourceCoverImage resource={resource} />
      {editColumn && (
        <EditPropertyDialog
          resource={column}
          showDialog
          bindShow={visible => {
            if (!visible)
              void navigate({
                to: '.',
                search: previous =>
                  previous.editColumn === search.editColumn &&
                  previous.subject === search.subject
                    ? { ...previous, editColumn: undefined }
                    : previous,
                replace: true,
              });
          }}
        />
      )}
      <BoundedHeightContainer>
        <Column>
          <FlexRow justify='space-between'>
            <EditableTitle
              resource={resource}
              id={titleId}
              onCommit={focusTable}
              withDecorations
            />
          </FlexRow>
          <TableResource resource={resource} />
          <TableForms table={resource} />
        </Column>
        {workspaceSection && (
          <Suspense fallback={null}>
            <WorkspaceControls
              workspace={resource.subject}
              section={workspaceSection}
              onClosed={closeWorkspaceControls}
            />
          </Suspense>
        )}
        <TableExportDialog
          subject={resource.subject}
          show={showExportDialog}
          bindShow={setShowExportDialog}
        />
      </BoundedHeightContainer>
    </>
  );
}

/**
 * Every view on this page sizes itself to the page rather than to its content,
 * so the 10rem of scroll room `ContainerFull` keeps below a document would be
 * empty space you can scroll the table's header row out of view to reach.
 */
const BoundedHeightContainer = styled(ContainerFull)`
  padding-bottom: ${p => resourceTheme(p.theme).size()};
`;
