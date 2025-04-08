import { useEffect, useState } from 'react';
import { styled, useTheme } from 'styled-components';
import { Row, Column } from '../Row';
import { FaPencil, FaPlus, FaTrash, FaStar } from 'react-icons/fa6';
import { IconButton } from '../IconButton/IconButton';
import { ModelSelect } from './ModelSelect/ModelSelect';
import { AIProvider, type AIAgent, type AIModelIdentifier } from './types';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  useDialog,
} from '../Dialog';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { Button } from '../Button';
import { SkeletonButton } from '../SkeletonButton';
import { useSettings } from '../../helpers/AppSettings';
import { Checkbox, CheckboxLabel } from '../forms/Checkbox';
import { InputWrapper, InputStyled } from '../forms/InputStyles';
import { transition } from '../../helpers/transition';

// Add this formatter at the top of the file, after imports
const temperatureFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Helper function to generate a unique ID
const generateId = () => {
  return `custom-user-agent.${Math.random().toString(36).substring(2, 11)}`;
};

interface AgentConfigProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedAgent: AIAgent;
  onSelectAgent: (agent: AIAgent) => void;
}

const defaultNewAgent: Omit<AIAgent, 'id'> = {
  name: '',
  description: '',
  systemPrompt: '',
  availableTools: [],
  model: {
    id: 'openai/gpt-4o-mini',
    provider: AIProvider.OpenRouter,
  },
  canReadAtomicData: false,
  canWriteAtomicData: false,
  temperature: 0.1,
};

const defaultAgents: AIAgent[] = [
  {
    name: 'Atomic Data Agent',
    id: 'dev.atomicdata.atomic-agent',
    description:
      "An agent that is specialized in helping you use AtomicServer. It takes context from what you're doing.",
    systemPrompt: `You are an AI assistant in the Atomic Data Browser. Users will ask questions about their data and you will answer by looking at the data or using your own knowledge about the world.
Atomic Data uses JSON-AD, Every resource including the properties themselves have a subject (the '@id' property in the JSON-AD), this is a URL that points to the resource.
Resources are always referenced by subject so make sure you have all the subjects you need before editing or creating resources.

Keep the following things in mind:
- If the user mentions a resource by its name and you don't know the subject, use the search-resource tool to find its subject.
- If you need details on resources referenced by another resource, use the get-atomic-resource tool.
- When talking about a resource, always wrap the title in a link using markdown.
- If you don't know the answer to the users question, try to figure it out by using the tools provided to you.
`,
    availableTools: [],
    model: {
      id: 'openai/gpt-4o-mini',
      provider: AIProvider.OpenRouter,
    },
    canReadAtomicData: true,
    canWriteAtomicData: true,
    temperature: 0.1,
  },
  {
    name: 'General Agent',
    id: 'dev.atomicdata.general-agent',
    description: "A basic agent that doesn't have any special purpose.",
    systemPrompt: ``,
    availableTools: [],
    model: {
      id: 'openai/gpt-4.1-mini',
      provider: AIProvider.OpenRouter,
    },
    canReadAtomicData: false,
    canWriteAtomicData: false,
    temperature: 0.1,
  },
];

// This hook manages the agent configuration
export const useAIAgentConfig = () => {
  const [agents, setAgents] = useLocalStorage<AIAgent[]>(
    'atomic.ai.agents',
    defaultAgents,
  );
  const [autoAgentSelectEnabled, setAutoAgentSelectEnabled] = useLocalStorage(
    'atomic.ai.autoAgentSelect',
    true,
  );
  const [defaultAgentId, setDefaultAgentId] = useLocalStorage<string>(
    'atomic.ai.defaultAgentId',
    agents[0]?.id || '',
  );

  const [agentChatIndex, setAgentChatIndex] = useLocalStorage<
    Record<string, string>
  >('atomic.ai.lastUsedAgentInChat', {});

  // Save agents to settings
  const saveAgents = (newAgents: AIAgent[]) => {
    setAgents(newAgents);
  };

  const getLastUsedAgentForChat = (chatSubject: string) => {
    return agentChatIndex[chatSubject];
  };

  const setLastUsedAgentForChat = (chatSubject: string, agentId: string) => {
    setAgentChatIndex({ ...agentChatIndex, [chatSubject]: agentId });
  };

  return {
    agents: agents.length > 0 ? agents : [],
    autoAgentSelectEnabled,
    setAutoAgentSelectEnabled,
    saveAgents,
    defaultAgentId,
    setDefaultAgentId,
    setLastUsedAgentForChat,
    getLastUsedAgentForChat,
  };
};

