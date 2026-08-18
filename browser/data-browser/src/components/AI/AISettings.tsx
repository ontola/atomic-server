import * as React from 'react';
import { Column, Row } from '@components/Row';
import { Checkbox, CheckboxLabel } from '@components/forms/Checkbox';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import styled from 'styled-components';
import { Suspense, useEffect, useState } from 'react';
import { OpenRouterLoginButton } from './OpenRouterLoginButton';
import { effectFetch } from '@helpers/effectFetch';
import { CheckboxDescriptor } from '@components/forms/CheckboxDescriptor';
import { transition } from '@helpers/transition';
import { useAISettings } from './AISettingsContext';
import { Details } from '@components/Details';
import {
  SettingsContent,
  SettingsSectionWrapper,
  SettingsLabel,
  useSettingsSearch,
  SettingsSearchProvider,
  queryMatches,
} from '@components/Settings';
import { WarningBlock } from '@components/WarningBlock';
import {
  AI_ENDPOINT_PRESETS,
  matchPreset,
  OPENROUTER_BASE_URL,
} from '@chunks/AI/aiEndpoint';
import { useAIModels } from '@chunks/AI/useAIModels';
import { ProviderStatus } from './ProviderStatus';

const ModelSelect = React.lazy(
  () => import('@chunks/AI/ModelSelect/ModelSelect'),
);

const intl = new Intl.NumberFormat('default', {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'narrowSymbol',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

interface CreditUsage {
  total: number;
  used: number;
}

const CREDITS_ENDPOINT = 'https://openrouter.ai/api/v1/credits';

const AI_OWN_KEYWORDS = 'ai token usage';
const AI_CHILD_KEYWORDS =
  'openrouter ollama openai orcarouter groq litellm endpoint model chat provider api key local gateway';

const AISettings: React.FC = () => {
  const { query: searchQuery } = useSettingsSearch();
  const {
    enableAI,
    setEnableAI,
    aiBaseUrl,
    setAiBaseUrl,
    aiApiKey,
    setAiApiKey,
    showTokenUsage,
    setShowTokenUsage,
    showFollowUpPrompts,
    setShowFollowUpPrompts,
    isAIAvailable,
    shouldGenerateTitles,
    setShouldGenerateTitles,
    genFeaturesModel,
    setGenFeaturesModel,
  } = useAISettings();
  const { configured, reachable, checking } = useAIModels();

  const [creditUsage, setCreditUsage] = useState<CreditUsage | undefined>();
  const preset = matchPreset(aiBaseUrl);
  const isOpenRouter = aiBaseUrl
    ? matchPreset(aiBaseUrl)?.id === 'openrouter' ||
      aiBaseUrl.replace(/\/+$/, '') === OPENROUTER_BASE_URL
    : false;

  const handleSetApiKey = (key: string | undefined) => {
    if (!key) {
      setCreditUsage(undefined);
    }

    setAiApiKey(key);
  };

  useEffect(() => {
    if (!isOpenRouter || !aiApiKey) {
      setCreditUsage(undefined);

      return;
    }

    return effectFetch(CREDITS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${aiApiKey}`,
      },
    })(data => {
      setCreditUsage({
        total: data.data.total_credits,
        used: data.data.total_usage,
      });
    });
  }, [isOpenRouter, aiApiKey]);

  const { parentMatched } = useSettingsSearch();
  const isSearching = searchQuery.length > 0;

  const ownMatch =
    isSearching && queryMatches(searchQuery, `ai ${AI_OWN_KEYWORDS}`);
  const childMatch =
    isSearching &&
    !ownMatch &&
    queryMatches(searchQuery, `ai ${AI_CHILD_KEYWORDS}`);

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
                  <SubSection>
                    <SubSectionTitle>Model endpoint</SubSectionTitle>
                    <Column gap='0.5rem'>
                      <Subtle>
                        Any OpenAI-compatible API: OpenRouter, Ollama, Groq,
                        OrcaRouter, LiteLLM, LM Studio, etc. Pick a preset or
                        paste a base URL (usually ending in <code>/v1</code>).
                      </Subtle>
                      <ProviderStatus
                        connected={reachable}
                        configured={configured}
                        checking={checking}
                      />
                      <PresetRow>
                        {AI_ENDPOINT_PRESETS.map(p => (
                          <PresetButton
                            key={p.id}
                            type='button'
                            $active={preset?.id === p.id}
                            onClick={() => setAiBaseUrl(p.baseUrl)}
                          >
                            {p.label}
                          </PresetButton>
                        ))}
                      </PresetRow>
                      <label htmlFor='ai-endpoint-base-url'>Base URL</label>
                      <InputWrapper>
                        <InputStyled
                          id='ai-endpoint-base-url'
                          type='url'
                          value={aiBaseUrl || ''}
                          onChange={e =>
                            setAiBaseUrl(e.target.value || undefined)
                          }
                          placeholder='https://openrouter.ai/api/v1'
                        />
                      </InputWrapper>
                      <label htmlFor='ai-endpoint-api-key'>API Key</label>
                      <Row center>
                        {isOpenRouter && !aiApiKey && (
                          <>
                            <OpenRouterLoginButton />
                            or
                          </>
                        )}
                        <InputWrapper>
                          <InputStyled
                            id='ai-endpoint-api-key'
                            type='password'
                            value={aiApiKey || ''}
                            onChange={e =>
                              handleSetApiKey(e.target.value || undefined)
                            }
                            placeholder={
                              preset?.apiKeyPlaceholder ??
                              (preset && !preset.requiresApiKey
                                ? 'Optional'
                                : 'sk-...')
                            }
                          />
                        </InputWrapper>
                      </Row>
                      {creditUsage && (
                        <Subtle>
                          Credits used: {intl.format(creditUsage.used)} /{' '}
                          {intl.format(creditUsage.total)}
                        </Subtle>
                      )}
                    </Column>
                  </SubSection>

                  <SubSection>
                    <SubSectionTitle>Generative features</SubSectionTitle>
                    {!isAIAvailable && (
                      <WarningBlock>
                        <WarningBlock.Title>
                          Configure a model endpoint above to use generative
                          features.
                        </WarningBlock.Title>
                      </WarningBlock>
                    )}
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
                  </SubSection>
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
  padding-top: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;

  button[aria-label='collapse'],
  button[aria-label='expand'] {
    height: 1.5em;
    background: transparent !important;
    box-shadow: none !important;
  }
`;

const SubSection = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid ${p => p.theme.colors.bg2};

  &:last-child {
    border-bottom: 0;
    padding-bottom: 0;
  }
`;

const SubSectionTitle = styled.h3`
  margin: 0;
  font-size: 0.95rem;
  font-weight: 650;
  color: ${p => p.theme.colors.text};
`;

const Subtle = styled.p`
  font-size: 0.8rem;
  margin: 0;
  color: ${p => p.theme.colors.textLight};
`;

const PresetRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
`;

const PresetButton = styled.button<{ $active: boolean }>`
  appearance: none;
  border: 1px solid
    ${p => (p.$active ? p.theme.colors.main : p.theme.colors.bg2)};
  background: ${p => (p.$active ? p.theme.colors.main : p.theme.colors.bg)};
  color: ${p => (p.$active ? p.theme.colors.bg : p.theme.colors.text)};
  border-radius: ${p => p.theme.radius};
  padding: 0.25rem 0.6rem;
  font-size: 0.8rem;
  cursor: pointer;
  ${transition('background-color', 'border-color', 'color')}

  &:hover {
    border-color: ${p => p.theme.colors.main};
  }
`;

export default AISettings;
