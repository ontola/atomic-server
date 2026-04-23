import * as React from 'react';
import { Column, Row } from '@components/Row';
import { Checkbox, CheckboxLabel } from '@components/forms/Checkbox';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import styled, { useTheme } from 'styled-components';
import { transition } from '@helpers/transition';
import { Suspense, useEffect, useState } from 'react';
import { OpenRouterLoginButton } from './OpenRouterLoginButton';
import { effectFetch } from '@helpers/effectFetch';
import { CheckboxDescriptor } from '@components/forms/CheckboxDescriptor';
import { OutlinedSection } from '@components/OutlinedSection';
import { useAISettings } from './AISettingsContext';
import { AIProvider } from './aiContstants';
import { useIsOllamaUrlValid } from './useIsOllamaUrlValid';
import { FaCheck, FaTriangleExclamation } from 'react-icons/fa6';
import { Details } from '@components/Details';

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
        <Heading as='h3'>AI Providers</Heading>
        <OutlinedSection title='OpenRouter'>
          <CheckboxLabel>
            <Checkbox
              checked={isProviderEnabled(AIProvider.OpenRouter)}
              onChange={checked => {
                setIsProviderEnabled(AIProvider.OpenRouter, checked);
              }}
            />
            Enable OpenRouter
          </CheckboxLabel>
          <ConditionalSettings
            fullWidth
            gap='0.5rem'
            enabled={isProviderEnabled(AIProvider.OpenRouter)}
          >
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
          </ConditionalSettings>
        </OutlinedSection>
        <OutlinedSection title='Ollama'>
          <CheckboxDescriptor
            label='Enable Ollama'
            description={
              <>
                Host your own AI models locally using{' '}
                <a href='https://ollama.com/' target='_blank' rel='noreferrer'>
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
            gap='1rem'
            enabled={isProviderEnabled(AIProvider.Ollama)}
          >
            <Column gap='0.5rem'>
              <Row center gap='1ch'>
                {isOllamaUrlValid ? (
                  <FaCheck title='Server found' color={theme.colors.main} />
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
                  onChange={e => setOllamaUrl(e.target.value || undefined)}
                  type='url'
                  placeholder='http://localhost:11434'
                />
              </InputWrapper>
            </Column>
          </ConditionalSettings>
        </OutlinedSection>
        <Heading as='h3'>Generative Features</Heading>
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
  ${transition('opacity')}
`;

const Subtle = styled.div`
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;

export default AISettings;
