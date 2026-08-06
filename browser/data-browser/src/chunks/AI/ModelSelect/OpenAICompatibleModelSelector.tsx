import styled from 'styled-components';
import { ComboBox } from '@components/ComboBox';
import { Column } from '@components/Row';
import { useState } from 'react';
import { useOpenAICompatibleModels } from '../useOpenAICompatibleModels';
import { AIProvider } from '@components/AI/aiContstants';
import { type AIModelIdentifier } from '../types';
import { ModelInfoLayout } from './ModelInfoLayout';
import { useAISettings } from '@components/AI/AISettingsContext';

interface OpenAICompatibleModelSelectorProps {
  onSelect: (model: AIModelIdentifier) => void;
  defaultModel: string;
}

export const OpenAICompatibleModelSelector: React.FC<
  OpenAICompatibleModelSelectorProps
> = ({ onSelect, defaultModel }) => {
  const { models } = useOpenAICompatibleModels();
  const { isProviderAvailable, openAICompatibleBaseUrl } = useAISettings();
  const [selectedId, setSelectedId] = useState<string>(defaultModel);

  const options = models.map(model => ({
    label: model.name ?? model.id,
    searchLabel: (model.name ?? model.id).toLowerCase(),
    value: model.id,
  }));

  if (!isProviderAvailable(AIProvider.OpenAICompatible)) {
    return (
      <ModelInfoLayout.Empty>
        Add an OpenAI-compatible base URL and API key in settings
      </ModelInfoLayout.Empty>
    );
  }

  return (
    <Column>
      <Column gap='0.2rem'>
        <ModelAmount>{models.length} Models</ModelAmount>
        <ComboBox
          selectedItem={selectedId}
          options={options}
          onSelect={value => {
            const newVal = {
              id: value ?? defaultModel,
              provider: AIProvider.OpenAICompatible,
            };
            setSelectedId(newVal.id);
            onSelect?.(newVal);
          }}
        />
      </Column>
      {selectedId ? (
        <ModelInfoLayout
          About={
            <Subtle>
              Models from{' '}
              {openAICompatibleBaseUrl ?? 'your OpenAI-compatible endpoint'}.
              Any gateway that speaks the OpenAI chat completions API works here
              (OrcaRouter, Groq, LiteLLM, LM Studio, etc.).
            </Subtle>
          }
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

const Subtle = styled.div`
  color: ${p => p.theme.colors.textLight};
`;
