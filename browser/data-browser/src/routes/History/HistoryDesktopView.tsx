import type { HistoryViewProps } from './HistoryViewProps';
import { styled } from 'styled-components';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Column, Row } from '../../components/Row';
import { Title } from '../../components/Title';
import { VersionTitle } from './VersionTitle';
import { VersionScroller } from './VersionScroller';

export function HistoryDesktopView({
  resource,
  groupedVersions,
  selectedVersion,
  isCurrentVersion,
  onNextVersion,
  onPreviousVersion,
  onSelectVersion,
  onVersionAccept,
}: HistoryViewProps) {
  return (
    <>
      <CurrentItem>
        <Column fullHeight>
          <Title resource={resource} prefix='History of' link />
          {selectedVersion && (
            <>
              <VersionTitle version={selectedVersion} />
              <StyledCard>
                <PropertiesList>
                  {[...selectedVersion.propvals.entries()]
                    .filter(([key]) => !key.includes('loroUpdate'))
                    .map(([key, value]) => (
                      <PropertyRow key={key}>
                        <PropName>{key.split('/').pop()}</PropName>
                        <PropValue>
                          {typeof value === 'string'
                            ? value
                            : JSON.stringify(value)}
                        </PropValue>
                      </PropertyRow>
                    ))}
                </PropertiesList>
              </StyledCard>
              <Row>
                <Button onClick={onVersionAccept} disabled={isCurrentVersion}>
                  Restore this version
                </Button>
              </Row>
            </>
          )}
        </Column>
      </CurrentItem>
      <VersionScroller
        persistSelection
        title={`History of ${resource.title}`}
        subject={resource.subject}
        groupedVersions={groupedVersions}
        selectedVersion={selectedVersion}
        onSelectVersion={onSelectVersion}
        onNextItem={onNextVersion}
        onPreviousItem={onPreviousVersion}
      />
    </>
  );
}

const CurrentItem = styled.div`
  flex: 1;
  overflow-y: auto;
`;

const StyledCard = styled(Card)`
  flex: 1;
  overflow-y: auto;
`;

const PropertiesList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem;
`;

const PropertyRow = styled.div`
  display: flex;
  gap: 1rem;
`;

const PropName = styled.span`
  font-weight: bold;
  min-width: 120px;
  color: ${p => p.theme.colors.textLight};
`;

const PropValue = styled.span`
  word-break: break-word;
`;
