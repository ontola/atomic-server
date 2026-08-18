import styled from 'styled-components';
import { type AIModelIdentifier } from '../types';
import { transition } from '@helpers/transition';
import { Link } from '@tanstack/react-router';
import { useAISettings } from '@components/AI/AISettingsContext';
import { useAIModels } from '../useAIModels';
import { ComboBox } from '@components/ComboBox';
import { Column } from '@components/Row';
import { useState } from 'react';
import { ModelInfoLayout } from './ModelInfoLayout';

interface ModelSelectProps {
  onSelect?: (model: AIModelIdentifier) => void;
  defaultModel: AIModelIdentifier;
  /** Kept for call-site compatibility; tool metadata is not exposed by most gateways. */
  enforceToolSupport?: boolean;
}

export const ModelSelect = ({ onSelect, defaultModel }: ModelSelectProps) => {
  const { isAIAvailable, aiBaseUrl } = useAISettings();
  const { models } = useAIModels();
  const [selectedId, setSelectedId] = useState(defaultModel.id);

  if (!isAIAvailable) {
    return (
      <Wrapper>
        <NotConfiguredMessage>
          <span>
            Model endpoint is not configured. Go to{' '}
            <Link to='/app/settings'>Settings</Link>.
          </span>
        </NotConfiguredMessage>
      </Wrapper>
    );
  }

  const options = models.map(model => ({
    label: model.name ?? model.id,
    searchLabel: (model.name ?? model.id).toLowerCase(),
    value: model.id,
  }));

  return (
    <Wrapper>
      <Panel>
        <Column gap='0.2rem'>
          <ModelAmount>{models.length} Models</ModelAmount>
          <ComboBox
            selectedItem={selectedId}
            options={options}
            onSelect={value => {
              const id = value ?? defaultModel.id;
              setSelectedId(id);
              onSelect?.({ id });
            }}
          />
        </Column>
        {selectedId ? (
          <ModelInfoLayout
            About={
              <Subtle>
                Models from {aiBaseUrl ?? 'your endpoint'} via the
                OpenAI-compatible API.
              </Subtle>
            }
          />
        ) : (
          <ModelInfoLayout.Empty>Select a model</ModelInfoLayout.Empty>
        )}
      </Panel>
    </Wrapper>
  );
};

const Wrapper = styled.div`
  background-color: ${p => p.theme.colors.bg};
  border-radius: ${p => p.theme.radius};
  border: 1px solid ${p => p.theme.colors.bg2};
  ${transition('border-color')}
`;

const Panel = styled.div`
  padding: ${p => p.theme.size()};
`;

const NotConfiguredMessage = styled.div`
  display: grid;
  place-items: center;
  padding: ${p => p.theme.size()};
  background-color: ${p => p.theme.colors.bgBody};
  border-radius: ${p => p.theme.radius};
  color: ${p => p.theme.colors.textLight};
`;

const ModelAmount = styled.div`
  font-size: 0.8em;
  color: ${p => p.theme.colors.textLight};
`;

const Subtle = styled.div`
  color: ${p => p.theme.colors.textLight};
`;

export default ModelSelect;
