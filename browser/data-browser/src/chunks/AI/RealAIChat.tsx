import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Column, Row } from '@components/Row';
import { useAtomicMCPTools } from './useAtomicTools';
import { skillTools, getSkillsSystemPromptPart } from './skills/skill';
import { AIChatMessage } from './AIChatMessage';
import { type FileUIPart } from 'ai';
import { useTools } from './useTools';
import { styled, keyframes } from 'styled-components';
import { GeneratingIndicator } from './GeneratingIndicator';
import { IconButton } from '@components/IconButton/IconButton';
import { FaXmark, FaPaperclip, FaFile } from 'react-icons/fa6';
import { ChatMessagesContainer } from './ChatMessagesContainer';
import { useStore, type Resource } from '@tomic/react';
import { AIProvider } from '@components/AI/aiContstants';
import {
  AIAgent,
  type AIAtomicResourceMessageContext,
  type AIMCPResourceMessageContext,
  type AIMessageContext,
  type AIModelIdentifier,
  type AISkillMessageContext,
  type AtomicUIMessage,
} from './types';
import { useAIAgentConfig } from './AgentConfig';
import { AISettingsDialog } from './AISettingsDialog';
import { Dialog, useDialog } from '@components/Dialog';
import { MessageContextItem } from './MessageContextItem';

import { ComboBox } from '@components/ComboBox';
import { effectFetch } from '@helpers/effectFetch';

type OllamaModel = {
  name: string;
  model: string;
  size: number;
  details: {
    format: string;
    parent_model: string;
    family: string;
    parameter_size: string;
    quantization_level: string;
  };
};
import { useProcessMessages } from './useProcessMessages';
import { AISetupPanel } from './AISetupPanel';
import { useOpenRouterModels } from './useOpenRouterModels';
import {
  getAutoCompactTokenThreshold,
  useModelContextLength,
} from './useModelContextLength';
import type { MentionItem } from '@chunks/RTE/AIChatInput/types';
import { useChat } from '@ai-sdk/react';
import { useClientOnlyTransport } from './ClientOnlyTransport';
import { useGenerativeData } from './useGenerativeData';
import { useConversationSummary } from './useConversationSummary';
import { FollowUpPrompt } from './FollowUpPrompt';
import { useAISettings } from '@components/AI/AISettingsContext';
import UsesMCPServers from '@components/AI/MCP/UsesMCPServers';
import { useRAG } from './useRAG';
import { useOnValueChange } from '@helpers/useOnValueChange';
import { transition } from '@helpers/transition';
import { useAIChanges } from '@components/AIChangesContext';
import { useVectorIndexStatus } from '@hooks/useVectorIndexStatus';
import { Spinner } from '@components/Spinner';

const AIChatInput = React.lazy(
  () => import('@chunks/RTE/AIChatInput/AsyncAIChatInput'),
);

interface RealAIChatProps {
  fullView?: boolean;
  readonly?: boolean;
  initialMessages?: AtomicUIMessage[];
  /** Messages that predate the latest compaction — shown in UI but not sent to the LLM. */
  historicalMessages?: AtomicUIMessage[];
  onNewMessage: (message: AtomicUIMessage) => void;
  /**
   * Called after compaction. All prior messages move to historical UI state;
   * only the summary is kept for LLM context.
   */
  onCompacted?: (
    priorMessages: AtomicUIMessage[],
    summaryMessage: AtomicUIMessage,
  ) => void;
  /** Called when a summary message is deleted and prior messages are restored. */
  onSummaryDeleted?: (restoredMessages: AtomicUIMessage[]) => void;
  externalContextItems: AIMessageContext[];
  chatSubject?: string;
  setExternalContextItems: React.Dispatch<
    React.SetStateAction<AIMessageContext[]>
  >;
  onDeleteMessage: (message: AtomicUIMessage) => void;
  onRegenerateMessage: (message: AtomicUIMessage) => void | Promise<void>;
}

