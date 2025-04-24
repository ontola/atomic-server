import { useId, useState, type JSX } from 'react';
import { ContainerFull } from '../../components/Containers';
import { EditableTitle } from '../../components/EditableTitle';
import type { ResourcePageProps } from '../ResourcePage';
import { Row as FlexRow, Column } from '../../components/Row';
import { IconButton } from '../../components/IconButton/IconButton';
import { FaCode, FaFileCsv } from 'react-icons/fa6';
import { ResourceCodeUsageDialog } from '../CodeUsage/ResourceCodeUsageDialog';
import { TableExportDialog } from './TableExportDialog';
import { TagBar } from '../../components/Tag/TagBar';
import { TableResource } from './TableResource';

export function TablePage({ resource }: ResourcePageProps): JSX.Element {
  const titleId = useId();

  const [showCodeUsageDialog, setShowCodeUsageDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);

  return (
    <ContainerFull>
      <Column>
        <FlexRow justify='space-between'>
          <EditableTitle resource={resource} id={titleId} />
          <FlexRow style={{ marginRight: '1rem' }}>
            <IconButton
              title='Use in code'
              onClick={() => setShowCodeUsageDialog(true)}
            >
              <FaCode />
            </IconButton>
            <IconButton
              title='Export to CSV'
              onClick={() => setShowExportDialog(true)}
            >
              <FaFileCsv />
            </IconButton>
          </FlexRow>
        </FlexRow>
        <TagBar resource={resource} />
        <TableResource resource={resource} />
      </Column>
      <ResourceCodeUsageDialog
        subject={resource.subject}
        show={showCodeUsageDialog}
        bindShow={setShowCodeUsageDialog}
      />
      <TableExportDialog
        subject={resource.subject}
        show={showExportDialog}
        bindShow={setShowExportDialog}
      />
    </ContainerFull>
  );
}
