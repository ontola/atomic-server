import { SettingsSection } from '@components/Settings';
import { Column } from '@components/Row';
import { AgentConfigTab, useAIAgentConfig } from './AgentConfig';
import { SkillsConfigTab } from './SkillsConfigTab';
import { MCPConfigTab } from './MCPConfigTab';

export default function AIConfigurationSections() {
  const { agents, defaultAgentId, setDefaultAgentId } = useAIAgentConfig();

  return (
    <Column gap='0'>
      <SettingsSection
        label='Agents'
        childSearchKeywords='agent default system prompt temperature context tools model'
      >
        <Column>
          <p>Choose the default agent for new chats.</p>
          <AgentConfigTab
            selectedAgent={
              agents.find(agent => agent.id === defaultAgentId) ?? agents[0]
            }
            onSelectAgent={agent => setDefaultAgentId(agent.id)}
          />
        </Column>
      </SettingsSection>
      <SettingsSection
        label='Skills'
        childSearchKeywords='skills content references'
      >
        <SkillsConfigTab />
      </SettingsSection>
      <SettingsSection
        label='MCP'
        childSearchKeywords='mcp server url transport headers'
      >
        <MCPConfigTab />
      </SettingsSection>
    </Column>
  );
}
