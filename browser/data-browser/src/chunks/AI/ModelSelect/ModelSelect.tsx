import styled from 'styled-components';
import { AIProvider } from '@components/AI/aiContstants';
import { type AIModelIdentifier } from '../types';
import { OpenRouterModelSelector } from './OpenRouterModelSelector';
import { TAB_PANEL_HAS_ERROR_CLASS, TabPanel, Tabs } from '@components/Tabs';
import { OllamaModelSelector } from './OllamaModelSelector';
import { transition } from '@helpers/transition';
import { Link } from '@tanstack/react-router';
import { useAISettings } from '@components/AI/AISettingsContext';

interface ModelSelectProps {
  onSelect?: (model: AIModelIdentifier) => void;
  defaultModel: AIModelIdentifier;
  enforceToolSupport?: boolean;
}

const PROVIDER_TABS = [
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
  const { openRouterApiKey, ollamaUrl } = useAISettings();

  return (
    <Wrapper>
      <Tabs
        tabs={PROVIDER_TABS}
        label='Provider'
        rounded
        defaultValue={defaultModel.provider}
      >
        <StyledTabPanel value={AIProvider.OpenRouter}>
          {openRouterApiKey ? (
            <OpenRouterModelSelector
              enforceToolSupport={enforceToolSupport}
              onSelect={model => {
                onSelect?.(model);
              }}
              defaultModel={defaultModel.id}
            />
          ) : (
            <NotConfiguredMessage>
              <span>
                OpenRouter API key is not configured. Go to{' '}
                <Link to='/app/settings'>Settings</Link>.
              </span>
            </NotConfiguredMessage>
          )}
        </StyledTabPanel>
        <StyledTabPanel value={AIProvider.Ollama}>
          {ollamaUrl ? (
            <OllamaModelSelector
              onSelect={model => {
                onSelect?.(model);
              }}
              selectedModel={defaultModel}
            />
          ) : (
            <NotConfiguredMessage>
              <span>
                Ollama URL is not configured. Go to{' '}
                <Link to='/app/settings'>Settings</Link>.
              </span>
            </NotConfiguredMessage>
          )}
        </StyledTabPanel>
      </Tabs>
    </Wrapper>
  );
};

const Wrapper = styled.div`
  background-color: var(--color-bg);
  border-radius: var(--radius-md);

  border: 1px solid var(--color-border);
  ${transition('border-color')}
  &:has(*.${TAB_PANEL_HAS_ERROR_CLASS}) {
    border: 1px solid var(--color-alert);
  }
`;

const StyledTabPanel = styled(TabPanel)`
  padding: var(--space-3);
  padding-top: unset;
`;

const NotConfiguredMessage = styled.div`
  display: grid;
  place-items: center;
  margin: -var(--space-3);
  padding: var(--space-3);
  background-color: var(--color-bg-body);
  border-radius: var(--radius-md);
  color: var(--color-text-subtle);
`;

export default ModelSelect;
