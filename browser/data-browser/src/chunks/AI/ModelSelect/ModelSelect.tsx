import { useState } from 'react';
import { Column } from '@components/Row';
import { BasicSelect } from '@components/forms/BasicSelect';
import { AIProvider } from '@components/AI/aiContstants';
import { type AIModelIdentifier } from '../types';
import { OpenRouterModelSelector } from './OpenRouterModelSelector';
import { OllamaModelSelector } from './OllamaModelSelector';
import { Link } from '@tanstack/react-router';
import { useAISettings } from '@components/AI/AISettingsContext';
import { Button } from '@components/Button';

interface ModelSelectProps {
  onSelect?: (model: AIModelIdentifier) => void;
  defaultModel: AIModelIdentifier;
  enforceToolSupport?: boolean;
}

const PROVIDERS = [
  {
    label: 'OpenRouter',
    value: AIProvider.OpenRouter,
  },
  {
    label: 'Ollama',
    value: AIProvider.Ollama,
  },
];

export const ModelSelect = ({
  onSelect,
  defaultModel,
  enforceToolSupport = false,
}: ModelSelectProps) => {
  const { openRouterApiKey, ollamaUrl, hostedAI } = useAISettings();

  const [provider, setProvider] = useState(defaultModel.provider);
  const providers = hostedAI?.enabled
    ? [{ label: 'Included AI', value: AIProvider.Hosted }, ...PROVIDERS]
    : PROVIDERS;

  return (
    <Column gap='0.75rem'>
      <BasicSelect
        aria-label='Provider'
        value={provider}
        onChange={event => setProvider(event.target.value as AIProvider)}
      >
        {providers.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </BasicSelect>
      {provider === AIProvider.Hosted && hostedAI?.enabled && (
        <Column gap='0.5rem'>
          <p>{`${Math.floor(hostedAI.remaining_micros / 1000)} credits remaining across your drives.`}</p>
          <Button
            onClick={() =>
              onSelect?.({
                id: hostedAI.model,
                provider: AIProvider.Hosted,
              })
            }
          >
            Use included model
          </Button>
        </Column>
      )}
      {provider === AIProvider.OpenRouter && (
        <>
          {openRouterApiKey ? (
            <OpenRouterModelSelector
              enforceToolSupport={enforceToolSupport}
              onSelect={model => {
                onSelect?.(model);
              }}
              defaultModel={defaultModel.id}
            />
          ) : (
            <Column>
              <span>
                OpenRouter API key is not configured. Go to{' '}
                <Link to='/app/settings'>Settings</Link>.
              </span>
            </Column>
          )}
        </>
      )}
      {provider === AIProvider.Ollama && (
        <>
          {ollamaUrl ? (
            <OllamaModelSelector
              onSelect={model => {
                onSelect?.(model);
              }}
              selectedModel={defaultModel}
            />
          ) : (
            <Column>
              <span>
                Ollama URL is not configured. Go to{' '}
                <Link to='/app/settings'>Settings</Link>.
              </span>
            </Column>
          )}
        </>
      )}
    </Column>
  );
};

export default ModelSelect;
