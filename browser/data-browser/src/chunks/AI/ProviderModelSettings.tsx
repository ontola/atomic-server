import { useAISettings } from '@components/AI/AISettingsContext';
import { AIProvider } from '@components/AI/aiContstants';
import { OpenRouterModelSelector } from './ModelSelect/OpenRouterModelSelector';
import { OllamaModelSelector } from './ModelSelect/OllamaModelSelector';
import { Column } from '@components/Row';

export default function ProviderModelSettings({
  provider,
}: {
  provider: AIProvider;
}) {
  const { defaultChatModel, setDefaultChatModel, isProviderAvailable } =
    useAISettings();
  if (!isProviderAvailable(provider)) return null;
  const selected = defaultChatModel.provider === provider;

  return (
    <Column gap='0.5rem'>
      <span>
        {selected
          ? 'Default chat model'
          : 'Choose a model to use this provider for new chats'}
      </span>
      {provider === AIProvider.OpenRouter ? (
        <OpenRouterModelSelector
          key={selected ? defaultChatModel.id : 'unselected'}
          defaultModel={selected ? defaultChatModel.id : ''}
          onSelect={setDefaultChatModel}
          enforceToolSupport
        />
      ) : (
        <OllamaModelSelector
          selectedModel={selected ? defaultChatModel : { provider, id: '' }}
          onSelect={setDefaultChatModel}
        />
      )}
    </Column>
  );
}
