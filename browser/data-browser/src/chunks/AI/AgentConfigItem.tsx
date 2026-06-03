import { IconButton } from '@components/IconButton/IconButton';
import { Column, Row } from '@components/Row';
import {
  FaStar,
  FaTriangleExclamation,
  FaPencil,
  FaRegCopy,
  FaTrash,
  FaEllipsisVertical,
} from 'react-icons/fa6';
import type { AIAgent } from './types';
import { styled, useTheme } from 'styled-components';
import { transition } from '@helpers/transition';
import { useAIAgentConfig } from './AgentConfig';
import { useAISettings } from '@components/AI/AISettingsContext';
import { useId } from 'react';
import { VisuallyHidden } from '@components/VisuallyHidden';
import { DropdownMenu, type DropdownItem } from '@components/Dropdown';
import { buildDefaultTrigger } from '@components/Dropdown/DefaultTrigger';
import { addIf } from '@helpers/addIf';

interface AgentConfigItemProps {
  agent: AIAgent;
  selected: boolean;
  onSelect: (agent: AIAgent) => void;
  onEdit: (agent: AIAgent) => void;
  onDelete: (agent: AIAgent) => void;
  onDuplicate: (agent: AIAgent) => void;
  canDelete: boolean;
}

const ContextTrigger = buildDefaultTrigger(
  <FaEllipsisVertical />,
  'Open context menu',
);

export const AgentConfigItem: React.FC<AgentConfigItemProps> = ({
  agent,
  selected,
  onSelect,
  onEdit,
  onDelete,
  onDuplicate,
  canDelete,
}) => {
  const inputId = useId();
  const titleId = useId();
  const descriptionId = useId();

  const theme = useTheme();
  const { defaultAgentId, setDefaultAgentId } = useAIAgentConfig();
  const { isProviderAvailable } = useAISettings();

  const isDefault = defaultAgentId === agent.id;
  const providerDisabled = !isProviderAvailable(agent.model.provider);

  const contextItems: DropdownItem[] = [
    {
      label: 'Edit',
      id: 'edit',
      icon: <FaPencil />,
      onClick: () => onEdit(agent),
    },
    {
      label: 'Duplicate',
      id: 'duplicate',
      icon: <FaRegCopy />,
      onClick: () => onDuplicate(agent),
    },
    ...addIf(canDelete, {
      label: 'Delete',
      id: 'delete',
      icon: <FaTrash />,
      onClick: () => onDelete(agent),
    }),
  ];

  return (
    <AgentListItem
      key={agent.id}
      selected={selected}
      onClick={e => {
        const tag = (e.target as HTMLElement).tagName.toLowerCase();

        if (tag === 'button' || tag === 'svg' || tag === 'path') return;
        if (providerDisabled) return;
        onSelect(agent);
      }}
    >
      {/* The entire selector is also done via radio buttons to allow for keyboard navigation */}
      <VisuallyHidden>
        <input
          disabled={providerDisabled}
          type='radio'
          id={inputId}
          name='agent'
          value={agent.id}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
        />
      </VisuallyHidden>

      <Column fullWidth>
        <Row gap='0.2ch' center fullWidth>
          <IconButton
            onClick={e => {
              e.stopPropagation();
              setDefaultAgentId(agent.id);
            }}
            title={isDefault ? 'Default agent' : `Set ${agent.name} as default`}
            edgeAlign='start'
          >
            <FaStar color={isDefault ? theme.colors.main : theme.colors.bg2} />
          </IconButton>
          <Column gap='0'>
            <Row gap='1ch' center>
              <AgentName id={titleId} htmlFor={inputId}>
                {agent.name}
              </AgentName>
              {providerDisabled && (
                <FaTriangleExclamation
                  title='Provider not enabled'
                  color={theme.colors.warning}
                />
              )}
            </Row>
            <AgentDescription>{agent.model.id}</AgentDescription>
          </Column>
          <span style={{ flex: 1 }} />
          <DropdownMenu items={contextItems} Trigger={ContextTrigger} />
        </Row>
        <AgentDescription id={descriptionId}>
          {agent.description}
        </AgentDescription>
      </Column>
    </AgentListItem>
  );
};

const AgentListItem = styled.li<{ selected: boolean }>`
  padding: ${p => p.theme.size(3)};
  margin: 0;
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg1};
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: ${p =>
    p.selected ? `0 0 0 2px ${p.theme.colors.main}` : 'none'};
  ${transition('box-shadow')}

  &:hover, &:has(input[type='radio']:focus) {
    &:not(:has(input[type='radio']:disabled)) {
      filter: brightness(0.95);
    }
  }
`;

const AgentName = styled.label`
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
`;

const AgentDescription = styled.p`
  font-size: 0.875rem;
  color: ${p => p.theme.colors.textLight};
  margin: ${p => p.theme.size(1)} 0 0;
`;
