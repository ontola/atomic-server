import {
  useCallback,
  useId,
  useMemo,
  useState,
  lazy,
  Suspense,
  type JSX,
} from 'react';
import { styled } from 'styled-components';
import { ContainerFull } from '@components/Containers';
import { EditableTitle } from '@components/EditableTitle';
import { ResourceCoverImage } from '@components/ResourceDecorations';
import type { ResourcePageProps } from '@views/ResourcePage';
import { Row as FlexRow, Column } from '@components/Row';
import { FaFileCsv, FaPlug, FaWandMagicSparkles } from 'react-icons/fa6';
import { TableExportDialog } from './TableExportDialog';
import { TableResource } from './TableResource';
import { useCustomContextItems } from '@components/ResourceContextMenu/CustomContextItemsContext';
import { DIVIDER } from '@components/Dropdown';
import { useSettings } from '@helpers/AppSettings';
import type { WorkspaceSection } from '../PluginRuns/WorkspaceControls';

const WorkspaceControls = lazy(() =>
  import('../PluginRuns/WorkspaceControls').then(m => ({
    default: m.WorkspaceControls,
  })),
);

export function TablePage({ resource }: ResourcePageProps): JSX.Element {
  const titleId = useId();

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
  padding-bottom: ${p => p.theme.size()};
`;
