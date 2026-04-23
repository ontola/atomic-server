import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import { Row, Column } from '@components/Row';
import { FaPlus } from 'react-icons/fa6';
import { ModelSelect } from './ModelSelect/ModelSelect';
import { AIProvider } from '@components/AI/aiContstants';
import { type AIAgent, type AIModelIdentifier } from './types';
import { useLocalStorage } from '@hooks/useLocalStorage';
import { Button } from '@components/Button';
import { SkeletonButton } from '@components/SkeletonButton';
import { MarkdownInput } from '@components/forms/MarkdownInput';
import { Checkbox, CheckboxLabel } from '@components/forms/Checkbox';
import {
  Input,
  InputWrapper,
  InputStyled,
} from '@components/forms/InputStyles';
import { useAISettings } from '@components/AI/AISettingsContext';
import { AgentConfigItem } from './AgentConfigItem';
import atomicAgentPrompt from './system-prompts/atomic-agent.md?raw';
import Field from '@components/forms/Field';

// Add this formatter at the top of the file, after imports
const temperatureFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Helper function to generate a unique ID
const generateId = () => {
  return `custom-user-agent.${Math.random().toString(36).substring(2, 11)}`;
};

interface AgentConfigTabProps {
  selectedAgent: AIAgent;
  onSelectAgent: (agent: AIAgent) => void;
}

const defaultNewAgent: Omit<AIAgent, 'id'> = {
  name: '',
  description: '',
  systemPrompt: '',
  availableTools: [],
  model: {
    id: 'google/gemini-3-flash-preview',
    provider: AIProvider.OpenRouter,
  },
  canReadAtomicData: false,
  canWriteAtomicData: false,
  ragEnabled: false,
  skillsEnabled: true,
  temperature: 0.1,
};

const defaultAgents: AIAgent[] = [
  {
    name: 'Atomic Data Agent',
    id: 'dev.atomicdata.atomic-agent',
    description:
      "An agent that is specialized in helping you use AtomicServer. It takes context from what you're doing.",
    systemPrompt: atomicAgentPrompt,
    availableTools: [],
    model: {
      id: 'google/gemini-3-flash-preview',
      provider: AIProvider.OpenRouter,
    },
    canReadAtomicData: true,
    canWriteAtomicData: true,
    ragEnabled: false,
    skillsEnabled: true,
    temperature: 0.1,
  },
  {
    name: 'General Agent',
    id: 'dev.atomicdata.general-agent',
    description: "A basic agent that doesn't have any special purpose.",
    systemPrompt: `The current date is {{timestamp}}`,
    availableTools: [],
    model: {
      id: 'google/gemini-3-flash-preview',
      provider: AIProvider.OpenRouter,
    },
    canReadAtomicData: false,
    canWriteAtomicData: false,
    ragEnabled: false,
    skillsEnabled: true,
    temperature: 0.1,
  },
];

export const useAIAgentConfig = () => {
  const [agents, setAgents] = useLocalStorage<AIAgent[]>(
    'atomic.ai.agents',
    defaultAgents,
  );
  const [defaultAgentId, setDefaultAgentId] = useLocalStorage<string>(
    'atomic.ai.defaultAgentId',
    agents[0]?.id || '',
  );

  const [agentChatIndex, setAgentChatIndex] = useLocalStorage<
    Record<string, string>
  >('atomic.ai.lastUsedAgentInChat', {});

  // Remember the last used agent in the sidebar but don't keep it
  const [lastUsedSidebarAgent, setLastUsedSidebarAgent] =
    useLocalStorage<string>(
      'atomic.ai.sidebar.lastUsedAgent',
      defaultAgentId,
      window.sessionStorage,
    );

  // Save agents to settings
  const saveAgents = (newAgents: AIAgent[]) => {
    setAgents(newAgents);
  };

  const getInitialAgent = (sideBar: boolean, chatSubject?: string) => {
    if (sideBar) {
      return agents.find(a => a.id === lastUsedSidebarAgent) ?? agents[0];
    } else if (chatSubject) {
      const id = agentChatIndex[chatSubject] ?? defaultAgentId;

      return agents.find(a => a.id === id) ?? agents[0];
    }

    return agents.find(a => a.id === defaultAgentId) ?? agents[0];
  };

  const setLastUsedAgentForChat = (chatSubject: string, agentId: string) => {
    setAgentChatIndex({ ...agentChatIndex, [chatSubject]: agentId });
  };

  return {
    agents,
    saveAgents,
    defaultAgentId,
    setDefaultAgentId,
    setLastUsedAgentForChat,
    setLastUsedSidebarAgent,
    getInitialAgent,
  };
};

