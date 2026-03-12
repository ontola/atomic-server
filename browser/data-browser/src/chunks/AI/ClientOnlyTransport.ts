import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type ChatTransport,
  type ToolSet,
  type UIMessageChunk,
} from 'ai';
import { AIProvider } from '@components/AI/aiContstants';
import { type AIAgent, type AtomicUIMessage } from './types';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { useRef } from 'react';
import { useStore } from '@tomic/react';
import { useAutoAgentSelect } from './useAgentAutoSelect';
import { createOllama } from 'ollama-ai-provider-v2';
import { addFieldsIf } from '@helpers/addIf';
import { stringifyTree, useGetDriveStructure } from './useGetDriveStructure';

export type Modalities = 'text' | 'image';

export interface ClientOnlyTransportOptions {
  openRouterAPIKey?: string;
  ollamaURL?: string;
  selectedAgent: AIAgent;
  autoSelectAgent: boolean;
  tools: ToolSet;
  webSearchEnabled: boolean;
  addContextToMessages: (
    messages: AtomicUIMessage[],
  ) => Promise<AtomicUIMessage[]>;
  resolveOutputModalities: (modelId: string) => Modalities[];
  resolveParameterSupport: (modelId: string, parameter: string) => boolean;
}

/**
 * A transport layer for the useChat hook that handles text streaming internally instead of relying on a server.
 */
export class ClientOnlyTransport implements ChatTransport<AtomicUIMessage> {
  public constructor(
    private options: ClientOnlyTransportOptions,
    private idGenerator: () => string,
    private _autoSelectAgent: ReturnType<typeof useAutoAgentSelect>,
    private _prepareSystemPrompt: (systemPrompt: string) => Promise<string>,
  ) {}

  public set autoSelectAgent(func: ReturnType<typeof useAutoAgentSelect>) {
    this._autoSelectAgent = func;
  }

  public set prepareSystemPrompt(
    func: (systemPrompt: string) => Promise<string>,
  ) {
    this._prepareSystemPrompt = func;
  }

  public setOptions(options: ClientOnlyTransportOptions) {
    this.options = options;
  }

  public async sendMessages({
    abortSignal,
    ...options
  }: Parameters<ChatTransport<AtomicUIMessage>['sendMessages']>[0]) {
    const transformedMessages = await this.options.addContextToMessages(
      options.messages,
    );

    const agent = await this.getAgent(transformedMessages);

    const result = streamText({
      messages: convertToModelMessages(transformedMessages),
      model: this.getModelFromAgent(agent),
      system: await this._prepareSystemPrompt(agent.systemPrompt),
      tools: this.options.tools,
      abortSignal,
      stopWhen: stepCountIs(10),
      ...this.getParameters(agent),
    });

    const originalStream = result.toUIMessageStream({
      originalMessages: transformedMessages,
      generateMessageId: this.idGenerator,
      messageMetadata: ({ part }) => {
        if (part.type === 'finish') {
          return {
            inputTokensUsed: part.totalUsage.inputTokens,
            outputTokensUsed: part.totalUsage.outputTokens,
          };
        }
      },
      sendSources: true,
      sendReasoning: true,
    });

    // Create a transform stream that logs each chunk
    const loggingTransform = new TransformStream({
      transform(chunk, controller) {
        // console.log(chunk.type, chunk);
        controller.enqueue(chunk);
      },
    });

    return originalStream.pipeThrough(loggingTransform);
  }

  public async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }

  private getModelFromAgent(agent: AIAgent) {
    if (
      agent.model.provider === AIProvider.OpenRouter &&
      this.options.openRouterAPIKey
    ) {
      const modalities = this.options.resolveOutputModalities(agent.model.id);

      const openRouter = createOpenRouter({
        apiKey: this.options.openRouterAPIKey,
        compatibility: 'strict',
        extraBody: {
          transforms: ['middle-out'],
          modalities,
        },
      });

      return openRouter(
        agent.model.id + (this.options.webSearchEnabled ? ':online' : ''),
      );
    }

    if (agent.model.provider === AIProvider.Ollama && this.options.ollamaURL) {
      const ollama = createOllama({
        baseURL: `${this.options.ollamaURL}/api`,
      });

      return ollama(agent.model.id);
    }

    throw new Error('Invalid model provider');
  }

  private getParameters(agent: AIAgent) {
    if (agent.model.provider === AIProvider.Ollama) {
      // We can't check if Ollama supports specific parameters, so we just return all of them.
      return {
        temperature: agent.temperature,
      };
    }

    if (agent.model.provider === AIProvider.OpenRouter) {
      return {
        ...addFieldsIf(
          this.options.resolveParameterSupport(agent.model.id, 'temperature'),
          {
            temperature: agent.temperature,
          },
        ),
        ...addFieldsIf(
          this.options.resolveParameterSupport(agent.model.id, 'reasoning'),
          {
            reasoning: {
              effort: 'low',
              summary: 'auto',
            },
          },
        ),
      };
    }

    throw new Error('Invalid model provider');
  }

  private async getAgent(messages: AtomicUIMessage[]): Promise<AIAgent> {
    if (this.options.autoSelectAgent && messages.length === 1) {
      const prompt = messages[0].parts
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('');

      return await this._autoSelectAgent(prompt);
    }

    return this.options.selectedAgent;
  }
}

export const useClientOnlyTransport = (options: ClientOnlyTransportOptions) => {
  const store = useStore();
  const generateId = () => store.createSubject();
  const pickAgent = useAutoAgentSelect();
  const getDriveTree = useGetDriveStructure();

  const prepareSystemPrompt = async (systemPrompt: string) => {
    const driveTree = await getDriveTree();
    let modifiedSystemPrompt = systemPrompt;

    if (systemPrompt.includes('{{drive-structure}}')) {
      modifiedSystemPrompt = modifiedSystemPrompt.replace(
        '{{drive-structure}}',
        stringifyTree(driveTree),
      );
    }

    if (systemPrompt.includes('{{timestamp}}')) {
      modifiedSystemPrompt = modifiedSystemPrompt.replace(
        '{{timestamp}}',
        new Date().toISOString(),
      );
    }

    return modifiedSystemPrompt;
  };

  // The useChat aggressively memoizes the transport so we need to make sure we always modify the same instance.
  const transportRef = useRef(
    new ClientOnlyTransport(
      options,
      generateId,
      pickAgent,
      prepareSystemPrompt,
    ),
  );
  const prevOptionsRef = useRef(options);

  if (options !== prevOptionsRef.current) {
    transportRef.current.setOptions(options);
    prevOptionsRef.current = options;
  }

  transportRef.current.autoSelectAgent = pickAgent;
  transportRef.current.prepareSystemPrompt = prepareSystemPrompt;

  return transportRef.current;
};
