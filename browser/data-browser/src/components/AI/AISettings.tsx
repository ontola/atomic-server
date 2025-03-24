import * as React from 'react';
import { Column } from '../Row';
import { Checkbox, CheckboxLabel } from '../forms/Checkbox';
import { InputStyled, InputWrapper } from '../forms/InputStyles';
import { MCPServersManager } from '../MCPServersManager';
import styled from 'styled-components';
import { transition } from '../../helpers/transition';
import { useSettings } from '../../helpers/AppSettings';
import { useEffect, useState } from 'react';

interface CreditUsage {
  total: number;
  used: number;
}

const AISettings: React.FC = () => {
  const {
    enableAI,
    setEnableAI,
    openRouterApiKey,
    setOpenRouterApiKey,
    mcpServers,
    setMcpServers,
  } = useSettings();

  const [creditUsage, setCreditUsage] = useState<CreditUsage | undefined>();

  useEffect(() => {
    if (!openRouterApiKey) {
      return;
    }

    fetch('https://openrouter.ai/api/v1/credits', {
      headers: {
        Authorization: `Bearer ${openRouterApiKey}`,
      },
    })
      .then(res => res.json())
      .then(data => {
        setCreditUsage({
          total: data.data.total_credits,
          used: data.data.total_usage,
        });
      });
  }, [openRouterApiKey]);

  return (
    <>
      <Heading>AI</Heading>
      <CheckboxLabel>
        <Checkbox checked={enableAI} onChange={setEnableAI} /> Enable AI
        Features
      </CheckboxLabel>
      <ConditionalSettings enabled={enableAI} inert={!enableAI}>
        <label htmlFor='openrouter-api-key'>
          <Column gap='0.5rem'>
            OpenRouter API Key
            <InputWrapper>
              <InputStyled
                id='openrouter-api-key'
                type='password'
                value={openRouterApiKey || ''}
                onChange={e => setOpenRouterApiKey(e.target.value || undefined)}
                placeholder='Enter your OpenRouter API key'
              />
            </InputWrapper>
            {creditUsage && (
              <CreditUsage>
                Credits used: {creditUsage.used} / Total: {creditUsage.total}
              </CreditUsage>
            )}
          </Column>
        </label>
        <Heading>MCP Servers</Heading>
        <MCPServersManager servers={mcpServers} setServers={setMcpServers} />
      </ConditionalSettings>
    </>
  );
};

const Heading = styled.h3`
  font-size: 1em;
  margin: 0;
  margin-top: 1rem;
`;

const ConditionalSettings = styled(Column)<{ enabled: boolean }>`
  opacity: ${p => (p.enabled ? 1 : 0.3)};
  pointer-events: ${p => (p.enabled ? 'auto' : 'none')};
  touch-action: ${p => (p.enabled ? 'auto' : 'none')};
  ${transition('opacity')}
`;

const CreditUsage = styled.div`
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;

export default AISettings;
