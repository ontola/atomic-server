import * as React from 'react';
import { Column, Row } from '@components/Row';
import { Checkbox, CheckboxLabel } from '@components/forms/Checkbox';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import styled, { useTheme } from 'styled-components';
import { Suspense, useEffect, useState } from 'react';
import { OpenRouterLoginButton } from './OpenRouterLoginButton';
import { effectFetch } from '@helpers/effectFetch';
import { CheckboxDescriptor } from '@components/forms/CheckboxDescriptor';
import { OutlinedSection } from '@components/OutlinedSection';
import { useAISettings } from './AISettingsContext';
import { useIsOllamaUrlValid } from './useIsOllamaUrlValid';
import { ProviderStatus, Subtle } from './ProviderStatus';
import { Details } from '@components/Details';
import { WarningBlock } from '@components/WarningBlock';
import { FaCheck, FaTriangleExclamation } from 'react-icons/fa6';

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

const AISettings: React.FC = () => {
  const theme = useTheme();
  const {
    enableAI,
    setEnableAI,
    openRouterApiKey,
    setOpenRouterApiKey,
    showTokenUsage,
    setShowTokenUsage,
    ollamaUrl,
    setOllamaUrl,
    showFollowUpPrompts,
    setShowFollowUpPrompts,
    openRouterAvailable,
    ollamaAvailable,
    isProviderAvailable,
    defaultChatModel,
    setDefaultChatModel,
    shouldGenerateTitles,
    setShouldGenerateTitles,
    genFeaturesModel,
    setGenFeaturesModel,
  } = useAISettings();

  const [creditUsage, setCreditUsage] = useState<CreditUsage | undefined>();

  const isOllamaUrlValid = useIsOllamaUrlValid(ollamaUrl);

  useEffect(() => {
    if (!openRouterApiKey) {
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

  const handleSetOpenRouterKey = (key: string | undefined) => {
    if (!key) {
      setCreditUsage(undefined);
    }

    setOpenRouterApiKey(key);
  };

  const genFeaturesUnavailable = !isProviderAvailable(
    genFeaturesModel.provider,
  );
  const defaultModelUnavailable = !isProviderAvailable(
    defaultChatModel.provider,
  );

  return (
    <>
      <Heading>AI</Heading>
      <CheckboxLabel>
        <Checkbox checked={enableAI} onChange={setEnableAI} /> Enable AI
        Features
      </CheckboxLabel>
      <ConditionalSettings enabled={enableAI} inert={!enableAI}>
        <CheckboxLabel>
          <Checkbox checked={showTokenUsage} onChange={setShowTokenUsage} />
          Show token usage in chats
        </CheckboxLabel>
        <Heading as='h3'>Default chat model</Heading>
        <Subtle as='p'>
          Pre-selected when creating new agents. Does not override models you
          have already set per agent.
        </Subtle>
        {defaultModelUnavailable && (
          <WarningBlock>
            <WarningBlock.Title>
              The selected default model&apos;s provider is not available.
              Choose a model from a connected provider below.
            </WarningBlock.Title>
          </WarningBlock>
        )}
        <Suspense>
          <ModelSelect
            defaultModel={defaultChatModel}
            onSelect={setDefaultChatModel}
            enforceToolSupport
          />
        </Suspense>
        <Heading as='h3'>AI Providers</Heading>
        <OutlinedSection title='OpenRouter'>
          <ProviderStatus
            connected={openRouterAvailable}
            configured={Boolean(openRouterApiKey)}
          />
          <Column fullWidth gap='0.5rem'>
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
                    handleSetOpenRouterKey(e.target.value || undefined)
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
        </OutlinedSection>
        <OutlinedSection title='Ollama'>
          <ProviderStatus
            connected={ollamaAvailable}
            configured={Boolean(ollamaUrl)}
            checking={Boolean(ollamaUrl) && !isOllamaUrlValid}
          />
          <Column gap='0.5rem'>
            <Row center gap='1ch'>
              {ollamaUrl && isOllamaUrlValid ? (
                <FaCheck title='Server found' color={theme.colors.main} />
              ) : ollamaUrl ? (
                <FaTriangleExclamation
                  title='Server not responding'
                  color={theme.colors.warning}
                />
              ) : null}
              <label htmlFor='ollama-url'>Ollama API Url</label>
            </Row>
            <Subtle as='p'>
              Host your own AI models locally using{' '}
              <a href='https://ollama.com/' target='_blank' rel='noreferrer'>
                Ollama
              </a>
              . A provider is available when the server responds at this URL.
            </Subtle>
            <InputWrapper>
              <InputStyled
                id='ollama-url'
                value={ollamaUrl || ''}
                onChange={e => setOllamaUrl(e.target.value || undefined)}
                type='url'
                placeholder='http://localhost:11434'
              />
            </InputWrapper>
          </Column>
        </OutlinedSection>
        <Heading as='h3'>Generative Features</Heading>
        {genFeaturesUnavailable && (
          <WarningBlock>
            <WarningBlock.Title>
              The generative features model uses a provider that is not
              available.
            </WarningBlock.Title>
          </WarningBlock>
        )}
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
            <p>(Tip) Choose a cheap and fast model</p>
            <ModelSelect
              defaultModel={genFeaturesModel}
              onSelect={setGenFeaturesModel}
            />
          </Suspense>
        </Details>
      </ConditionalSettings>
    </>
  );
};

const Heading = styled.h2`
  font-size: 1em;
  margin: 0;
  margin-top: 1rem;
`;

const ConditionalSettings = styled(Column)<{ enabled: boolean }>`
  opacity: ${p => (p.enabled ? 1 : 0.3)};
  pointer-events: ${p => (p.enabled ? 'auto' : 'none')};
  touch-action: ${p => (p.enabled ? 'auto' : 'none')};
`;

export default AISettings;
