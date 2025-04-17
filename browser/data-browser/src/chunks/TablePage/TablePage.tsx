import { useId, useMemo, useState, type JSX } from 'react';
import { ContainerFull } from '@components/Containers';
import { EditableTitle } from '@components/EditableTitle';
import type { ResourcePageProps } from '@views/ResourcePage';
import { Row as FlexRow, Column } from '@components/Row';
import { FaFileCsv } from 'react-icons/fa6';
import { TableExportDialog } from './TableExportDialog';
import { TagBar } from '@components/Tag/TagBar';
import { TableResource } from './TableResource';
import { useCustomContextItems } from '@components/ResourceContextMenu/CustomContextItemsContext';
import { DIVIDER } from '@components/Dropdown';

export function TablePage({ resource }: ResourcePageProps): JSX.Element {
  const titleId = useId();

  const [showExportDialog, setShowExportDialog] = useState(false);

  const customMenuItems = useMemo(
    () => [
      DIVIDER,
      {
        id: 'export-csv',
        label: 'Export to CSV',
        onClick: () => setShowExportDialog(true),
        icon: <FaFileCsv />,
      },
    ],
    [],
  );

  useCustomContextItems(customMenuItems);

  return (
    <ContainerFull>
      <Column>
        <FlexRow justify='space-between'>
          <EditableTitle resource={resource} id={titleId} />
        </FlexRow>
        <TagBar resource={resource} />
        <TableResource resource={resource} />
      </Column>
      <TableExportDialog
        subject={resource.subject}
        show={showExportDialog}
        bindShow={setShowExportDialog}
      />
    </ContainerFull>
  );
}
