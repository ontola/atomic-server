import { createContext, ReactNode, useContext, type JSX } from 'react';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { AIProvider } from './aiContstants';
import type { AIModelIdentifier, MCPServer } from '@chunks/AI/types';

interface AISettingsContextType {
  /** Enable all AI features in the app */
  enableAI: boolean;
  setEnableAI: (b: boolean) => void;
  /** List of MCP servers */
  mcpServers: MCPServer[];
  /** Update the list of MCP servers */
  setMcpServers: (servers: MCPServer[]) => void;
  /** Whether to show the token usage in AI chats */
  showTokenUsage: boolean;
  setShowTokenUsage: (b: boolean) => void;
  /** Whether to show the follow up prompts in AI chats */
  showFollowUpPrompts: boolean;
  setShowFollowUpPrompts: (b: boolean) => void;
  enabledProviders: AIProvider[];
  isProviderEnabled: (provider: AIProvider) => boolean;
  setIsProviderEnabled: (provider: AIProvider, enabled: boolean) => void;
  /** The OpenRouter API key for making requests to OpenRouter */
  openRouterApiKey: string | undefined;
  setOpenRouterApiKey: (key: string | undefined) => void;
  /** The URL of the Ollama server */
  ollamaUrl: string | undefined;
  setOllamaUrl: (url: string | undefined) => void;
  shouldGenerateTitles: boolean;
  setShouldGenerateTitles: (b: boolean) => void;
  genFeaturesModel: AIModelIdentifier;
  setGenFeaturesModel: (model: AIModelIdentifier) => void;
}

interface ProviderProps {
  children: ReactNode;
}

const initialState: AISettingsContextType = {
  enableAI: true,
  setEnableAI: () => undefined,
  mcpServers: [],
  setMcpServers: () => undefined,
  showTokenUsage: true,
  setShowTokenUsage: () => undefined,
  showFollowUpPrompts: true,
  setShowFollowUpPrompts: () => undefined,
  enabledProviders: [],
  isProviderEnabled: () => false,
  setIsProviderEnabled: () => undefined,
  openRouterApiKey: undefined,
  setOpenRouterApiKey: () => undefined,
  ollamaUrl: 'http://localhost:11434/api',
  setOllamaUrl: () => undefined,
  shouldGenerateTitles: true,
  setShouldGenerateTitles: () => undefined,
  genFeaturesModel: {
    id: 'google/gemma-3-4b-it',
    provider: AIProvider.OpenRouter,
  },
  setGenFeaturesModel: () => undefined,
};

/**
 * The context must be provided by wrapping a high level React element in
 * <AISettingsContext.Provider value={new AISettingsContextType}>
 */
export const AISettingsContext =
  createContext<AISettingsContextType>(initialState);

/** Create a provider for AI settings */
export const AISettingsContextProvider = (
  props: ProviderProps,
): JSX.Element => {
  const [enableAI, setEnableAI] = useLocalStorage('atomic.ai.enabled', true);
  const [mcpServers, setMcpServers] = useLocalStorage<MCPServer[]>(
    'atomic.ai.mcpServers',
    [],
  );
  const [ollamaUrl, setOllamaUrl] = useLocalStorage<string | undefined>(
    'atomic.ai.ollama-url',
    'http://localhost:11434',
  );
  const [showTokenUsage, setShowTokenUsage] = useLocalStorage(
    'atomic.ai.showTokenUsage',
    true,
  );
  const [enabledProviders, setEnabledProviders] = useLocalStorage<AIProvider[]>(
    'atomic.ai.enabledProviders',
    [],
  );
  const [openRouterApiKey, setOpenRouterApiKey] = useLocalStorage<
    string | undefined
  >('atomic.ai.openrouter-api-key', undefined);

  const [genFeaturesModel, setGenFeaturesModel] =
    useLocalStorage<AIModelIdentifier>('atomic.ai.genFeaturesModel', {
      id: 'google/gemma-3-4b-it',
      provider: AIProvider.OpenRouter,
    });

  const [showFollowUpPrompts, setShowFollowUpPrompts] = useLocalStorage(
    'atomic.ai.showFollowUpPrompts',
    true,
  );

  const [shouldGenerateTitles, setShouldGenerateTitles] = useLocalStorage(
    'atomic.ai.shouldGenerateTitles',
    true,
  );

  const isProviderEnabled = (provider: AIProvider) =>
    enabledProviders.includes(provider);

  const setIsProviderEnabled = (provider: AIProvider, enabled: boolean) =>
    setEnabledProviders(prev =>
      enabled ? [...prev, provider] : prev.filter(p => p !== provider),
    );

  const context = {
    openRouterApiKey,
    setOpenRouterApiKey,
    mcpServers,
    setMcpServers,
    enableAI,
    setEnableAI,
    showTokenUsage,
    setShowTokenUsage,
    ollamaUrl,
    setOllamaUrl,
    showFollowUpPrompts,
    setShowFollowUpPrompts,
    enabledProviders,
    isProviderEnabled,
    setIsProviderEnabled,
    shouldGenerateTitles,
    setShouldGenerateTitles,
    genFeaturesModel,
    setGenFeaturesModel,
  };

  return (
    <AISettingsContext.Provider value={context}>
      {props.children}
    </AISettingsContext.Provider>
  );
};

/** Hook for using AI Settings */
export const useAISettings = (): AISettingsContextType => {
  return useContext(AISettingsContext);
};
