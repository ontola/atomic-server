import { useResource } from '@tomic/react';
import type { AIMessageContext } from './types';
import { styled } from 'styled-components';
import { FaXmark } from 'react-icons/fa6';
import { IconButton } from '@components/IconButton/IconButton';

interface ChatContextItemProps {
  contextItem: AIMessageContext;
  onRemove?: (item: AIMessageContext) => void;
}

const renderContent = (contextItem: AIMessageContext) => {
  if (contextItem.type === 'atomic-resource') {
    return <ResourceContextItem subject={contextItem.subject} />;
  }

  if (contextItem.type === 'skill') {
    return <span>/{contextItem.name}</span>;
  }

  return <span>{contextItem.name}</span>;
};

export const MessageContextItem = ({
  contextItem,
  onRemove,
}: ChatContextItemProps) => {
  return (
    <Badge>
      {renderContent(contextItem)}
      {onRemove && (
        <IconButton title='Remove' onClick={() => onRemove(contextItem)}>
          <FaXmark />
        </IconButton>
      )}
    </Badge>
  );
};

interface ResourceContextItemProps {
  subject: string;
}

const ResourceContextItem = ({ subject }: ResourceContextItemProps) => {
  const resource = useResource(subject);

  if (resource.error || resource.loading) {
    return 'loading...';
  }

  return resource.title;
};

const Badge = styled.span`
  display: inline-flex;
  align-items: center;
  background-color: ${p => p.theme.colors.mainSelectedBg};
  border-radius: ${p => p.theme.radius};
  padding-inline: ${p => p.theme.size(1)};
  color: ${p => p.theme.colors.mainSelectedFg};
  border: 1px solid ${p => p.theme.colors.mainSelectedFg};
  font-size: 0.6rem;
`;
