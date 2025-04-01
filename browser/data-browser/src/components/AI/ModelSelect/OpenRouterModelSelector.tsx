import styled from 'styled-components';
import { ComboBox } from '../../ComboBox';
import { Column, Row } from '../../Row';
import { useState } from 'react';
import { useOpenRouterModels } from '../useOpenRouterModels';
import { AIProvider, type AIModelIdentifier } from '../types';
import { FaTriangleExclamation } from 'react-icons/fa6';
import { ModelInfoLayout } from './ModelInfoLayout';
import Markdown from '../../datatypes/Markdown';

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
  const { models } = useOpenRouterModels();

  const [selectedId, setSelectedId] = useState<string>(defaultModel);
  const selectedModel = models.find(m => m.id === selectedId);

  const modelList = enforceToolSupport
    ? models.filter(m => m.supported_parameters.includes('tools'))
    : models;

  const showSupportWarning =
    selectedModel && !modelList.includes(selectedModel);

  const options = modelList.map(model => ({
    label: model.name,
    searchLabel: model.name.toLowerCase(),
    value: model.id,
  }));

  return (
    <Column>
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
