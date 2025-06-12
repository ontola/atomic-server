import * as React from 'react';
import { Column, Row } from '@components/Row';
import { Checkbox, CheckboxLabel } from '@components/forms/Checkbox';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import { MCPServersManager } from './MCP/MCPServersManager';
import styled, { useTheme } from 'styled-components';
import { transition } from '@helpers/transition';
import { Suspense, useEffect, useState } from 'react';
import { OpenRouterLoginButton } from './OpenRouterLoginButton';
import { effectFetch } from '@helpers/effectFetch';
import { CheckboxDescriptor } from '@components/forms/CheckboxDescriptor';
import { useAISettings } from './AISettingsContext';
import { AIProvider } from './aiContstants';
import { useIsOllamaUrlValid } from './useIsOllamaUrlValid';
import { FaCheck, FaTriangleExclamation } from 'react-icons/fa6';
import { Details } from '@components/Details';
import {
  SettingsSection,
  SettingsContent,
  SettingsSectionWrapper,
  SettingsLabel,
  useSettingsSearch,
  SettingsSearchProvider,
  queryMatches,
} from '@components/Settings';

const ModelSelect = React.lazy(
  () => import('@chunks/AI/ModelSelect/ModelSelect'),
);

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

// Keywords for the AI section's own content (enable toggle, token usage)
const AI_OWN_KEYWORDS = 'ai token usage';
// Keywords from child sections — makes this section visible, but children still filter
const AI_CHILD_KEYWORDS =
  'openrouter ollama mcp server generative model chat provider api key local';

