import styled from 'styled-components';
import { AIProvider, type AIModelIdentifier } from '../types';
import { OpenRouterModelSelector } from './OpenRouterModelSelector';
import { TAB_PANEL_HAS_ERROR_CLASS, TabPanel, Tabs } from '@components/Tabs';
import { OllamaModelSelector } from './OllamaModelSelector';
import { transition } from '@helpers/transition';
import { useSettings } from '@helpers/AppSettings';
import { Link } from '@tanstack/react-router';

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
  const { openRouterApiKey, ollamaUrl } = useSettings();

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
  background-color: ${p => p.theme.colors.bg};
  border-radius: ${p => p.theme.radius};

  border: 1px solid ${p => p.theme.colors.bg2};
  ${transition('border-color')}
  &:has(*.${TAB_PANEL_HAS_ERROR_CLASS}) {
    border: 1px solid ${p => p.theme.colors.alert};
  }
`;

const StyledTabPanel = styled(TabPanel)`
  padding: ${p => p.theme.size()};
  padding-top: unset;
`;

const NotConfiguredMessage = styled.div`
  display: grid;
  place-items: center;
  margin: -${p => p.theme.size()};
  padding: ${p => p.theme.size()};
  background-color: ${p => p.theme.colors.bgBody};
  border-radius: ${p => p.theme.radius};
  color: ${p => p.theme.colors.textLight};
`;
