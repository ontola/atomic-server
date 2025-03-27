import * as React from 'react';
import { Column, Row } from '../Row';
import { Checkbox, CheckboxLabel } from '../forms/Checkbox';
import { InputStyled, InputWrapper } from '../forms/InputStyles';
import { MCPServersManager } from '../MCPServersManager';
import styled from 'styled-components';
import { transition } from '../../helpers/transition';
import { useSettings } from '../../helpers/AppSettings';
import { useEffect, useState } from 'react';
import { OpenRouterLoginButton } from './OpenRouterLoginButton';

interface CreditUsage {
  total: number;
  used: number;
}

const CREDITS_ENDPOINT = 'https://openrouter.ai/api/v1/credits';

const AISettings: React.FC = () => {
  const {
    enableAI,
    setEnableAI,
    openRouterApiKey,
    setOpenRouterApiKey,
    mcpServers,
    setMcpServers,
    showTokenUsage,
    setShowTokenUsage,
  } = useSettings();

  const [creditUsage, setCreditUsage] = useState<CreditUsage | undefined>();

  useEffect(() => {
    if (!openRouterApiKey) {
      setCreditUsage(undefined);

      return;
    }

    fetch(CREDITS_ENDPOINT, {
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
            <Row center>
              {!openRouterApiKey && (
                <>
                  <OpenRouterLoginButton />
                  or
                </>
              )}
              <InputWrapper>
                <InputStyled
                  id='openrouter-api-key'
                  type='password'
                  value={openRouterApiKey || ''}
                  onChange={e =>
                    setOpenRouterApiKey(e.target.value || undefined)
                  }
                  placeholder='Enter your OpenRouter API key'
                />
              </InputWrapper>
            </Row>
            {creditUsage && (
              <CreditUsage>
                Credits used: {creditUsage.used} / Total: {creditUsage.total}
              </CreditUsage>
            )}
            {!openRouterApiKey && (
              <CreditUsage>
                <p>
                  OpenRouter provides a unified API that gives you access to
                  hundreds of AI models from all major vendors, while
                  automatically handling fallbacks and selecting the most
                  cost-effective options.
                </p>
              </CreditUsage>
            )}
          </Column>
        </label>
        <CheckboxLabel>
          <Checkbox checked={showTokenUsage} onChange={setShowTokenUsage} />
          Show token usage in chats
        </CheckboxLabel>
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