const AISettings: React.FC = () => {
  const theme = useTheme();
  const { query: searchQuery } = useSettingsSearch();
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
    showFollowUpPrompts,
    setShowFollowUpPrompts,
    isProviderEnabled,
    setIsProviderEnabled,
    shouldGenerateTitles,
    setShouldGenerateTitles,
    genFeaturesModel,
    setGenFeaturesModel,
  } = useAISettings();

  const [creditUsage, setCreditUsage] = useState<CreditUsage | undefined>();

  const isOllamaUrlValid = useIsOllamaUrlValid(
    isProviderEnabled(AIProvider.Ollama),
    ollamaUrl,
  );

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

  const { parentMatched } = useSettingsSearch();
  const isSearching = searchQuery.length > 0;

  const ownMatch =
    isSearching && queryMatches(searchQuery, `ai ${AI_OWN_KEYWORDS}`);
  const childMatch =
    isSearching &&
    !ownMatch &&
    queryMatches(searchQuery, `ai ${AI_CHILD_KEYWORDS}`);

  // Only propagate parentMatched when this section's own content matched,
  // not when a child keyword matched (let children filter themselves).
  const childContext = React.useMemo(
    () => ({
      query: searchQuery,
      parentMatched: parentMatched || ownMatch,
    }),
    [searchQuery, parentMatched, ownMatch],
  );

  if (isSearching && !ownMatch && !childMatch && !parentMatched) {
    return null;
  }

  return (
    <SettingsSectionWrapper>
      <Details
        noIndent
        title={<SettingsLabel>AI</SettingsLabel>}
        open={isSearching}
        initialState={isSearching}
      >
        <SettingsContent>
          <SettingsSearchProvider value={childContext}>
            <Column gap='0.75rem'>
              <CheckboxLabel>
                <Checkbox checked={enableAI} onChange={setEnableAI} /> Enable AI
                Features
              </CheckboxLabel>
              <ConditionalSettings enabled={enableAI} inert={!enableAI}>
                <CheckboxLabel>
                  <Checkbox
                    checked={showTokenUsage}
                    onChange={setShowTokenUsage}
                  />
                  Show token usage in chats
                </CheckboxLabel>

                <SubGroup>
                  <SettingsSection label='OpenRouter'>
                    <Column gap='0.5rem'>
                      <CheckboxLabel>
                        <Checkbox
                          checked={isProviderEnabled(AIProvider.OpenRouter)}
                          onChange={checked => {
                            setIsProviderEnabled(
                              AIProvider.OpenRouter,
                              checked,
                            );
                          }}
                        />
                        Enable OpenRouter
                      </CheckboxLabel>
                      <ConditionalSettings
                        fullWidth
                        gap='0.5rem'
                        enabled={isProviderEnabled(AIProvider.OpenRouter)}
                      >
                        <label htmlFor='openrouter-api-key'>
                          OpenRouter API Key
                        </label>
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
                          <Subtle>
                            Credits used: {intl.format(creditUsage.used)} /{' '}
                            {intl.format(creditUsage.total)}
                          </Subtle>
                        )}
                        {!openRouterApiKey && (
                          <Subtle>
                            OpenRouter provides a unified API that gives you
                            access to hundreds of AI models from all major
                            vendors, while automatically handling fallbacks and
                            selecting the most cost-effective options.
                          </Subtle>
                        )}
                      </ConditionalSettings>
                    </Column>
                  </SettingsSection>

                  <SettingsSection label='Ollama'>
                    <Column gap='0.5rem'>
                      <CheckboxDescriptor
                        label='Enable Ollama'
                        description={
                          <>
                            Host your own AI models locally using{' '}
                            <a
                              href='https://ollama.com/'
                              target='_blank'
                              rel='noreferrer'
                            >
                              Ollama
                            </a>
                          </>
                        }
                      >
                        {id => (
                          <Checkbox
                            id={id}
                            checked={isProviderEnabled(AIProvider.Ollama)}
                            onChange={checked =>
                              setIsProviderEnabled(AIProvider.Ollama, checked)
                            }
                          />
                        )}
                      </CheckboxDescriptor>
                      <ConditionalSettings
                        fullWidth
                        gap='0.5rem'
                        enabled={isProviderEnabled(AIProvider.Ollama)}
                      >
                        <Row center gap='1ch'>
                          {isOllamaUrlValid ? (
                            <FaCheck
                              title='Server found'
                              color={theme.colors.main}
                            />
                          ) : (
                            <FaTriangleExclamation
                              title='Server not responding'
                              color={theme.colors.warning}
                            />
                          )}
                          <label htmlFor='ollama-url'>Ollama API Url</label>
                        </Row>
                        <InputWrapper>
                          <InputStyled
                            id='ollama-url'
                            value={ollamaUrl || ''}
                            onChange={e =>
                              setOllamaUrl(e.target.value || undefined)
                            }
                            type='url'
                            placeholder='http://localhost:11434'
                          />
                        </InputWrapper>
                      </ConditionalSettings>
                    </Column>
                  </SettingsSection>

                  <SettingsSection label='Generative Features'>
                    <Column gap='0.5rem'>
                      <CheckboxLabel>
                        <Checkbox
                          checked={shouldGenerateTitles}
                          onChange={setShouldGenerateTitles}
                        />
                        Generate AI Chat titles
                      </CheckboxLabel>
                      <CheckboxDescriptor
                        label='Show follow up prompts in chats'
                        description='Uses a small model to generate a follow up prompt based on the last message in the chat.'
                      >
                        {id => (
                          <Checkbox
                            id={id}
                            checked={showFollowUpPrompts}
                            onChange={setShowFollowUpPrompts}
                          />
                        )}
                      </CheckboxDescriptor>
                      <Details title='Change what model is used for generative features'>
                        <Suspense>
                          <Subtle>(Tip) Choose a cheap and fast model</Subtle>
                          <ModelSelect
                            defaultModel={genFeaturesModel}
                            onSelect={setGenFeaturesModel}
                          />
                        </Suspense>
                      </Details>
                    </Column>
                  </SettingsSection>

                  <SettingsSection label='MCP Servers'>
                    <MCPServersManager
                      servers={mcpServers}
                      setServers={setMcpServers}
                    />
                  </SettingsSection>
                </SubGroup>
              </ConditionalSettings>
            </Column>
          </SettingsSearchProvider>
        </SettingsContent>
      </Details>
    </SettingsSectionWrapper>
  );
};

const ConditionalSettings = styled(Column)<{ enabled: boolean }>`
  opacity: ${p => (p.enabled ? 1 : 0.3)};
  pointer-events: ${p => (p.enabled ? 'auto' : 'none')};
  touch-action: ${p => (p.enabled ? 'auto' : 'none')};
  ${transition('opacity')}
`;

const SubGroup = styled.div`
  border-top: 1px solid ${p => p.theme.colors.bg2};
  margin-top: 0.25rem;

  button[aria-label='collapse'],
  button[aria-label='expand'] {
    height: 1.5em;
    background: transparent !important;
    box-shadow: none !important;
  }
`;

const Subtle = styled.p`
  font-size: 0.8rem;
  margin: 0;
  color: ${p => p.theme.colors.textLight};
`;

export default AISettings;
