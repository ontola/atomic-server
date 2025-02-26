import { useState } from 'react';
import { Column, Row } from '../Row';
import Markdown from '../datatypes/Markdown';
import styled from 'styled-components';
import { FaTriangleExclamation } from 'react-icons/fa6';
import { useOpenRouterModels } from './useOpenRouterModels';
import { ComboBox } from '../ComboBox';

interface ModelSelectProps {
  onSelect?: (model: string) => void;
  defaultModel: string;
  enforceToolSupport?: boolean;
}

const formatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

export const ModelSelect = ({
  onSelect,
  defaultModel,
  enforceToolSupport = false,
}: ModelSelectProps) => {
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
    <Wrapper>
      <Column>
        <Column gap='0.2rem'>
          <ModelAmount>{modelList.length} Models</ModelAmount>
          <ComboBox
            selectedItem={selectedId}
            options={options}
            onSelect={value => {
              const newVal = value ?? defaultModel;
              setSelectedId(newVal);
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
        {selectedModel && (
          <>
            <Row wrapItems>
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
            </Row>

            <About>
              <Markdown text={selectedModel?.description ?? ''} />
            </About>
          </>
        )}
      </Column>
    </Wrapper>
  );
};

const About = styled.div`
  background-color: ${p => p.theme.colors.bg1};
  padding: ${p => p.theme.size()};
  border-radius: ${p => p.theme.radius};
`;

const Wrapper = styled.div`
  background-color: ${p => p.theme.colors.bg};
  width: min(90vw, 30rem);
  padding: ${p => p.theme.size()};
  border-radius: ${p => p.theme.radius};
`;

const ModelAmount = styled.div`
  font-size: 0.8em;
  color: ${p => p.theme.colors.textLight};
`;

const SupportWarning = styled(Row)`
  color: ${p => p.theme.colors.warning};
`;
