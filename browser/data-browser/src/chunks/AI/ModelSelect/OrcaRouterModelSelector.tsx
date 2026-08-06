import styled from 'styled-components';
import { ComboBox } from '@components/ComboBox';
import { Column } from '@components/Row';
import { useState } from 'react';
import { useOrcaRouterModels } from '../useOrcaRouterModels';
import { AIProvider } from '@components/AI/aiContstants';
import { type AIModelIdentifier } from '../types';
import { ModelInfoLayout } from './ModelInfoLayout';
import { useAISettings } from '@components/AI/AISettingsContext';

interface OrcaRouterModelSelectorProps {
  onSelect: (model: AIModelIdentifier) => void;
  defaultModel: string;
}

export const OrcaRouterModelSelector: React.FC<
  OrcaRouterModelSelectorProps
> = ({ onSelect, defaultModel }) => {
  const { models } = useOrcaRouterModels();
  const { isProviderAvailable } = useAISettings();
  const [selectedId, setSelectedId] = useState<string>(defaultModel);

  const options = models.map(model => ({
    label: model.id,
    searchLabel: model.id.toLowerCase(),
    value: model.id,
  }));

  if (!isProviderAvailable(AIProvider.OrcaRouter)) {
    return (
      <ModelInfoLayout.Empty>
        Add an OrcaRouter API key in settings
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
              provider: AIProvider.OrcaRouter,
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
              OrcaRouter is an OpenAI-compatible gateway that routes to models
              from multiple providers through a single API key.
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
