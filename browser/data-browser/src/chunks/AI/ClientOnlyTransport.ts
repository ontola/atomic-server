import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type ChatTransport,
  type ToolSet,
  type UIMessageChunk,
} from 'ai';
import { AIProvider } from '@components/AI/aiContstants';
import {
  type AIAgent,
  type AIModelIdentifier,
  type AtomicUIMessage,
} from './types';
import { useRef } from 'react';
import { useStore } from '@tomic/react';
import { addFieldsIf } from '@helpers/addIf';
import { stringifyTree, useGetDriveStructure } from './useGetDriveStructure';
import { useSettings } from '@helpers/AppSettings';
import { shortenSubject } from '@helpers/subjectRefs';
import { getClassesOnDrive } from './atomicSchemaHelpers';
import {
  createLanguageModel,
  type Modalities,
  type ProviderCredentials,
} from './providers';

export type { Modalities };

export interface ClientOnlyTransportOptions {
  credentials: ProviderCredentials;
  selectedAgent: AIAgent;
  model: AIModelIdentifier;
  tools: ToolSet;
  addContextToMessages: (
    messages: AtomicUIMessage[],
  ) => Promise<AtomicUIMessage[]>;
  resolveOutputModalities: (modelId: string) => Modalities[];
  resolveParameterSupport: (modelId: string, parameter: string) => boolean;
  /** Appended after template substitution (e.g. skills instructions). */
  additionalSystemPrompt?: string;
}

/**
 * A transport layer for the useChat hook that handles text streaming internally instead of relying on a server.
 */
export class ClientOnlyTransport implements ChatTransport<AtomicUIMessage> {
  public constructor(
    private options: ClientOnlyTransportOptions,
    private idGenerator: () => string,
    private _prepareSystemPrompt: (systemPrompt: string) => Promise<string>,
  ) {}

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
    const messagesFromLastSummary = trimToLastSummary(options.messages);

    const transformedMessages = await this.options.addContextToMessages(
      messagesFromLastSummary,
    );

    const agent = this.options.selectedAgent;

    const result = streamText({
      messages: await convertToModelMessages(transformedMessages),
      model: this.getModel(this.options.model),
      system: await this._prepareSystemPrompt(agent.systemPrompt),
      tools: this.options.tools,
      abortSignal,
      stopWhen: stepCountIs(1000),
      ...this.getParameters(agent, this.options.model),
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

    return originalStream;
  }

  public async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }

  private getModel(model: AIModelIdentifier) {
    const languageModel = createLanguageModel({
      model,
      credentials: this.options.credentials,
      openRouter:
        model.provider === AIProvider.OpenRouter
          ? {
              modalities: this.options.resolveOutputModalities(model.id),
              useContextCompression: true,
            }
          : undefined,
    });

    if (!languageModel) {
      throw new Error('Invalid model provider');
    }

    return languageModel;
  }

  private getParameters(agent: AIAgent, model: AIModelIdentifier) {
    if (
      model.provider === AIProvider.Ollama ||
      model.provider === AIProvider.OpenAICompatible
    ) {
      // Gateways / local servers rarely advertise parameter support; pass
      // temperature through and let the upstream reject unsupported fields.
      return {
        temperature: agent.temperature,
      };
    }

    if (model.provider === AIProvider.OpenRouter) {
      return {
        ...addFieldsIf(
          this.options.resolveParameterSupport(model.id, 'temperature'),
          {
            temperature: agent.temperature,
          },
        ),
        ...addFieldsIf(
          this.options.resolveParameterSupport(model.id, 'reasoning'),
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
}

/** Returns messages starting from the last summary message (inclusive), or all messages if none. */
function trimToLastSummary(messages: AtomicUIMessage[]): AtomicUIMessage[] {
  const lastSummaryIndex = messages.findLastIndex(
    m => m.metadata?.isSummary === true,
  );

  return lastSummaryIndex >= 0 ? messages.slice(lastSummaryIndex) : messages;
}

export const useClientOnlyTransport = (options: ClientOnlyTransportOptions) => {
  const store = useStore();
  const generateId = () => store.newLocalId();
  const { drive } = useSettings();
  const getDriveTree = useGetDriveStructure();

  /**
   * Prepares the system prompt by replacing the placeholders with the actual values.
   * If you add any new placeholder, be sure to update the helper text in the {@link AgentConfig} component.
   */
  const prepareSystemPrompt = async (systemPrompt: string) => {
    let modifiedSystemPrompt = systemPrompt;

    if (systemPrompt.includes('{{drive}}')) {
      modifiedSystemPrompt = modifiedSystemPrompt.replaceAll(
        '{{drive}}',
        drive,
      );
    }

    if (systemPrompt.includes('{{drive-structure}}')) {
      const driveTree = await getDriveTree();
      modifiedSystemPrompt = modifiedSystemPrompt.replaceAll(
        '{{drive-structure}}',
        stringifyTree(driveTree),
      );
    }

    if (systemPrompt.includes('{{custom-classes}}')) {
      const classSubjects = await getClassesOnDrive(drive, store);
      const customClasses = await Promise.all(
        classSubjects.map(async cls => {
          const resource = await store.getResource(cls);

          return `${resource.title}: ${shortenSubject(cls)}`;
        }),
      );

      modifiedSystemPrompt = modifiedSystemPrompt.replaceAll(
        '{{custom-classes}}',
        customClasses.length === 0
          ? 'No custom classes found on the current drive.'
          : customClasses.join('\n'),
      );
    }

    if (systemPrompt.includes('{{timestamp}}')) {
      modifiedSystemPrompt = modifiedSystemPrompt.replaceAll(
        '{{timestamp}}',
        new Date().toISOString(),
      );
    }

    if (options.additionalSystemPrompt) {
      modifiedSystemPrompt += `\n\n${options.additionalSystemPrompt}`;
    }

    return modifiedSystemPrompt;
  };

  // The useChat aggressively memoizes the transport so we need to make sure we always modify the same instance.
  const transportRef = useRef(
    new ClientOnlyTransport(options, generateId, prepareSystemPrompt),
  );
  const prevOptionsRef = useRef(options);

  // The ClientOnlyTransport instance needs to be stable between renders but we still need to update it's options when they change. I don't know how to do this without refs so we just have to accept these warnings.
  if (options !== prevOptionsRef.current) {
    transportRef.current.setOptions(options);
    prevOptionsRef.current = options;
  }

  transportRef.current.prepareSystemPrompt = prepareSystemPrompt;

  return transportRef.current;
};
