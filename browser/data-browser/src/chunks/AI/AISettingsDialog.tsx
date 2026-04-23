import { useEffect, useEffectEvent } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  useDialog,
} from '@components/Dialog';
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
          <DialogTitle>
            <h1>AI Settings</h1>
          </DialogTitle>
          <DialogContent>
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
                />
              </Tabs.Panel>
              <Tabs.Panel value='skills'>
                <SkillsConfigTab />
              </Tabs.Panel>
              <Tabs.Panel value='mcp'>
                <MCPConfigTab />
              </Tabs.Panel>
            </Tabs>
          </DialogContent>
        </>
      )}
    </Dialog>
  );
};
