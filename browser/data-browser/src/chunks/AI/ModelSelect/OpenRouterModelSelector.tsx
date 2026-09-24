import styled from 'styled-components';
import { Checkbox, CheckboxLabel } from '@components/forms/Checkbox';
import { ComboBox } from '@components/ComboBox';
import { Column, Row } from '@components/Row';
import { useState } from 'react';
import { useOpenRouterModels } from '../useOpenRouterModels';
import { AIProvider } from '@components/AI/aiContstants';
import { type AIModelIdentifier } from '../types';
import { FaTriangleExclamation } from 'react-icons/fa6';
import { ModelInfoLayout } from './ModelInfoLayout';
import Markdown from '@components/datatypes/Markdown';
import { useAISettings } from '@components/AI/AISettingsContext';

interface OpenRouterModelSelectorProps {
  onSelect: (model: AIModelIdentifier) => void;
  defaultModel: string;
  enforceToolSupport?: boolean;
}

const formatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

export const OpenRouterModelSelector: React.FC<
  OpenRouterModelSelectorProps
> = ({ onSelect, defaultModel, enforceToolSupport = false }) => {
  const { models, privacyError, privacyLoading } = useOpenRouterModels();
  const { isProviderAvailable, openRouterZdr, setOpenRouterZdr } =
    useAISettings();
  const [selectedId, setSelectedId] = useState<string>(defaultModel);
  const selectedModel = models.find(m => m.id === selectedId);

  const modelList = enforceToolSupport
    ? models.filter(m => m.supported_parameters.includes('tools'))
    : models;

  const showSupportWarning =
    selectedModel && !modelList.includes(selectedModel);

  const options = modelList.map(model => ({
    description: [
      Number.isFinite(Number(model.pricing?.prompt)) &&
      Number(model.pricing.prompt) >= 0
        ? `from ${formatter.format(Number(model.pricing.prompt) * 1000000)}/M input`
        : undefined,
      Number.isFinite(Number(model.pricing?.completion)) &&
      Number(model.pricing.completion) >= 0
        ? `${formatter.format(Number(model.pricing.completion) * 1000000)}/M output`
        : undefined,
      model.created && Number.isFinite(model.created) && model.created > 0
        ? `added ${new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(model.created * 1000))}`
        : undefined,
    ]
      .filter(Boolean)
      .join(' · '),
    label: model.name,
    searchLabel: model.name.toLowerCase(),
    value: model.id,
  }));

  if (!isProviderAvailable(AIProvider.OpenRouter)) {
    return (
      <ModelInfoLayout.Empty>
        Add an OpenRouter API key in settings
      </ModelInfoLayout.Empty>
    );
  }

  return (
    <Column>
      <CheckboxLabel>
        <Checkbox checked={openRouterZdr} onChange={setOpenRouterZdr} />
        <span>No data retention</span>
      </CheckboxLabel>
      {openRouterZdr && (
        <Description>
          Applies to OpenRouter chat models, including titles and follow-ups.
          Voice and external tools have separate data policies.
        </Description>
      )}
      {privacyLoading && (
        <Description>Loading zero-retention models…</Description>
      )}
      {openRouterZdr &&
        !privacyLoading &&
        !privacyError &&
        selectedId &&
        !models.some(model => model.id === selectedId) && (
          <Description>
            The selected model is not in the zero-retention list. Choose another
            model.
          </Description>
        )}
      {privacyError && (
        <Description>
          Could not load zero-retention models. No unrestricted models are
          shown.
        </Description>
      )}
      <Column gap='0.2rem'>
        <ModelAmount>{modelList.length} Models</ModelAmount>
        <ComboBox
          selectedItem={selectedId}
          options={options}
          onSelect={value => {
            const newVal = {
              id: value ?? defaultModel,
              provider: AIProvider.OpenRouter,
            };
            setSelectedId(newVal.id);
            onSelect?.(newVal);
          }}
        />
        {showSupportWarning && (
          <SupportWarning center gap='1ch'>
            <FaTriangleExclamation />
            The selected model does not support tool use.
          </SupportWarning>
        )}
      </Column>
      {selectedModel ? (
        <ModelInfoLayout
          Pricing={
            <>
              <span>
                {formatter.format(selectedModel?.pricing.prompt * 1000000)}/M
                input tokens
              </span>
              <span>
                {formatter.format(selectedModel?.pricing.completion * 1000000)}
                /M output tokens
              </span>
              {selectedModel.supported_parameters.includes(
                'web_search_options',
              ) && (
                <span>
                  {formatter.format(selectedModel?.pricing.web_search * 1000)}
                  /1K web search results
                </span>
              )}
            </>
          }
          About={<Markdown text={selectedModel?.description ?? ''} />}
        />
      ) : (
        <ModelInfoLayout.Empty>Select a model</ModelInfoLayout.Empty>
      )}
    </Column>
  );
};

const ModelAmount = styled.div`
  font-size: 0.8em;
  color: ${p => p.theme.colors.textLight};
`;

const SupportWarning = styled(Row)`
  color: ${p => p.theme.colors.warning};
`;

const Description = styled.p`
  margin: 0;
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;
