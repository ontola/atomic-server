import { Ai, useResource } from '@tomic/react';
import type { CardViewProps } from './CardViewProps';
import { Column, Row } from '@tomic/ui/components/Row';
import { ResourceCardTitle } from './ResourceCardTitle';
import Markdown from '@tomic/resource-ui/components/datatypes/Markdown';
import { ResourceContextMenu } from '../../components/ResourceContextMenu';

export const AIChatContentCard: React.FC<CardViewProps> = ({ resource }) => {
  const message = useResource<Ai.AiMessage>(resource.props.parent);
  const chat = useResource<Ai.AiChat>(message.props.parent);

  return (
    <Column gap='0.5rem'>
      <ResourceCardTitle resource={chat}>
        <Row center gap='1ch'>
          <span>ai-chat</span>
          <ResourceContextMenu simple subject={chat.subject} />
        </Row>
      </ResourceCardTitle>
      <Markdown
        markExternalLinks
        maxLength={1000}
        renderGFM
        text={resource.props.description ?? ''}
      />
    </Column>
  );
};
