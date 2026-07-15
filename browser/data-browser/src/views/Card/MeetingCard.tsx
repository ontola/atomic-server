import { Column, Row } from '@components/Row';
import { ResourceCardTitle } from './ResourceCardTitle';
import { ResourceContextMenu } from '@components/ResourceContextMenu';
import { dataBrowser, useNumber } from '@tomic/react';
import { useDocumentText } from '@hooks/useDocumentText';
import type { CardViewProps } from './CardViewProps';
import { getMeetingPhase } from '../Meeting/meetingLifecycle';

export function MeetingCard({ resource }: CardViewProps): React.JSX.Element {
  const [startedAt] = useNumber(
    resource,
    dataBrowser.properties.meetingStartedAt,
  );
  const [endedAt] = useNumber(resource, dataBrowser.properties.meetingEndedAt);
  const text = useDocumentText(resource, 300);

  return (
    <Column gap='0.5rem'>
      <ResourceCardTitle resource={resource}>
        <Row center gap='1ch'>
          <span>{getMeetingPhase(startedAt, endedAt)}</span>
          <ResourceContextMenu simple subject={resource.subject} />
        </Row>
      </ResourceCardTitle>
      {text && <div>{text}</div>}
    </Column>
  );
}
