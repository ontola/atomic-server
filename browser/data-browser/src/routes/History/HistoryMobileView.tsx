import { useCallback } from 'react';
import type { HistoryViewProps } from './HistoryViewProps';
import { styled } from 'styled-components';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Column } from '../../components/Row';
import { VersionTitle } from './VersionTitle';
import { VersionScroller } from './VersionScroller';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '../../components/Dialog';
import type { Version } from '@tomic/react';

export function HistoryMobileView({
  resource,
  groupedVersions,
  selectedVersion,
  onSelectVersion,
  onVersionAccept,
}: HistoryViewProps) {
  const [dialogProps, showDialog, closeDialog] = useDialog();

  const handleVersionSelect = useCallback((version: Version) => {
    onSelectVersion(version);
    showDialog();
  }, []);

  return (
    <>
      <CenteredScroller
        title={`History of ${resource.title}`}
        subject={resource.getSubject()}
        groupedVersions={groupedVersions}
        selectedVersion={selectedVersion}
        onSelectVersion={handleVersionSelect}
      />
      <Dialog {...dialogProps}>
        <DialogTitle>
          <h1>Version</h1>
        </DialogTitle>
        <DialogContent>
          <Column fullHeight>
            {selectedVersion && (
              <>
                <VersionTitle version={selectedVersion} />
                <StyledCard>
                  <PropertiesList>
                    {[...selectedVersion.propvals.entries()]
                      .filter(([key]) => !key.includes('loroUpdate'))
                      .map(([key, value]) => (
                        <div key={key}>
                          <strong>{key.split('/').pop()}: </strong>
                          {typeof value === 'string'
                            ? value
                            : JSON.stringify(value)}
                        </div>
                      ))}
                  </PropertiesList>
                </StyledCard>
              </>
            )}
          </Column>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => closeDialog(false)} subtle>
            Cancel
          </Button>
          <Button onClick={onVersionAccept}>Restore this version</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

const StyledCard = styled(Card)`
  overflow: auto;
`;

const PropertiesList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem;
`;

const CenteredScroller = styled(VersionScroller)`
  margin-inline: auto;
`;
