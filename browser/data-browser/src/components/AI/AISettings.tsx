import { Panel, usePanelList } from '@components/SideBar/usePanelList';
import SpeechSettings from './SpeechSettings';
import { AIProvider } from './aiContstants';
import { LocalOllamaDiscovery } from '@components/AI/LocalOllamaDiscovery';
import * as React from 'react';
import { Column, Row } from '@components/Row';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import styled, { useTheme } from 'styled-components';
import { Suspense, useEffect, useState } from 'react';
import { OpenRouterLoginButton } from './OpenRouterLoginButton';
import { effectFetch } from '@helpers/effectFetch';
import { transition } from '@helpers/transition';
import { useAISettings } from './AISettingsContext';
import { useIsOllamaUrlValid } from './useIsOllamaUrlValid';
import { LocalNetworkNotice } from './LocalNetworkNotice';
import { SettingCheckbox, SettingsSection } from '@components/Settings';
import { WarningBlock } from '@components/WarningBlock';
import { FaCheck, FaTriangleExclamation } from 'react-icons/fa6';
import { settingsKeywords } from '@components/Settings/settingsKeywords';

const ProviderModelSettings = React.lazy(
  () => import('@chunks/AI/ProviderModelSettings'),
);

const AIConfigurationSections = React.lazy(
  () => import('@chunks/AI/AIConfigurationSections'),
);

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

// Text that lives in child components, so the section shows for it
const AISettings: React.FC = () => {
  const theme = useTheme();
  const { enabledPanels, enablePanel, disablePanel } = usePanelList();
  const {
    enableAI,
    setEnableAI,
    openRouterApiKey,
    setOpenRouterApiKey,
    showTokenUsage,
    setShowTokenUsage,
    ollamaUrl,
    ollamaEndpoint,
    ollamaBlocked,
    setOllamaUrl,
    isProviderAvailable,
    shouldGenerateTitles,
    setShouldGenerateTitles,
    genFeaturesModel,
    setGenFeaturesModel,
  } = useAISettings();

  const [creditUsage, setCreditUsage] = useState<CreditUsage | undefined>();

  const handleSetOpenRouterKey = (key: string | undefined) => {
    if (!key) {
      setCreditUsage(undefined);
    }

    setOpenRouterApiKey(key);
  };

  const genFeaturesUnavailable = !isProviderAvailable(
    genFeaturesModel.provider,
  );

  const { valid: isOllamaUrlValid } = useIsOllamaUrlValid(ollamaEndpoint);

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

  return (
    <SettingsSection
      label='AI'
      id='ai'
      childSearchKeywords={settingsKeywords.ai}
    >
      <Column gap='0.75rem'>
        <SettingCheckbox checked={enableAI} onChange={setEnableAI}>
          Enable AI Features
        </SettingCheckbox>
        <SettingCheckbox
          checked={enabledPanels.has(Panel.AIChats)}
          onChange={checked =>
            checked ? enablePanel(Panel.AIChats) : disablePanel(Panel.AIChats)
          }
        >
          Enable AI Chats panel
        </SettingCheckbox>
        <ConditionalSettings enabled={enableAI} inert={!enableAI}>
          <SubGroup>
            <SettingsSection
              label='Generative features'
              childSearchKeywords='generative features generate chat titles model show token usage chats'
            >
              {genFeaturesUnavailable && (
                <WarningBlock>
                  <WarningBlock.Title>
                    The generative features model uses a provider that is not
                    available.
                  </WarningBlock.Title>
                </WarningBlock>
              )}
              <Column gap='0.5rem'>
                <SettingCheckbox
                  checked={showTokenUsage}
                  onChange={setShowTokenUsage}
                >
                  Show token usage in chats
                </SettingCheckbox>
                <SettingCheckbox
                  checked={shouldGenerateTitles}
                  onChange={setShouldGenerateTitles}
                >
                  Generate AI Chat titles
                </SettingCheckbox>
                <Column gap='0.5rem'>
                  <span>Provider</span>
                  <Suspense>
                    <ModelSelect
                      defaultModel={genFeaturesModel}
                      onSelect={setGenFeaturesModel}
                    />
                  </Suspense>
                </Column>
              </Column>
            </SettingsSection>
            <SettingsSection
              label='OpenRouter'
              childSearchKeywords='openrouter api key credits model default privacy retention zdr'
            >
              <Column gap='0.5rem'>
                <ConditionalSettings fullWidth gap='0.5rem' enabled={true}>
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
                    <Subtle>
                      Credits used: {intl.format(creditUsage.used)} /{' '}
                      {intl.format(creditUsage.total)}
                    </Subtle>
                  )}
                  {!openRouterApiKey && (
                    <Subtle>
                      OpenRouter provides a unified API that gives you access to
                      hundreds of AI models from all major vendors, while
                      automatically handling fallbacks and selecting the most
                      cost-effective options.
                    </Subtle>
                  )}
                </ConditionalSettings>
                <Suspense>
                  <ProviderModelSettings provider={AIProvider.OpenRouter} />
                </Suspense>
              </Column>
            </SettingsSection>
            <SettingsSection
              label='Ollama'
              childSearchKeywords='ollama api url local server model default'
            >
              <Column gap='0.5rem'>
                {!ollamaUrl && <LocalOllamaDiscovery />}
                <Subtle>
                  Host your own AI models locally using{' '}
                  <a
                    href='https://ollama.com/'
                    target='_blank'
                    rel='noreferrer'
                  >
                    Ollama
                  </a>
                </Subtle>
                <LocalNetworkNotice url={ollamaUrl} />
                <ConditionalSettings fullWidth gap='0.5rem' enabled={true}>
                  <Row center gap='1ch'>
                    {ollamaUrl &&
                      !ollamaBlocked &&
                      (isOllamaUrlValid ? (
                        <FaCheck
                          title='Server found'
                          color={theme.colors.main}
                        />
                      ) : (
                        <FaTriangleExclamation
                          title='Server not responding'
                          color={theme.colors.warning}
                        />
                      ))}
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
                </ConditionalSettings>
                <Suspense>
                  <ProviderModelSettings provider={AIProvider.Ollama} />
                </Suspense>
              </Column>
            </SettingsSection>
            <SpeechSettings />
            <Suspense fallback={<span>Loading AI settings…</span>}>
              <AIConfigurationSections />
            </Suspense>
          </SubGroup>
        </ConditionalSettings>
      </Column>
    </SettingsSection>
  );
};

const ConditionalSettings = styled(Column)<{ enabled: boolean }>`
  opacity: ${p => (p.enabled ? 1 : 0.3)};
  pointer-events: ${p => (p.enabled ? 'auto' : 'none')};
  touch-action: ${p => (p.enabled ? 'auto' : 'none')};
  ${transition('opacity')}
`;

const SubGroup = styled.div`
  margin-top: 0.25rem;
  display: flex;
  flex-direction: column;
  gap: 0;

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
