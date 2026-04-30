import { useEffect, useEffectEvent, useState } from 'react';
import { Dialog, useDialog } from '@components/Dialog';
import { Tabs } from '@components/Tabs';
import { AgentConfigTab } from './AgentConfig';
import { SkillsConfigTab } from './SkillsConfigTab';
import { MCPConfigTab } from './MCPConfigTab';
import { type AIAgent } from './types';

interface AISettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedAgent: AIAgent;
  onSelectAgent: (agent: AIAgent) => void;
}

export const AISettingsDialog = ({
  open,
  onOpenChange,
  selectedAgent,
  onSelectAgent,
}: AISettingsDialogProps) => {
  const [dialogProps, show, _close, isOpen] = useDialog({
    bindShow: onOpenChange,
  });
  const [hasActions, setHasActions] = useState(false);
  const [actionPortalElement, setActionPortalElement] =
    useState<HTMLDivElement | null>(null);

  const showEffect = useEffectEvent(show);

  useEffect(() => {
    if (open) {
      showEffect();
    }
  }, [open]);

  return (
    <Dialog {...dialogProps} width='600px'>
      {isOpen && (
        <>
          <Dialog.Title>
            <h1>AI Settings</h1>
          </Dialog.Title>
          <Dialog.Content>
            <Tabs
              label='AI Settings Tabs'
              tabs={[
                { label: 'Agents', value: 'agents' },
                { label: 'Skills', value: 'skills' },
                { label: 'MCP', value: 'mcp' },
              ]}
            >
              <Tabs.Panel value='agents'>
                <AgentConfigTab
                  selectedAgent={selectedAgent}
                  onSelectAgent={onSelectAgent}
                  actionPortalElement={actionPortalElement}
                  onActionsVisibleChange={setHasActions}
                />
              </Tabs.Panel>
              <Tabs.Panel value='skills'>
                <SkillsConfigTab
                  actionPortalElement={actionPortalElement}
                  onActionsVisibleChange={setHasActions}
                />
              </Tabs.Panel>
              <Tabs.Panel value='mcp'>
                <MCPConfigTab
                  actionPortalElement={actionPortalElement}
                  onActionsVisibleChange={setHasActions}
                />
              </Tabs.Panel>
            </Tabs>
          </Dialog.Content>
          {hasActions && (
            <Dialog.Actions>
              <div
                ref={setActionPortalElement}
                style={{ display: 'contents' }}
              />
            </Dialog.Actions>
          )}
        </>
      )}
    </Dialog>
  );
};
