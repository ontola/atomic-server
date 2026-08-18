import { createContext, ReactNode, useContext, type JSX } from 'react';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import type { AIModelIdentifier, MCPServer } from '@chunks/AI/types';
import {
  defaultMCPServers,
  mergeDefaultMCPServers,
} from '@chunks/AI/defaultMCPServers';
import {
  isEndpointConfigured,
  normalizeModelIdentifier,
  OPENROUTER_BASE_URL,
} from '@chunks/AI/aiEndpoint';

export const DEFAULT_CHAT_MODEL: AIModelIdentifier = {
  id: 'google/gemini-flash-latest',
};

function readJson<T>(key: string): T | undefined {
  try {
    const item = localStorage.getItem(key);

    if (!item || item === 'undefined') {
      return undefined;
    }

    return JSON.parse(item) as T;
  } catch {
    return undefined;
  }
}

/** One-time migration from the old multi-provider localStorage keys. */
function migrateEndpointDefaults(): {
  baseUrl: string | undefined;
  apiKey: string | undefined;
} {
  const existingBase = readJson<string | undefined>(
    'atomic.ai.endpoint.base-url',
  );
  const existingKey = readJson<string | undefined>(
    'atomic.ai.endpoint.api-key',
  );

  if (existingBase || existingKey) {
    return { baseUrl: existingBase, apiKey: existingKey };
  }

  const openRouterKey = readJson<string | undefined>(
    'atomic.ai.openrouter-api-key',
  );
  const openAICompatibleBase = readJson<string | undefined>(
    'atomic.ai.openai-compatible-base-url',
  );
  const openAICompatibleKey = readJson<string | undefined>(
    'atomic.ai.openai-compatible-api-key',
  );
  const ollamaUrl = readJson<string | undefined>('atomic.ai.ollama-url');

  if (openRouterKey) {
    return { baseUrl: OPENROUTER_BASE_URL, apiKey: openRouterKey };
  }

  if (openAICompatibleBase) {
    return {
      baseUrl: openAICompatibleBase,
      apiKey: openAICompatibleKey,
    };
  }

  if (ollamaUrl) {
    const trimmed = ollamaUrl.replace(/\/+$/, '');
    const baseUrl = trimmed.endsWith('/v1')
      ? trimmed
      : trimmed.endsWith('/api')
        ? `${trimmed.slice(0, -4)}/v1`
        : `${trimmed}/v1`;

    return { baseUrl, apiKey: undefined };
  }

  return { baseUrl: undefined, apiKey: undefined };
}

const migratedEndpoint = migrateEndpointDefaults();

function readStoredModel(
  key: string,
  fallback: AIModelIdentifier,
): AIModelIdentifier {
  return normalizeModelIdentifier(readJson(key)) ?? fallback;
}

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
  /** Default model for built-in agents and new custom agents */
  defaultChatModel: AIModelIdentifier;
  setDefaultChatModel: (model: AIModelIdentifier) => void;
  /** True when base URL (+ API key if required) are set. */
  isAIAvailable: boolean;
  /** OpenAI-compatible base URL (usually ends in `/v1`) */
  aiBaseUrl: string | undefined;
  setAiBaseUrl: (url: string | undefined) => void;
  /** API key for the endpoint (optional for local servers like Ollama) */
  aiApiKey: string | undefined;
  setAiApiKey: (key: string | undefined) => void;
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
  mcpServers: defaultMCPServers,
  setMcpServers: () => undefined,
  showTokenUsage: true,
  setShowTokenUsage: () => undefined,
  showFollowUpPrompts: true,
  setShowFollowUpPrompts: () => undefined,
  defaultChatModel: DEFAULT_CHAT_MODEL,
  setDefaultChatModel: () => undefined,
  isAIAvailable: false,
  aiBaseUrl: undefined,
  setAiBaseUrl: () => undefined,
  aiApiKey: undefined,
  setAiApiKey: () => undefined,
  shouldGenerateTitles: true,
  setShouldGenerateTitles: () => undefined,
  genFeaturesModel: { id: 'google/gemma-3-4b-it' },
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
  const [storedMcpServers, setStoredMcpServers] = useLocalStorage<MCPServer[]>(
    'atomic.ai.mcpServers',
    defaultMCPServers,
  );

  // Unset by default: a default localhost URL would probe loopback on every
  // page load and trigger the browser's local-network permission prompt.
  const [aiBaseUrl, setAiBaseUrl] = useLocalStorage<string | undefined>(
    'atomic.ai.endpoint.base-url',
    migratedEndpoint.baseUrl,
  );
  const [aiApiKey, setAiApiKey] = useLocalStorage<string | undefined>(
    'atomic.ai.endpoint.api-key',
    migratedEndpoint.apiKey,
  );

  const [showTokenUsage, setShowTokenUsage] = useLocalStorage(
    'atomic.ai.showTokenUsage',
    true,
  );

  const [defaultChatModel, setDefaultChatModelRaw] =
    useLocalStorage<AIModelIdentifier>(
      'atomic.ai.defaultChatModel',
      readStoredModel('atomic.ai.defaultChatModel', DEFAULT_CHAT_MODEL),
    );

  const [genFeaturesModel, setGenFeaturesModelRaw] =
    useLocalStorage<AIModelIdentifier>(
      'atomic.ai.genFeaturesModel',
      readStoredModel('atomic.ai.genFeaturesModel', {
        id: 'google/gemma-3-4b-it',
      }),
    );

  const setDefaultChatModel = (model: AIModelIdentifier) => {
    setDefaultChatModelRaw({ id: model.id });
  };

  const setGenFeaturesModel = (model: AIModelIdentifier) => {
    setGenFeaturesModelRaw({ id: model.id });
  };

  const [showFollowUpPrompts, setShowFollowUpPrompts] = useLocalStorage(
    'atomic.ai.showFollowUpPrompts',
    true,
  );

  const [shouldGenerateTitles, setShouldGenerateTitles] = useLocalStorage(
    'atomic.ai.shouldGenerateTitles',
    true,
  );

  const isAIAvailable = isEndpointConfigured(aiBaseUrl, aiApiKey);

  const mcpServers = mergeDefaultMCPServers(storedMcpServers);
  const setMcpServers = (servers: MCPServer[]) =>
    setStoredMcpServers(mergeDefaultMCPServers(servers));

  const context = {
    mcpServers,
    setMcpServers,
    enableAI,
    setEnableAI,
    showTokenUsage,
    setShowTokenUsage,
    aiBaseUrl,
    setAiBaseUrl,
    aiApiKey,
    setAiApiKey,
    showFollowUpPrompts,
    setShowFollowUpPrompts,
    defaultChatModel:
      normalizeModelIdentifier(defaultChatModel) ?? DEFAULT_CHAT_MODEL,
    setDefaultChatModel,
    isAIAvailable,
    shouldGenerateTitles,
    setShouldGenerateTitles,
    genFeaturesModel: normalizeModelIdentifier(genFeaturesModel) ?? {
      id: 'google/gemma-3-4b-it',
    },
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
