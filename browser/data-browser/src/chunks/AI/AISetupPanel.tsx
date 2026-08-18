import React, { Suspense, useEffect, useState } from 'react';
import styled from 'styled-components';
import { Column, Row } from '@components/Row';
import { useAISettings } from '@components/AI/AISettingsContext';
import { OpenRouterLoginButton } from '@components/AI/OpenRouterLoginButton';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import { OutlinedSection } from '@components/OutlinedSection';
import { ProviderStatus } from '@components/AI/ProviderStatus';
import { Button } from '@components/Button';
import type { AIModelIdentifier } from './types';
import { useLocalStorage } from '@hooks/useLocalStorage';
import { useAIAgentConfig } from './AgentConfig';
import {
  AI_ENDPOINT_PRESETS,
  matchPreset,
  OPENROUTER_BASE_URL,
} from './aiEndpoint';
import { useAIModels } from './useAIModels';

const ModelSelect = React.lazy(
  () => import('@chunks/AI/ModelSelect/ModelSelect'),
);

type SetupStep = 'endpoint' | 'model';

const getInitialStep = (configured: boolean): SetupStep => {
  if (sessionStorage.getItem('atomic.ai.openSetup') === 'true' && configured) {
    return 'model';
  }

  return 'endpoint';
};

export const AISetupPanel: React.FC = () => {
  const {
    aiBaseUrl,
    setAiBaseUrl,
    aiApiKey,
    setAiApiKey,
    defaultChatModel,
    setDefaultChatModel,
    isAIAvailable,
    setGenFeaturesModel,
  } = useAISettings();
  const { agents, saveAgents } = useAIAgentConfig();
  const { models, configured, reachable, checking } = useAIModels();

  const [setupComplete, setSetupComplete] = useLocalStorage(
    'atomic.ai.setupComplete',
    false,
  );

  const [step, setStep] = useState<SetupStep>(() =>
    getInitialStep(isAIAvailable),
  );
  const [pendingModel, setPendingModel] =
    useState<AIModelIdentifier>(defaultChatModel);
  const [syncGenFeatures, setSyncGenFeatures] = useState(false);

  const preset = matchPreset(aiBaseUrl);
  const isOpenRouter =
    preset?.id === 'openrouter' ||
    aiBaseUrl?.replace(/\/+$/, '') === OPENROUTER_BASE_URL;

  useEffect(() => {
    if (step !== 'model' || models.length === 0) {
      return;
    }

    setPendingModel(prev => {
      if (models.some(m => m.id === prev.id)) {
        return prev;
      }

      return { id: models[0].id };
    });
  }, [step, models]);

  if (setupComplete) {
    return null;
  }

  const handleContinue = () => {
    setStep('model');
    sessionStorage.removeItem('atomic.ai.openSetup');
  };

  const handleBack = () => {
    setStep('endpoint');
  };

  const handleStartChatting = () => {
    setDefaultChatModel(pendingModel);
    saveAgents(agents);

    if (syncGenFeatures) {
      setGenFeaturesModel(pendingModel);
    }

    setSetupComplete(true);
    sessionStorage.removeItem('atomic.ai.openSetup');
  };

  if (step === 'model') {
    return (
      <Overlay>
        <Panel>
          <Title>Choose a default model</Title>
          <Subtle>
            This pre-selects a model for built-in agents and new custom agents.
            You can change each agent&apos;s model individually later.
          </Subtle>
          <Suspense>
            <ModelSelect
              defaultModel={pendingModel}
              onSelect={setPendingModel}
            />
          </Suspense>
          <CheckboxRow>
            <input
              type='checkbox'
              id='sync-gen-features'
              checked={syncGenFeatures}
              onChange={e => setSyncGenFeatures(e.target.checked)}
            />
            <label htmlFor='sync-gen-features'>
              Also use for chat titles and follow-up prompts
            </label>
          </CheckboxRow>
          <ActionsRow>
            <Button subtle onClick={handleBack}>
              Back
            </Button>
            <Button onClick={handleStartChatting} disabled={!isAIAvailable}>
              Start chatting
            </Button>
          </ActionsRow>
        </Panel>
      </Overlay>
    );
  }

  return (
    <Overlay>
      <Panel>
        <Title>Connect a model to use Atomic Assistant</Title>
        <Subtle>
          Point at any OpenAI-compatible endpoint (OpenRouter, Ollama, Groq,
          OrcaRouter, …). You need a base URL before you can continue.
        </Subtle>
        <OutlinedSection title='Model endpoint'>
          <ProviderSection>
            <ProviderStatus
              connected={reachable}
              configured={configured}
              checking={checking}
            />
            <PresetRow>
              {AI_ENDPOINT_PRESETS.map(p => (
                <PresetChip
                  key={p.id}
                  type='button'
                  $active={preset?.id === p.id}
                  onClick={() => setAiBaseUrl(p.baseUrl)}
                >
                  {p.label}
                </PresetChip>
              ))}
            </PresetRow>
            <FullWidthField>
              <InputStyled
                type='url'
                value={aiBaseUrl || ''}
                onChange={e => setAiBaseUrl(e.target.value || undefined)}
                placeholder='https://openrouter.ai/api/v1'
                aria-label='Model endpoint base URL'
              />
            </FullWidthField>
            <CredentialsRow>
              {isOpenRouter && !aiApiKey && (
                <OpenRouterLoginGroup>
                  <OpenRouterLoginButton />
                  <OrText>or</OrText>
                </OpenRouterLoginGroup>
              )}
              <ApiKeyField>
                <InputStyled
                  type='password'
                  value={aiApiKey || ''}
                  onChange={e => setAiApiKey(e.target.value || undefined)}
                  placeholder={
                    preset?.apiKeyPlaceholder ??
                    (preset && !preset.requiresApiKey ? 'Optional' : 'API key')
                  }
                  aria-label='Model endpoint API key'
                />
              </ApiKeyField>
            </CredentialsRow>
          </ProviderSection>
        </OutlinedSection>
        <Button onClick={handleContinue} disabled={!isAIAvailable}>
          Continue
        </Button>
      </Panel>
    </Overlay>
  );
};

