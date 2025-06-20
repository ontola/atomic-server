import * as React from 'react';
import { Column, Row } from '../Row';
import { Checkbox, CheckboxLabel } from '../forms/Checkbox';
import { InputStyled, InputWrapper } from '../forms/InputStyles';
import { MCPServersManager } from './MCP/MCPServersManager';
import styled from 'styled-components';
import { transition } from '../../helpers/transition';
import { useSettings } from '../../helpers/AppSettings';
import { useEffect, useState } from 'react';
import { OpenRouterLoginButton } from './OpenRouterLoginButton';
import { TabPanel, Tabs } from '../Tabs';
import { effectFetch } from '../../helpers/effectFetch';

const intl = new Intl.NumberFormat('default', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

interface CreditUsage {
  total: number;
  used: number;
}

const CREDITS_ENDPOINT = 'https://openrouter.ai/api/v1/credits';

const PROVIDER_TABS = [
  {
    label: 'OpenRouter',
    value: 'openrouter',
  },
  {
    label: 'Ollama',
    value: 'ollama',
  },
];

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
    ollamaUrl,
    setOllamaUrl,
  } = useSettings();

  const [creditUsage, setCreditUsage] = useState<CreditUsage | undefined>();

  useEffect(() => {
    if (!openRouterApiKey) {
      setCreditUsage(undefined);

      return;
    }

    return effectFetch(CREDITS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${openRouterApiKey}`,
      },
    })(data => {
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
        <Heading>AI Provider</Heading>
        <TabWrapper>
          <Tabs tabs={PROVIDER_TABS} label='AI Provider' rounded>
            <StyledTabPanel value='openrouter'>
              <Column gap='0.5rem'>
                <label htmlFor='openrouter-api-key'>OpenRouter API Key</label>
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
                  <Subtle as='p'>
                    Credits used: {intl.format(creditUsage.used)} /{' '}
                    {intl.format(creditUsage.total)}
                  </Subtle>
                )}
                {!openRouterApiKey && (
                  <Subtle as='p'>
                    OpenRouter provides a unified API that gives you access to
                    hundreds of AI models from all major vendors, while
                    automatically handling fallbacks and selecting the most
                    cost-effective options.
                  </Subtle>
                )}
              </Column>
            </StyledTabPanel>
            <StyledTabPanel value='ollama'>
              <Column gap='0.5rem'>
                <label htmlFor='ollama-url'>Ollama API Url</label>
                <InputWrapper>
                  <InputStyled
                    id='ollama-url'
                    value={ollamaUrl || ''}
                    onChange={e => setOllamaUrl(e.target.value || undefined)}
                    type='url'
                    placeholder='http://localhost:11434/api'
                  />
                </InputWrapper>
                <Subtle as='p'>
                  Host your own AI models locally using{' '}
                  <a
                    href='https://ollama.com/'
                    target='_blank'
                    rel='noreferrer'
                  >
                    Ollama
                  </a>
                  .
                </Subtle>
              </Column>
            </StyledTabPanel>
          </Tabs>
        </TabWrapper>
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

const Subtle = styled.div`
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;

const TabWrapper = styled.div`
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
`;

const StyledTabPanel = styled(TabPanel)`
  padding: ${p => p.theme.size()};
  padding-top: 0;

  ${InputWrapper}:has(input:user-invalid) {
    border-color: ${p => p.theme.colors.alert};
  }
`;

export default AISettings;
