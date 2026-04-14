import { HistoryViewProps } from './HistoryViewProps';
import { styled } from 'styled-components';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Column } from '../../components/Row';
import { ResourceCardDefault } from '../../views/Card/ResourceCard';
import { VersionTitle } from './VersionTitle';
import { VersionScroller } from './VersionScroller';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '../../components/Dialog';
import { Version } from '@tomic/react';
import {
  ResourceDiff,
  useResourceDiff,
} from '@components/ResourceDiff/ResourceDiff';
import { plural } from '@helpers/plural';
import { Tabs } from '@components/Tabs';

export function HistoryMobileView({
  resource,
  groupedVersions,
  selectedVersion,
  olderVersion,
  onSelectVersion,
  onVersionAccept,
}: HistoryViewProps) {
  const [dialogProps, showDialog, closeDialog] = useDialog();

  const diff = useResourceDiff(
    olderVersion?.resource,
    selectedVersion.resource,
  );

  const changesCountText = plural(diff.changedProps.length, [
    '1 Change',
    '# Changes',
  ]);

  const tabs = [
    { label: changesCountText, value: 'changes' },
    { label: 'Resource', value: 'resource' },
  ];

  const handleVersionSelect = (version: Version) => {
    onSelectVersion(version);
    showDialog();
  };

  return (
    <>
      <CenteredScroller
        title={`History of ${resource.title}`}
        subject={resource.subject}
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
            {selectedVersion && selectedVersion?.resource && (
              <>
                <VersionTitle version={selectedVersion} />
                <StyledCard>
                  <Tabs tabs={tabs} label='History'>
                    <Card.Content>
                      <Tabs.Panel value='changes'>
                        <ResourceDiff diff={diff} />
                      </Tabs.Panel>
                      <Tabs.Panel value='resource'>
                        <ResourceCardDefault
                          resource={selectedVersion.resource}
                        />
                      </Tabs.Panel>
                    </Card.Content>
                  </Tabs>
                </StyledCard>
              </>
            )}
          </Column>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => closeDialog(false)} subtle>
            Cancel
          </Button>
          <Button onClick={onVersionAccept}>Make current version</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

const StyledCard = styled(Card)`
  overflow: auto;
`;

const CenteredScroller = styled(VersionScroller)`
  margin-inline: auto;
`;