export const AgentConfig = ({
  open,
  onOpenChange,
  selectedAgent,
  onSelectAgent,
}: AgentConfigProps) => {
  const {
    agents,
    autoAgentSelectEnabled,
    setAutoAgentSelectEnabled,
    saveAgents,
    defaultAgentId,
    setDefaultAgentId,
  } = useAIAgentConfig();
  const [editingAgent, setEditingAgent] = useState<AIAgent | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const theme = useTheme();
  const [dialogProps, show, _close, isOpen] = useDialog({
    bindShow: onOpenChange,
  });

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

  useEffect(() => {
    if (open) {
      show();
    }
  }, [open]);

  return (
    <Dialog {...dialogProps} width='600px'>
      {isOpen && (
        <>
          <DialogTitle>
            <h1>Select AI Agents</h1>
          </DialogTitle>
          <DialogContent>
            {editingAgent ? (
              <AgentForm agent={editingAgent} onChange={setEditingAgent} />
            ) : (
              <Column>
                <div>
                  <CheckboxLabel>
                    <Checkbox
                      checked={autoAgentSelectEnabled}
                      onChange={setAutoAgentSelectEnabled}
                    />
                    Automatic Agent Selection
                  </CheckboxLabel>
                  <p>
                    Pick best agent for the job based on name, description and
                    available tools
                  </p>
                </div>
                <AgentsList>
                  {agents.map((agent: AIAgent) => (
                    <AgentListItem
                      key={agent.id}
                      selected={agent.id === selectedAgent.id}
                      onClick={() => onSelectAgent(agent)}
                    >
                      <Column>
                        <Row gap='0.2ch' center>
                          <IconButton
                            onClick={e => {
                              e.stopPropagation();
                              setDefaultAgentId(agent.id);
                            }}
                            title={
                              defaultAgentId === agent.id
                                ? 'Default agent'
                                : 'Set as default'
                            }
                            edgeAlign='start'
                          >
                            <FaStar
                              color={
                                defaultAgentId === agent.id
                                  ? theme.colors.main
                                  : theme.colors.bg2
                              }
                            />
                          </IconButton>
                          <AgentName>{agent.name}</AgentName>
                        </Row>
                        <AgentDescription>{agent.description}</AgentDescription>
                      </Column>
                      <Row gap='0.5rem'>
                        <IconButton
                          onClick={e => {
                            e.stopPropagation();
                            handleEditAgent(agent);
                          }}
                          title='Edit agent'
                        >
                          <FaPencil />
                        </IconButton>
                        <IconButton
                          onClick={e => {
                            e.stopPropagation();
                            handleDeleteAgent(agent);
                          }}
                          title='Delete agent'
                          disabled={agents.length <= 1}
                        >
                          <FaTrash />
                        </IconButton>
                      </Row>
                    </AgentListItem>
                  ))}
                </AgentsList>

                <CreateButton onClick={handleCreateNewAgent}>
                  <FaPlus /> Create New Agent
                </CreateButton>
              </Column>
            )}
          </DialogContent>
          {editingAgent && (
            <DialogActions>
              <Button subtle onClick={handleCancel}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  handleSaveAgent();
                }}
              >
                {isCreating ? 'Create Agent' : 'Save Changes'}
              </Button>
            </DialogActions>
          )}
        </>
      )}
    </Dialog>
  );
};

interface AgentFormProps {
  agent: AIAgent;
  onChange: (agent: AIAgent) => void;
}

const AgentForm = ({ agent, onChange }: AgentFormProps) => {
  const { mcpServers } = useSettings();

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
      <FormGroup>
        <Label htmlFor='agent-name'>Name</Label>
        <Input
          id='agent-name'
          required
          max={50}
          value={agent.name}
          onChange={e => handleChange('name', e.target.value)}
          placeholder='Agent name'
        />
      </FormGroup>

      <FormGroup>
        <Label htmlFor='agent-description'>Description</Label>
        <Input
          id='agent-description'
          value={agent.description}
          onChange={e => handleChange('description', e.target.value)}
          placeholder='Agent description'
        />
      </FormGroup>

      <FormGroup>
        <Label htmlFor='agent-system-prompt'>System Prompt</Label>
        <Textarea
          id='agent-system-prompt'
          value={agent.systemPrompt}
          onChange={e => handleChange('systemPrompt', e.target.value)}
          placeholder='System prompt that defines how the agent behaves'
          rows={8}
        />
      </FormGroup>

      <FormGroup>
        <Label>Atomic Data Access</Label>
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
      </FormGroup>
      <FormGroup>
        <Label>Tools</Label>
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
      </FormGroup>

      <FormGroup>
        <Label>Model</Label>
        <ModelSelect
          defaultModel={agent.model}
          onSelect={model => handleChange('model', model)}
          enforceToolSupport={enforceToolSupport}
        />
      </FormGroup>

      <FormGroup>
        <Label htmlFor='agent-temperature'>Temperature</Label>
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
      </FormGroup>
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
  &:hover {
    filter: brightness(0.95);
  }
`;

const AgentName = styled.h3`
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
`;

const AgentDescription = styled.p`
  font-size: 0.875rem;
  color: ${p => p.theme.colors.textLight};
  margin: ${p => p.theme.size(1)} 0 0;
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

const FormGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size(1)};
`;

const Label = styled.label`
  font-size: 0.875rem;
  font-weight: 600;
`;

const Input = styled.input`
  padding: ${p => p.theme.size(2)};
  border-radius: ${p => p.theme.radius};
  border: 1px solid ${p => p.theme.colors.bg2};
  background-color: ${p => p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
  font-size: 1rem;

  &:focus {
    outline: none;
    border-color: ${p => p.theme.colors.main};
  }
`;

const Textarea = styled.textarea`
  padding: ${p => p.theme.size(2)};
  border-radius: ${p => p.theme.radius};
  border: 1px solid ${p => p.theme.colors.bg2};
  background-color: ${p => p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
  font-size: 1rem;
  resize: vertical;
  min-height: 100px;

  &:focus {
    outline: none;
    border-color: ${p => p.theme.colors.main};
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