export const AgentConfigTab = ({
  selectedAgent,
  onSelectAgent,
}: AgentConfigTabProps) => {
  const { agents, saveAgents } = useAIAgentConfig();
  const [editingAgent, setEditingAgent] = useState<AIAgent | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const handleSaveAgent = () => {
    if (!editingAgent) return;

    const newAgents = isCreating
      ? [...agents, editingAgent]
      : agents.map((agent: AIAgent) =>
          // Use ID to identify which agent we're editing
          agent.id === editingAgent.id ? editingAgent : agent,
        );

    saveAgents(newAgents);

    // If we're editing the currently selected agent or creating a new one, update selection
    if (selectedAgent.id === editingAgent.id || isCreating) {
      onSelectAgent(editingAgent);
    }

    setEditingAgent(null);
    setIsCreating(false);
  };

  const handleDeleteAgent = (agentToDelete: AIAgent) => {
    if (agents.length <= 1) {
      // Prevent deleting the last agent
      return;
    }

    const newAgents = agents.filter(
      (agent: AIAgent) => agent.id !== agentToDelete.id,
    );
    saveAgents(newAgents);

    // If we're deleting the currently selected agent, select the first available
    if (selectedAgent.id === agentToDelete.id) {
      onSelectAgent(newAgents[0]);
    }
  };

  const handleCreateNewAgent = () => {
    setEditingAgent({
      ...defaultNewAgent,
      id: generateId(),
    });
    setIsCreating(true);
  };

  const handleEditAgent = (agent: AIAgent) => {
    setEditingAgent({ ...agent });
    setIsCreating(false);
  };

  const handleCancel = () => {
    setEditingAgent(null);
    setIsCreating(false);
  };

  return (
    <>
      {editingAgent ? (
        <Column>
          <AgentForm agent={editingAgent} onChange={setEditingAgent} />
          <Row justify='flex-end' style={{ marginTop: '1rem' }}>
            <Button subtle onClick={handleCancel}>
              Cancel
            </Button>
            <Button onClick={handleSaveAgent}>
              {isCreating ? 'Create Agent' : 'Save Changes'}
            </Button>
          </Row>
        </Column>
      ) : (
        <Column>
          <AgentsList role='radiogroup' aria-label='AI Agents'>
            {agents.map((agent: AIAgent) => (
              <AgentConfigItem
                key={agent.id}
                agent={agent}
                selected={selectedAgent.id === agent.id}
                onSelect={onSelectAgent}
                onEdit={handleEditAgent}
                onDelete={handleDeleteAgent}
              />
            ))}
          </AgentsList>

          <CreateButton onClick={handleCreateNewAgent}>
            <FaPlus title='' /> Create New Agent
          </CreateButton>
        </Column>
      )}
    </>
  );
};

interface AgentFormProps {
  agent: AIAgent;
  onChange: (agent: AIAgent) => void;
}

