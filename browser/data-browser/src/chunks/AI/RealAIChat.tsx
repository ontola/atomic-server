import React, { useRef, useState } from 'react';
import { Column, Row } from '@components/Row';
import { useAtomicMCPTools } from './useAtomicTools';
import { skillTools, getSkillsSystemPromptPart } from './skills/skill';
import { AIChatMessage } from './AIChatMessage';
import { type FileUIPart } from 'ai';
import { useTools } from './useTools';
import { styled } from 'styled-components';
import { GeneratingIndicator } from './GeneratingIndicator';
import {
  IconButton,
  IconButtonVariant,
} from '@components/IconButton/IconButton';
import { FaXmark, FaPaperclip, FaFile, FaGlobe } from 'react-icons/fa6';
import { ChatMessagesContainer } from './ChatMessagesContainer';
import { useStore, type Resource } from '@tomic/react';
import { AIProvider } from '@components/AI/aiContstants';
import {
  AIAgent,
  type AIAtomicResourceMessageContext,
  type AIMCPResourceMessageContext,
  type AIMessageContext,
  type AIModelIdentifier,
  type AtomicUIMessage,
} from './types';
import { useAIAgentConfig } from './AgentConfig';
import { AISettingsDialog } from './AISettingsDialog';
import { MessageContextItem } from './MessageContextItem';
import { useProcessMessages } from './useProcessMessages';
import { NoKeyOverlay } from './NoKeyOverlay';
import { useOpenRouterModels } from './useOpenRouterModels';
import type { MentionItem } from '@chunks/RTE/AIChatInput/types';
import { useChat } from '@ai-sdk/react';
import { useClientOnlyTransport } from './ClientOnlyTransport';
import { useGenerativeData } from './useGenerativeData';
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
  onNewMessage: (message: AtomicUIMessage) => void;
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
  externalContextItems,
  chatSubject,
  setExternalContextItems,
  onNewMessage,
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
    isProviderEnabled,
  } = useAISettings();

  // useChat does not update it's options so we need to use a ref to make it use the latest value.
  const showFollowUpPromptsRef = useRef(showFollowUpPrompts);
  showFollowUpPromptsRef.current = showFollowUpPrompts;

  const { getInitialAgent, setLastUsedAgentForChat, setLastUsedSidebarAgent } =
    useAIAgentConfig();
  const addContextToMessages = useProcessMessages();
  const getToolsForAgent = useTools();
  const {
    checkORModelSupportsImageInput,
    checkORModelSupport,
    getOutputModalities,
  } = useOpenRouterModels();

  const getRAGData = useRAG();
  const [isRagging, setIsRagging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [userInput, setUserInput] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AIAgent>(
    getInitialAgent(!chatSubject, chatSubject),
  );

  const vectorIndexing = useVectorIndexStatus();

  // The user should be blocked from posting if the indexes are updating while using an agent that is dependent on those indexes.
  const disableSubmit =
    vectorIndexing &&
    (selectedAgent.canReadAtomicData || selectedAgent.ragEnabled);

  const { reportAIEdit } = useAIChanges();
  const canUseInput = isProviderEnabled(selectedAgent.model.provider);

  const [userSelectedContextItems, setUserSelectedContextItems] = useState<
    AIMessageContext[]
  >([]);
  const { generateFollowUpQuestions } = useGenerativeData();
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [agentConfigOpen, setAgentConfigOpen] = useState(false);
  const [followUpQuestions, setFollowUpQuestions] = useState<string[]>([]);

  const webSearchSupported =
    selectedAgent.model.provider === AIProvider.OpenRouter;

  const { tools: atomicTools } = useAtomicMCPTools({
    onResourceEdited: (originalResource: Resource) => {
      reportAIEdit(originalResource);
    },
  });

  const transport = useClientOnlyTransport({
    openRouterAPIKey: openRouterApiKey,
    ollamaURL: ollamaUrl,
    selectedAgent,
    additionalSystemPrompt: selectedAgent.skillsEnabled
      ? getSkillsSystemPromptPart()
      : undefined,
    tools: {
      ...(selectedAgent.canReadAtomicData ? atomicTools.read : {}),
      ...(selectedAgent.canWriteAtomicData ? atomicTools.write : {}),
      ...(selectedAgent.skillsEnabled ? skillTools : {}),
      ...getToolsForAgent(selectedAgent),
    },
    webSearchEnabled,
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
      },
    });

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

  const handleSubmit = async (inputOverride?: string) => {
    const text = inputOverride || userInput;
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

    regenerate({
      messageId: message.id,
    });
  };

  const deleteMessage = (message: AtomicUIMessage) => {
    onDeleteMessage(message);
    setMessages(prev => prev.filter(m => m !== message));
  };

  useOnValueChange(() => {
    if (!chatSubject) return;

    const initialAgent = getInitialAgent(false, chatSubject);

    setSelectedAgent(initialAgent);
  }, [chatSubject]);

  const isEmptyChat = messages.length === 0;
  const totalTokensUsed = usage.input + usage.output;

  return (
    <ChatWindow fullView={fullView} empty={messages.length === 0}>
      {children}
      <ChatMessagesContainer
        enableAutoScroll={status === 'streaming'}
        fullView={fullView}
      >
        {messages.map(message => (
          <AIChatMessage
            key={message.id}
            message={message}
            onDeleteMessage={deleteMessage}
            onRegenerateMessage={regenerateMessage}
          />
        ))}
      </ChatMessagesContainer>
      <Column>
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
              <Column fullWidth gap='none' style={{ position: 'relative' }}>
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
                {allContextItems.length > 0 && (
                  <ContextItemRow wrapItems center gap='1ch'>
                    {allContextItems.map(item => (
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
                  onFileAdded={
                    checkModelSupportsImageInput(selectedAgent.model)
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
                  <Row gap='0.5rem'>
                    <SubtleButton onClick={() => setAgentConfigOpen(true)}>
                      {selectedAgent.name}
                    </SubtleButton>
                    {webSearchSupported && (
                      <IconButton
                        title='Toggle web search'
                        onClick={() => setWebSearchEnabled(v => !v)}
                        color={webSearchEnabled ? 'main' : 'textLight'}
                        variant={
                          webSearchEnabled ? IconButtonVariant.Fill : undefined
                        }
                      >
                        <FaGlobe />
                      </IconButton>
                    )}
                    {checkModelSupportsImageInput(selectedAgent.model) && (
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
              <NoKeyOverlay />
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
        onSelectAgent={setSelectedAgent}
      />
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
  color: ${p => p.theme.colors.textLight};
  border-radius: ${p => p.theme.radius};
  padding: ${p => p.theme.size(1)};
  padding-inline: ${p => p.theme.size(2)};

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
