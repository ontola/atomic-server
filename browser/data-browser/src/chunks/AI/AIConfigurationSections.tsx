import { useState, type ReactNode } from 'react';
import { SettingsSection } from '@components/Settings';
import { Column } from '@components/Row';
import { AgentConfigTab, useAIAgentConfig } from './AgentConfig';
import { SkillsConfigTab } from './SkillsConfigTab';
import { MCPConfigTab } from './MCPConfigTab';

interface EditorProps {
  actionPortalElement: HTMLElement | null;
  onActionsVisibleChange: (visible: boolean) => void;
}

function EditorSection({
  label,
  children,
  keywords,
}: {
  label: string;
  keywords?: string;
  children: (props: EditorProps) => ReactNode;
}) {
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState(false);

  return (
    <SettingsSection label={label} childSearchKeywords={keywords}>
      <Column>
        {children({
          actionPortalElement: actions,
          onActionsVisibleChange: setEditing,
        })}
        <div ref={setActions} hidden={!editing} />
      </Column>
    </SettingsSection>
  );
}

export default function AIConfigurationSections() {
  const { agents, defaultAgentId, setDefaultAgentId } = useAIAgentConfig();

  return (
    <Column gap='0'>
      <EditorSection
        label='Agents'
        keywords='agent default system prompt temperature context tools model'
      >
        {props => (
          <Column>
            <p>Choose the default agent for new chats.</p>
            <AgentConfigTab
              {...props}
              selectedAgent={
                agents.find(agent => agent.id === defaultAgentId) ?? agents[0]
              }
              onSelectAgent={agent => setDefaultAgentId(agent.id)}
            />
          </Column>
        )}
      </EditorSection>
      <EditorSection label='Skills' keywords='skills content references'>
        {props => <SkillsConfigTab {...props} />}
      </EditorSection>
      <EditorSection label='MCP' keywords='mcp server url transport headers'>
        {props => <MCPConfigTab {...props} />}
      </EditorSection>
    </Column>
  );
}
