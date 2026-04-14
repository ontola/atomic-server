import { HistoryViewProps } from './HistoryViewProps';
import { styled } from 'styled-components';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Column, Row } from '../../components/Row';
import { Title } from '../../components/Title';
import { ResourceCardDefault } from '../../views/Card/ResourceCard';
import { VersionTitle } from './VersionTitle';
import { VersionScroller } from './VersionScroller';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../../helpers/navigation';
import {
  ResourceDiff,
  useResourceDiff,
} from '@components/ResourceDiff/ResourceDiff';
import { Tabs } from '@components/Tabs';
import { plural } from '@helpers/plural';

export function HistoryDesktopView({
  resource,
  groupedVersions,
  selectedVersion,
  olderVersion,
  isCurrentVersion,
  onNextVersion,
  onPreviousVersion,
  onSelectVersion,
  onVersionAccept,
}: HistoryViewProps) {
  const navigate = useNavigateWithTransition();
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

  return (
    <>
      <CurrentItem>
        <Column fullHeight>
          <Title resource={resource} prefix='History of' link />
          <>
            <VersionTitle version={selectedVersion} />
            <StyledCard>
              <Tabs tabs={tabs} label='History'>
                <Card.Content>
                  <Tabs.Panel value='changes'>
                    <ResourceDiff diff={diff} />
                  </Tabs.Panel>
                  <Tabs.Panel value='resource'>
                    <ResourceCardDefault resource={selectedVersion.resource} />
                  </Tabs.Panel>
                </Card.Content>
              </Tabs>
            </StyledCard>
            <Row>
              <Button onClick={onVersionAccept} disabled={isCurrentVersion}>
                Make current version
              </Button>
              <Button
                onClick={() =>
                  navigate(constructOpenURL(selectedVersion.commit.id!))
                }
              >
                Show Commit
              </Button>
            </Row>
          </>
        </Column>
      </CurrentItem>
      <VersionScroller
        persistSelection
        subject={resource.subject}
        groupedVersions={groupedVersions}
        onNextItem={onPreviousVersion}
        onPreviousItem={onNextVersion}
        selectedVersion={selectedVersion}
        onSelectVersion={onSelectVersion}
        title='Versions'
      />
    </>
  );
}

const StyledCard = styled(Card)`
  flex: 1;
  overflow: auto;
  width: 100%;
`;

const CurrentItem = styled.div`
  flex: 1;

  & h1 {
    margin-bottom: 0;
  }
`;