export const RealAIChat: React.FC<React.PropsWithChildren<RealAIChatProps>> = ({
  children,
  ...props
}) => {
  return (
    <UsesMCPServers>
      <RealAIChatInner {...props}>{children}</RealAIChatInner>
    </UsesMCPServers>
  );
};

const RealAIChatInner: React.FC<React.PropsWithChildren<RealAIChatProps>> = ({
  fullView = false,
  readonly = false,
  initialMessages,
  historicalMessages,
  externalContextItems,
  chatSubject,
  setExternalContextItems,
  onNewMessage,
  onCompacted,
  onSummaryDeleted,
  onDeleteMessage,
  onRegenerateMessage,
  children,
}) => {
  const store = useStore();
  const {
    openRouterApiKey,
    showTokenUsage,
    showFollowUpPrompts,
    ollamaUrl,
    isProviderAvailable,
  } = useAISettings();

  // useChat does not update it's options so we need to use a ref to make it use the latest value.
  const showFollowUpPromptsRef = useRef(showFollowUpPrompts);
  const autoCompactTokenThresholdRef = useRef<number | null>(null);
  // Use a ref for the guard so the stale onFinish closure sees the current value.
  const isCompactingRef = useRef(false);

  const { getInitialAgent, setLastUsedAgentForChat, setLastUsedSidebarAgent } =
    useAIAgentConfig();
  const getToolsForAgent = useTools();
  const {
    checkORModelSupportsImageInput,
    checkORModelSupport,
    getOutputModalities,
    models: openRouterModels,
  } = useOpenRouterModels();

  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);

  useEffect(() => {
    if (!ollamaUrl) {
      setOllamaModels([]);
      return;
    }

    return effectFetch(`${ollamaUrl}/api/tags`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })(
      data => {
        setOllamaModels(data.models || []);
      },
      e => {
        console.error('Failed to fetch Ollama models:', e);
        setOllamaModels([]);
      },
    );
  }, [ollamaUrl]);

  const currencyFormatter = useRef(
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }),
  ).current;

  const combinedModelOptions = useMemo(() => {
    const openRouterOptions = openRouterModels.map(model => {
      const promptPrice =
        model.pricing?.prompt !== undefined
          ? `${currencyFormatter.format(model.pricing.prompt * 1000000)}/M input`
          : '';
      const completionPrice =
        model.pricing?.completion !== undefined
          ? `${currencyFormatter.format(model.pricing.completion * 1000000)}/M output`
          : '';
      const pricingStr = [promptPrice, completionPrice]
        .filter(Boolean)
        .join(' • ');

      return {
        label: model.name,
        searchLabel: model.name.toLowerCase(),
        description: pricingStr ? `${pricingStr}` : undefined,
        value: `openrouter:${model.id}`,
      };
    });

    const ollamaOptions = ollamaModels.map(model => {
      const details = [
        'Local',
        model.details?.parameter_size
          ? `Size: ${model.details.parameter_size}`
          : '',
        model.details?.format ? `Format: ${model.details.format}` : '',
      ]
        .filter(Boolean)
        .join(' • ');

      return {
        label: model.name,
        searchLabel: model.name.toLowerCase(),
        description: details,
        value: `ollama:${model.model}`,
      };
    });

    return [...openRouterOptions, ...ollamaOptions];
  }, [openRouterModels, ollamaModels, currencyFormatter]);

  const modelSelectContainerRef = useRef<HTMLDivElement>(null);

  const getRAGData = useRAG();
  const [isRagging, setIsRagging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [userInput, setUserInput] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const { defaultChatModel } = useAISettings();
  const [selectedAgent, setSelectedAgent] = useState<AIAgent>(
    getInitialAgent(!chatSubject, chatSubject),
  );
  const [activeModel, setActiveModel] = useState<AIModelIdentifier>(() => {
    return selectedAgent.model ?? defaultChatModel;
  });
  const modelContextLength = useModelContextLength(activeModel);
  const addContextToMessages = useProcessMessages({
    includeDriveInstructions: selectedAgent.canReadAtomicData,
  });

  const vectorIndexing = useVectorIndexStatus();

  // The user should be blocked from posting if the indexes are updating while using an agent that is dependent on those indexes.
  const disableSubmit =
    vectorIndexing &&
    (selectedAgent.canReadAtomicData || selectedAgent.ragEnabled);

  const { reportAIEdit } = useAIChanges();
  const canUseInput = isProviderAvailable(activeModel.provider);

  const [userSelectedContextItems, setUserSelectedContextItems] = useState<
    AIMessageContext[]
  >([]);
  const { generateFollowUpQuestions } = useGenerativeData();
  const { generateConversationSummary } = useConversationSummary(
    activeModel,
  );
  const [agentConfigOpen, setAgentConfigOpen] = useState(false);
  const [followUpQuestions, setFollowUpQuestions] = useState<string[]>([]);

  const { tools: atomicTools } = useAtomicMCPTools({
    editModel: activeModel,
    onResourceEdited: (originalResource: Resource) => {
      reportAIEdit(originalResource);
    },
  });

  const transport = useClientOnlyTransport({
    openRouterAPIKey: openRouterApiKey,
    ollamaURL: ollamaUrl,
    selectedAgent,
    model: activeModel,
    additionalSystemPrompt: selectedAgent.skillsEnabled
      ? getSkillsSystemPromptPart()
      : undefined,
    tools: {
      ...(selectedAgent.canReadAtomicData ? atomicTools.read : {}),
      ...(selectedAgent.canWriteAtomicData ? atomicTools.write : {}),
      ...(selectedAgent.skillsEnabled ? skillTools : {}),
      ...getToolsForAgent(selectedAgent),
    },
    resolveOutputModalities: getOutputModalities,
    resolveParameterSupport: checkORModelSupport,
    addContextToMessages,
  });

  const { messages, sendMessage, setMessages, status, stop, regenerate } =
    useChat({
      transport,
      messages: initialMessages,
      generateId: () => store.createSubject(),
      onFinish: ({ message, isError, messages: _messages }) => {
        if (isError) {
          message.metadata = {
            ...(message.metadata || {}),
            error: 'Something went wrong',
          };
        }

        onNewMessage(message);

        if (showFollowUpPromptsRef.current && message.role === 'assistant') {
          generateFollowUpQuestions(_messages).then(setFollowUpQuestions);
        }

        const inputTokens = message.metadata?.inputTokensUsed ?? 0;
        const threshold = autoCompactTokenThresholdRef.current;

        if (threshold !== null && inputTokens > threshold) {
          compact(_messages);
        }
      },
    });

  const [isCompacting, setIsCompacting] = useState(false);
  const [scrollToCompactTrigger, setScrollToCompactTrigger] = useState(0);

  const compact = async (messagesOverride?: AtomicUIMessage[]) => {
    const messagesToCompact = messagesOverride ?? messages;

    if (isCompactingRef.current || messagesToCompact.length < 2) return;

    isCompactingRef.current = true;
    setIsCompacting(true);

    let summaryText: string | undefined;

    try {
      summaryText = await generateConversationSummary(messagesToCompact);
    } catch (e) {
      console.error(e);
      isCompactingRef.current = false;
      setIsCompacting(false);

      return;
    }

    if (!summaryText) {
      isCompactingRef.current = false;
      setIsCompacting(false);

      return;
    }

    const summaryMessage: AtomicUIMessage = {
      id: store.createSubject(),
      role: 'user',
      parts: [
        {
          type: 'text',
          text: `<conversation-summary>\n${summaryText}\n</conversation-summary>`,
        },
      ],
      metadata: { isSummary: true },
    };

    setMessages([summaryMessage]);
    onCompacted?.(messagesToCompact, summaryMessage);
    setScrollToCompactTrigger(t => t + 1);

    isCompactingRef.current = false;
    setIsCompacting(false);
  };

  const usage = messages.reduce(
    (acc, message) => ({
      input: acc.input + (message.metadata?.inputTokensUsed || 0),
      output: acc.output + (message.metadata?.outputTokensUsed || 0),
    }),
    { input: 0, output: 0 },
  );

  const handleFileUpload = (files: File[]) => {
    setAttachedFiles(prev => [...prev, ...files]);
  };

  const removeAttachedFile = (file: File) => {
    setAttachedFiles(prev => prev.filter(f => f !== file));

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleMentionUpdate = (mentions: MentionItem[]) => {
    // Convert mentions to context items
    const newContextItems: AIMessageContext[] = mentions.map(mention => {
      if (mention.type === 'atomic-resource') {
        return {
          type: mention.type,
          id: crypto.randomUUID(),
          subject: mention.id,
        } as AIAtomicResourceMessageContext;
      } else if (mention.type === 'mcp-resource') {
        return {
          type: mention.type,
          id: crypto.randomUUID(),
          uri: mention.id,
          name: mention.label,
          serverId: mention.serverId,
        } as AIMCPResourceMessageContext;
      } else if (mention.type === 'skill') {
        return {
          type: 'skill',
          id: crypto.randomUUID(),
          name: mention.label,
        } as AISkillMessageContext;
      }

      throw new Error('Invalid mention type');
    });

    setUserSelectedContextItems(newContextItems);
  };

  const checkModelSupportsImageInput = (model: AIModelIdentifier) => {
    if (model.provider === AIProvider.OpenRouter) {
      return checkORModelSupportsImageInput(model.id);
    }

    // We can't know if an ollama is multimodal so we'll just assume it is and have the model handle the failure case.
    return true;
  };

  // Combine both context item lists when needed
  const allContextItems = [
    ...externalContextItems,
    ...userSelectedContextItems,
  ];
  const visibleContextItems = allContextItems.filter(
    item => item.type !== 'skill',
  );

  const handleSubmit = async (inputOverride?: string) => {
    const text = inputOverride || userInput;

    if (text.trim() === '/compact') {
      setUserInput('');
      await compact();

      return;
    }

    const context = [...externalContextItems, ...userSelectedContextItems];
    const message: AtomicUIMessage = {
      id: store.createSubject(),
      role: 'user',
      parts: [
        {
          type: 'text',
          text: text,
        },
      ],
    };

    if (selectedAgent.ragEnabled && messages.length === 0) {
      setIsRagging(true);
      const ragData = await getRAGData(text);

      message.metadata = {
        ...(message.metadata ?? {}),
        serverContext: ragData,
      };

      setIsRagging(false);
    }

    if (attachedFiles) {
      const fileParts = await filesToFileParts(attachedFiles);
      message.parts.push(...fileParts);
    }

    if (context.length > 0) {
      message.metadata = {
        ...(message.metadata ?? {}),
        userContext: context,
      };

      setUserSelectedContextItems([]);
      setExternalContextItems([]);
    }

    onNewMessage(message);
    sendMessage(message);
    setAttachedFiles([]);
    setFollowUpQuestions([]);

    if (chatSubject) {
      setLastUsedAgentForChat(chatSubject, selectedAgent.id);
    } else {
      setLastUsedSidebarAgent(selectedAgent.id);
    }
  };

  const regenerateMessage = async (message: AtomicUIMessage) => {
    await onRegenerateMessage(message);

    // If the message is historical (before the summary), it isn't in useChat's
    // internal messages. Restore those messages so regenerate() can find the ID.
    if (historicalMessageIds.has(message.id)) {
      const historicalList = historicalMessages ?? [];
      const targetIndex = historicalList.findIndex(m => m.id === message.id);

      if (targetIndex !== -1) {
        setMessages(historicalList.slice(0, targetIndex + 1));
      }
    }

    regenerate({
      messageId: message.id,
    });
  };

  const deleteMessage = (message: AtomicUIMessage) => {
    if (message.metadata?.isSummary) {
      const restored = [
        ...(historicalMessages ?? []),
        ...messages.filter(m => m.id !== message.id),
      ];
      setMessages(restored);
      onSummaryDeleted?.(restored);
      onDeleteMessage(message);

      return;
    }

    onDeleteMessage(message);
    setMessages(prev => prev.filter(m => m !== message));
  };

  useOnValueChange(() => {
    if (!chatSubject) return;

    const initialAgent = getInitialAgent(false, chatSubject);

    setSelectedAgent(initialAgent);
    setActiveModel(initialAgent.model ?? defaultChatModel);
  }, [chatSubject, defaultChatModel]);

  useOnValueChange(() => {
    if (!selectedAgent.model) {
      setActiveModel(defaultChatModel);
    }
  }, [defaultChatModel]);

  const handleSelectAgent = (agent: AIAgent) => {
    setSelectedAgent(agent);
    setActiveModel(agent.model ?? defaultChatModel);
  };



  const isEmptyChat = messages.length === 0;
  const totalTokensUsed = usage.input + usage.output;

  // Historical messages are shown in the UI but excluded from the active message list.
  const historicalMessageIds = new Set(
    (historicalMessages ?? []).map(m => m.id),
  );
  const visibleMessages = messages.filter(
    m => m.metadata?.isSummary || !historicalMessageIds.has(m.id),
  );

  useEffect(() => {
    showFollowUpPromptsRef.current = showFollowUpPrompts;
  }, [showFollowUpPrompts]);

  useEffect(() => {
    const percent = selectedAgent.autoCompactThresholdPercent ?? 80;
    autoCompactTokenThresholdRef.current = getAutoCompactTokenThreshold(
      modelContextLength,
      percent,
    );
  }, [selectedAgent.autoCompactThresholdPercent, modelContextLength]);

  return (
    <ChatWindow fullView={fullView} empty={messages.length === 0}>
      {children}
      <ChatMessagesContainer
        enableAutoScroll={status === 'streaming'}
        scrollToCompactTrigger={scrollToCompactTrigger}
        fullView={fullView}
      >
        {historicalMessages && historicalMessages.length > 0 && (
          <>
            {historicalMessages.map(message => (
              <HistoricalMessageWrapper key={message.id}>
                <AIChatMessage
                  message={message}
                  onDeleteMessage={deleteMessage}
                  onRegenerateMessage={regenerateMessage}
                />
              </HistoricalMessageWrapper>
            ))}
          </>
        )}
        {visibleMessages.map(message => (
          <AIChatMessage
            key={message.id}
            message={message}
            onDeleteMessage={deleteMessage}
            onRegenerateMessage={regenerateMessage}
          />
        ))}
      </ChatMessagesContainer>
      <Column style={{ minWidth: 0 }}>
        {status === 'streaming' && (
          <Row center gap='0.2ch'>
            <GeneratingIndicator text='Generating' />
            <IconButton title='Stop generating' onClick={stop}>
              <FaXmark />
            </IconButton>
          </Row>
        )}
        {status !== 'streaming' && isRagging && (
          <Row center gap='0.2ch'>
            <GeneratingIndicator text='Gathering context' />
          </Row>
        )}
        {isCompacting && (
          <Row center gap='0.2ch'>
            <GeneratingIndicator text='Compacting context' />
          </Row>
        )}
        {!readonly && (
          <>
            {followUpQuestions.length > 0 && (
              <Column gap='0px'>
                {followUpQuestions.map(question => (
                  <FollowUpPrompt
                    key={question}
                    text={question}
                    onClick={() => handleSubmit(question)}
                  />
                ))}
              </Column>
            )}
            <ChatInputWrapper>
              <Column fullWidth gap='none' style={{ position: 'relative', minWidth: 0 }}>
                <FloatingChatWidgetsContainer>
                  {attachedFiles.length > 0 && (
                    <Row gap='1ch' wrapItems>
                      {attachedFiles.map(file => (
                        <AttachmentPreview key={file.name}>
                          <Row gap='1ch' center>
                            <FaFile />
                            <span>{file.name}</span>
                          </Row>
                          <IconButton
                            title='Remove file'
                            onClick={() => removeAttachedFile(file)}
                            size='small'
                          >
                            <FaXmark />
                          </IconButton>
                        </AttachmentPreview>
                      ))}
                    </Row>
                  )}
                </FloatingChatWidgetsContainer>
                {visibleContextItems.length > 0 && (
                  <ContextItemRow wrapItems center gap='1ch'>
                    {visibleContextItems.map(item => (
                      <MessageContextItem
                        key={item.id}
                        contextItem={item}
                        onRemove={
                          // Only allow removing external context items, normal items are removed via the input.
                          externalContextItems.some(x => x.id === item.id)
                            ? () => {
                                setExternalContextItems(prev => {
                                  const newList = prev.filter(
                                    i => i.id !== item.id,
                                  );

                                  if (newList.length === prev.length) {
                                    return prev;
                                  }

                                  return newList;
                                });
                              }
                            : undefined
                        }
                      />
                    ))}
                  </ContextItemRow>
                )}
                <AIChatInput
                  large={isEmptyChat && fullView}
                  disabled={!canUseInput}
                  disableSubmit={disableSubmit}
                  hasFiles={!!attachedFiles}
                  onMentionUpdate={handleMentionUpdate}
                  onChange={setUserInput}
                  onSubmit={handleSubmit}
                  onCompact={compact}
                  onEditModel={() => {
                    const input = modelSelectContainerRef.current?.querySelector('input');
                    if (input) {
                      input.focus();
                      input.select();
                    }
                  }}
                  onEditAgent={() => setAgentConfigOpen(true)}
                  onFileAdded={
                    checkModelSupportsImageInput(activeModel)
                      ? handleFileUpload
                      : undefined
                  }
                  rightAlignedChildren={
                    vectorIndexing && (
                      <IndexingIndicator center gap='0.5rem'>
                        <Spinner size='1.1rem' inheritColor />
                        <span>Indexing</span>
                      </IndexingIndicator>
                    )
                  }
                >
                  <Row gap='0.5rem' style={{ minWidth: 0, overflow: 'hidden', flexWrap: 'nowrap', flex: 1 }}>
                    <SubtleButton onClick={() => setAgentConfigOpen(true)}>
                      {selectedAgent.name}
                    </SubtleButton>
                    <ModelSelectWrapper ref={modelSelectContainerRef}>
                      <ComboBox
                        subtle
                        selectedItem={`${activeModel.provider}:${activeModel.id}`}
                        options={combinedModelOptions}
                        onSelect={value => {
                          if (!value) return;
                          const [providerStr, ...idParts] = value.split(':');
                          const id = idParts.join(':');
                          const provider =
                            providerStr === 'openrouter'
                              ? AIProvider.OpenRouter
                              : AIProvider.Ollama;
                          setActiveModel({ id, provider });
                        }}
                      />
                    </ModelSelectWrapper>
                    {checkModelSupportsImageInput(activeModel) && (
                      <>
                        <input
                          multiple
                          type='file'
                          ref={fileInputRef}
                          onChange={e => {
                            if (!e.target.files) return;

                            handleFileUpload(Array.from(e.target.files));
                          }}
                          style={{ display: 'none' }}
                        />
                        <IconButton
                          title='Attach file'
                          onClick={() => fileInputRef.current?.click()}
                          color='textLight'
                        >
                          <FaPaperclip />
                        </IconButton>
                      </>
                    )}
                  </Row>
                </AIChatInput>
              </Column>
              {messages.length === 0 && <div></div>}
            </ChatInputWrapper>
            {showTokenUsage && totalTokensUsed > 0 && (
              <TokensUsed>
                Tokens used: {nummberFormatter.format(usage.input)} input,{' '}
                {nummberFormatter.format(usage.output)} output
              </TokensUsed>
            )}
          </>
        )}
      </Column>
      <AISettingsDialog
        open={agentConfigOpen}
        onOpenChange={setAgentConfigOpen}
        selectedAgent={selectedAgent}
        onSelectAgent={handleSelectAgent}
      />

      {!readonly && <AISetupPanel />}
    </ChatWindow>
  );
};

const nummberFormatter = new Intl.NumberFormat(undefined, {});

const filesToFileParts = (files: File[]): Promise<FileUIPart[]> =>
  Promise.all(
    files.map(
      file =>
        new Promise<FileUIPart>((resolve, reject) => {
          const reader = new FileReader();

          reader.onload = (loadEvent: ProgressEvent<FileReader>) => {
            resolve({
              type: 'file',
              mediaType: file.type,
              filename: file.name,
              url: loadEvent.target?.result as string,
            });
          };

          reader.onerror = (error: ProgressEvent<FileReader>) => {
            reject(error);
          };

          reader.readAsDataURL(file);
        }),
    ),
  );

const ChatInputWrapper = styled.div`
  background-color: ${p => p.theme.colors.bg};
  padding: ${p => p.theme.size(2)};
  border-radius: ${p => p.theme.radius};
  border: solid 1px ${p => p.theme.colors.bg2};
  display: flex;
  flex: 1;
  align-items: flex-end;
  gap: ${p => p.theme.size()};
  position: relative;
  min-width: 0;

  ${transition('border-color')}
  &:focus-within {
    border-color: ${p => p.theme.colors.main};
  }

  textarea {
    height: 100%;
  }
`;

const AttachmentPreview = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  background-color: ${p => p.theme.colors.bg};
  padding: ${p => p.theme.size(1)};
  border-radius: ${p => p.theme.radius};
  font-size: 0.8rem;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
`;

const ChatWindow = styled.div<{ fullView?: boolean; empty?: boolean }>`
  padding: ${p => (p.fullView ? p.theme.size() : 0)};
  padding-top: ${p => (p.fullView ? p.theme.size(2) : 0)};
  position: relative;
  display: grid;
  grid-template-rows: ${p =>
    p.empty && p.fullView ? 'auto 1fr auto 1fr' : 'auto 1fr auto'};
  height: ${p => (p.fullView ? '90vh' : '100%')};
  width: min(100%, 70rem);
  margin-inline: auto;
  gap: 1rem;

  pre {
    white-space: pre-wrap;
    word-break: break-word;
  }

  @media (max-width: 1550px) {
    height: 90vh;
  }
`;

const TokensUsed = styled.p`
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;

const SubtleButton = styled.button`
  appearance: none;
  cursor: pointer;
  background: none;
  border: none;
  border-radius: ${p => p.theme.radius};
  padding: ${p => p.theme.size(1)};
  padding-inline: ${p => p.theme.size(2)};

  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex-shrink: 1;

  &:focus-visible,
  &:hover {
    background-color: ${p => p.theme.colors.bg1};
  }
`;

const FloatingChatWidgetsContainer = styled.div`
  display: flex;
  flex-direction: column;
  height: fit-content;
  gap: ${p => p.theme.size(2)};
  position: absolute;
  width: 100%;
  bottom: calc(100% + ${p => p.theme.size(3)});
  left: 0;
  right: 0;
  z-index: 10;
`;

const ContextItemRow = styled(Row)`
  padding-inline: ${p => p.theme.size(2)};
`;

const IndexingIndicator = styled(Row)`
  color: ${p => p.theme.colors.textLight};
`;

/**
 * Animates from full opacity (in-viewport) to dim (above viewport) as the message
 * exits by scrolling upward. The exit range covers exactly the height of the element
 * crossing the viewport's top edge, so the fade-out is proportional to scroll distance.
 * animation-fill-mode: both keeps it dim when above the viewport and bright when in view.
 */
const historicalExitFade = keyframes`
  from { opacity: 1; }
  to { opacity: 0.2; }
`;

const HistoricalMessageWrapper = styled.div`
  animation: ${historicalExitFade} linear both;
  animation-timeline: view();
  animation-range: exit 0% exit 80%;
`;

const ModelSelectWrapper = styled.div`
  min-width: 14rem;
  flex: 1.5;
  flex-shrink: 1;

  & > div {
    width: 100%;
  }
`;