const AgentForm = ({ agent, onChange }: AgentFormProps) => {
  const { mcpServers } = useAISettings();

  const handleChange = (
    field: keyof AIAgent,
    value: string | boolean | number | AIModelIdentifier,
  ) => {
    onChange({
      ...agent,
      [field]: value,
    });
  };

  const onToggleTool = (toolId: string) => {
    onChange({
      ...agent,
      availableTools: agent.availableTools.includes(toolId)
        ? agent.availableTools.filter(t => t !== toolId)
        : [...agent.availableTools, toolId],
    });
  };

  useEffect(() => {
    // Check if the agent has any tools that are not available any more.
    const currentlyAvailableServers = mcpServers.map(s => s.id);
    const tools = agent.availableTools.filter(tool =>
      currentlyAvailableServers.includes(tool),
    );

    if (tools.length !== agent.availableTools.length) {
      onChange({
        ...agent,
        availableTools: tools,
      });
    }
  }, [mcpServers]);

  const enforceToolSupport =
    agent.availableTools.length > 0 ||
    agent.canReadAtomicData ||
    agent.canWriteAtomicData;

  return (
    <FormContainer>
      <StyledField label='Name' fieldId='agent-name'>
        <Input
          id='agent-name'
          required
          max={50}
          value={agent.name}
          onChange={e => handleChange('name', e.target.value)}
          placeholder='Agent name'
        />
      </StyledField>

      <StyledField label='Description' fieldId='agent-description'>
        <Input
          id='agent-description'
          value={agent.description}
          onChange={e => handleChange('description', e.target.value)}
          placeholder='Agent description'
        />
      </StyledField>

      <StyledField label='System Prompt' fieldId='agent-system-prompt'>
        <MarkdownInput
          key={agent.id}
          id='agent-system-prompt'
          initialContent={agent.systemPrompt}
          onChange={content => handleChange('systemPrompt', content)}
          placeholder='System prompt that defines how the agent behaves'
        />
      </StyledField>

      <StyledField label='Atomic Data Access' multiInput>
        <CheckboxLabel>
          <Checkbox
            checked={agent.canReadAtomicData}
            onChange={checked => handleChange('canReadAtomicData', checked)}
          />
          Read
        </CheckboxLabel>
        <CheckboxLabel>
          <Checkbox
            checked={agent.canWriteAtomicData}
            onChange={checked => handleChange('canWriteAtomicData', checked)}
          />
          Write
        </CheckboxLabel>
        <CheckboxLabel>
          <Checkbox
            checked={agent.ragEnabled}
            onChange={checked => handleChange('ragEnabled', checked)}
          />
          Provide relevant context from your knowledge base to the Agent.
        </CheckboxLabel>
      </StyledField>
      <StyledField label='Tools' multiInput>
        <ToolList>
          {mcpServers.map(server => (
            <li key={server.id}>
              <CheckboxLabel>
                <Checkbox
                  checked={agent.availableTools.includes(server.id)}
                  onChange={() => onToggleTool(server.id)}
                />
                {server.name}
              </CheckboxLabel>
            </li>
          ))}
          {mcpServers.length === 0 && (
            <li>
              <SubtleText>No MCP servers configured.</SubtleText>
            </li>
          )}
        </ToolList>
      </StyledField>
      <StyledField
        label='Skills'
        multiInput
        helper='Give the agent access to skills that provide domain-specific knowledge and guidance. A list of skills will be added to the end of the system prompt.'
      >
        <CheckboxLabel>
          <Checkbox
            checked={agent.skillsEnabled ?? true}
            onChange={checked => handleChange('skillsEnabled', checked)}
          />
          Enable skills
        </CheckboxLabel>
      </StyledField>

      <StyledField label='Model' multiInput>
        <ModelSelect
          defaultModel={agent.model}
          onSelect={model => handleChange('model', model)}
          enforceToolSupport={enforceToolSupport}
        />
      </StyledField>

      <StyledField
        label='Temperature'
        fieldId='agent-temperature'
        helper='Trade accuracy for creativity'
      >
        <Row center fullWidth>
          <RangeInput
            id='agent-temperature'
            type='range'
            min={0}
            max={2}
            step={0.01}
            value={agent.temperature ?? 0}
            onChange={e =>
              handleChange('temperature', parseFloat(e.target.value))
            }
          />
          <InputWrapper>
            <InputStyled
              type='number'
              min={0}
              max={2}
              step={0.01}
              value={temperatureFormatter.format(agent.temperature ?? 0)}
              onChange={e =>
                handleChange('temperature', parseFloat(e.target.value))
              }
              aria-label='Temperature value'
            />
          </InputWrapper>
        </Row>
      </StyledField>
    </FormContainer>
  );
};

// Styled components
const AgentsList = styled.ul`
  list-style: none;
  padding: 0;
  margin: 0;
  margin-top: ${p => p.theme.size(2)};
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size(2)};
`;

const CreateButton = styled(SkeletonButton)`
  width: 100%;
  padding: ${p => p.theme.size(2)} ${p => p.theme.size(3)};
  height: 3rem;
`;

const FormContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size(3)};
`;

const StyledField = styled(Field)`
  & ${Field.Label} {
    font-size: 0.875rem;
  }
`;
const ToolList = styled.ul`
  list-style: none;
  padding: 0;
  margin: 0;

  li {
    list-style: none;
    margin: 0;
    padding: 0;
  }
`;

const RangeInput = styled.input`
  flex: 1;
  flex-basis: 75%;
`;

const SubtleText = styled.p`
  font-size: 0.875rem;
  color: ${p => p.theme.colors.textLight};
`;
