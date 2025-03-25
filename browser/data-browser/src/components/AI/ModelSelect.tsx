import { useEffect, useState } from 'react';
import { Column, Row } from '../Row';
import Markdown from '../datatypes/Markdown';
import styled from 'styled-components';
import { BasicSelect } from '../forms/BasicSelect';

interface ModelSelectProps {
  onSelect?: (model: string) => void;
  defaultModel: string;
}

let modelDataCache: OpenRouterAIModel[] | undefined = undefined;

export type OpenRouterAIModel = {
  id: string;
  name: string;
  description: string;
  pricing: {
    prompt: number;
    completion: number;
  };
};

const formatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

export const ModelSelect = ({ onSelect, defaultModel }: ModelSelectProps) => {
  const [models, setModels] = useState<OpenRouterAIModel[]>(
    modelDataCache ?? [],
  );
  const [selectedId, setSelectedId] = useState<string>(defaultModel);
  const selectedModel = models.find(m => m.id === selectedId);

  useEffect(() => {
    if (modelDataCache) {
      return;
    }

    fetch('https://openrouter.ai/api/v1/models?supported_parameters=tools')
      .then(res => res.json())
      .then(data => {
        setModels(data.data as OpenRouterAIModel[]);
        modelDataCache = data.data as OpenRouterAIModel[];
      });
  }, []);

  return (
    <Wrapper>
      <Column>
        <BasicSelect
          value={selectedModel?.id}
          onChange={e => {
            console.log(e.target.value);
            setSelectedId(e.target.value);
            onSelect?.(e.target.value);
          }}
        >
          {models.map(model => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </BasicSelect>
        {selectedModel && (
          <>
            <Row>
              <span>
                {formatter.format(selectedModel?.pricing.prompt * 1000000)}/M
                input tokens
              </span>
              <span>
                {formatter.format(selectedModel?.pricing.completion * 1000000)}
                /M output tokens
              </span>
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