const Overlay = styled.div`
  position: absolute;
  inset: 0;
  backdrop-filter: blur(4px);
  background-color: ${p =>
    p.theme.darkMode ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.8)'};
  border-radius: ${p => p.theme.radius};
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 1rem;
  overflow-y: auto;
`;

const Panel = styled(Column)`
  max-width: 34rem;
  width: 100%;
  gap: 1rem;
  background-color: ${p => p.theme.colors.bg};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  padding: 1.25rem;
  box-shadow: ${p => p.theme.boxShadowSoft};
`;

const ActionsRow = styled(Row)`
  justify-content: flex-end;
  gap: 0.5rem;
  flex-wrap: wrap;
`;

const ProviderSection = styled(Column)`
  gap: 0.5rem;
  flex: 1 1 100%;
  width: 100%;
  min-width: 0;
`;

const CredentialsRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
`;

const OpenRouterLoginGroup = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  flex: 0 0 auto;
`;

const OrText = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.9rem;
`;

const ApiKeyField = styled(InputWrapper)`
  flex: 1 1 12rem;
  min-width: min(100%, 12rem);

  input {
    width: 100%;
    min-width: 0;
  }
`;

const FullWidthField = styled(InputWrapper)`
  width: 100%;

  input {
    width: 100%;
    min-width: 0;
  }
`;

const PresetRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
`;

const PresetChip = styled.button<{ $active: boolean }>`
  appearance: none;
  border: 1px solid
    ${p => (p.$active ? p.theme.colors.main : p.theme.colors.bg2)};
  background: ${p => (p.$active ? p.theme.colors.main : p.theme.colors.bg)};
  color: ${p => (p.$active ? p.theme.colors.bg : p.theme.colors.text)};
  border-radius: ${p => p.theme.radius};
  padding: 0.2rem 0.5rem;
  font-size: 0.75rem;
  cursor: pointer;
`;

const Title = styled.h3`
  margin: 0;
  font-size: 1rem;
`;

const Subtle = styled.p`
  margin: 0;
  color: ${p => p.theme.colors.textLight};
`;

const CheckboxRow = styled.label`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: ${p => p.theme.colors.textLight};
  cursor: pointer;
`;
