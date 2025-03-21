import React, { useEffect, useRef, useState } from 'react';
import { useSettings } from '../../helpers/AppSettings';
import { Column, Row } from '../Row';
import toast from 'react-hot-toast';
import { useAtomicMCPTools } from './useAtomicTools';
import { AIChatMessage } from './AIChatMessage';
import {
  generateObject,
  InvalidToolArgumentsError,
  NoSuchToolError,
  streamText,
  TypeValidationError,
  type CoreMessage,
  type ImagePart,
  type FilePart,
  type ToolCallPart,
} from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { useTools } from './useTools';
import { styled } from 'styled-components';
import { GeneratingIndicator } from './GeneratingIndicator';
import { IconButton, IconButtonVariant } from '../IconButton/IconButton';
import {
  FaArrowRight,
  FaXmark,
  FaPaperclip,
  FaFile,
  FaCheck,
} from 'react-icons/fa6';
import { ChatMessagesContainer } from './ChatMessagesContainer';
import { useStore } from '@tomic/react';
import {
  AIAgent,
  AIState,
  isMessageWithContext,
  type AIChatDisplayMessage,
  type AIMessageContext,
} from './types';
import { AgentConfig, useAIAgentConfig } from './AgentConfig';
import { Button } from '../Button';
import { MessageContextItem } from './MessageContextItem';
import { useProcessMessages } from './useProcessMessages';
import { NoKeyOverlay } from './NoKeyOverlay';
import { useAutoAgentSelect } from './useAgentAutoSelect';

const AIChatInput = React.lazy(
  () => import('../../chunks/MarkdownEditor/AIChatInput/AsyncAIChatInput'),
);

type OngoingMessagePart = {
  type: 'reasoning' | 'text';
  text: string;
};

// File attachment type
type FileAttachment = {
  name: string;
  type: string;
  base64Content: string;
  isImage: boolean;
};

// Image file mime types
const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
];

interface SimpleAIChatProps {
  messages: AIChatDisplayMessage[];
  fullView?: boolean;
  readonly?: boolean;
  onNewMessage: (message: AIChatDisplayMessage) => void;
  externalContextItems: AIMessageContext[];
  setExternalContextItems: React.Dispatch<
    React.SetStateAction<AIMessageContext[]>
  >;
}

export const SimpleAIChat: React.FC<
  React.PropsWithChildren<SimpleAIChatProps>
> = ({
  messages,
  fullView = false,
  readonly = false,
  externalContextItems,
  setExternalContextItems,
  onNewMessage,
  children,
}) => {
  const abortSignalRef = useRef<AbortController>(null);
  const [aiState, setAiState] = useState<AIState>(AIState.Stopped);
  const [editedResources, setEditedResources] = useState<string[]>([]);
  const { agents, autoAgentSelectEnabled, defaultAgentId } = useAIAgentConfig();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachedFile, setAttachedFile] = useState<FileAttachment | null>(null);
  const store = useStore();
  const [selectedAgent, setSelectedAgent] = useState<AIAgent>(
    agents.find(a => a.id === defaultAgentId) || agents[0],
  );
  const [userInput, setUserInput] = useState('');
  const [userSelectedContextItems, setUserSelectedContextItems] = useState<
    AIMessageContext[]
  >([]);
  const { openRouterApiKey } = useSettings() as { openRouterApiKey?: string };
  const openrouter = createOpenRouter({
    apiKey: openRouterApiKey,
    compatibility: 'strict',
    extraBody: {
      transforms: ['middle-out'],
    },
  });
  const [ongoingMessage, setOngoingMessage] = useState<OngoingMessagePart>({
    type: 'text',
    text: '',
  });
  const [tokensUsed, setTokensUsed] = useState<[number, number]>([0, 0]);

  const getToolsForAgent = useTools();
  const [hasToolResultFollowUp, setHasToolResultFollowUp] = useState(false);

  const [agentConfigOpen, setAgentConfigOpen] = useState(false);
  const pickAgent = useAutoAgentSelect();

  const normalizeAndApplyContext = useProcessMessages();

  const { tools: atomicTools } = useAtomicMCPTools({
    onResourceEdited: (subject: string) => {
      setEditedResources(prev => {
        if (!prev.includes(subject)) {
          return [...prev, subject];
        }

        return prev;
      });
    },
  });

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();

    reader.onloadend = () => {
      const base64Content = (reader.result as string).split(',')[1];
      setAttachedFile({
        name: file.name,
        type: file.type,
        base64Content,
        isImage: IMAGE_MIME_TYPES.includes(file.type),
      });
      toast.success(`File "${file.name}" attached`);
    };

    reader.onerror = () => {
      toast.error('Error reading file');
    };

    reader.readAsDataURL(file);
  };

  const removeAttachedFile = () => {
    setAttachedFile(null);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const sendMessage = async (isFollowUp = false) => {
    if (readonly) {
      toast.error('You do not have the permissions to edit this chat.');

      return;
    }

    abortSignalRef.current = new AbortController();

    if (!openRouterApiKey) {
      toast.error(
        'OpenRouter API key not found. Please provide a valid API key in settings.',
      );

      return;
    }

    let messagesToUse: AIChatDisplayMessage[] = [];

    let pickedAgent = selectedAgent;

    if (autoAgentSelectEnabled && messages.length === 0) {
      try {
        setAiState(AIState.SelectingAgent);
        pickedAgent = await pickAgent(userInput);
      } catch (err) {
        console.error(err);
      }
    }

    // const systemPrompt = injectContextIntoPrompt(pickedAgent.systemPrompt);
    const systemPrompt = pickedAgent.systemPrompt;
    const toolsToUse = {
      ...(pickedAgent.canReadAtomicData ? atomicTools.read : {}),
      ...(pickedAgent.canWriteAtomicData ? atomicTools.write : {}),
      ...getToolsForAgent(pickedAgent),
    };

    const allContextItems = [
      ...externalContextItems,
      ...userSelectedContextItems,
    ];

    if (!isFollowUp) {
      const userMessage = prepareUserMessage(
        userInput,
        attachedFile,
        allContextItems,
      );
      messagesToUse = [...messages, userMessage];
      onNewMessage(userMessage);
    } else {
      messagesToUse = messages;
    }

    // Filter message to only include non-error messages, error messages are only intended for the user.
    const filteredMessages = await normalizeAndApplyContext(messagesToUse);

    // Update messages with the user message first
    setExternalContextItems([]);
    setUserSelectedContextItems([]);
    // Clear the input field, attached file, and any ongoing message
    setUserInput('');
    setAttachedFile(null);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    setOngoingMessage({ type: 'text', text: '' });
    setAiState(AIState.Generating);
    let textStream;

    try {
      textStream = streamText({
        model: openrouter(pickedAgent.model),
        maxTokens: 100000,
        messages: filteredMessages,
        tools: Object.keys(toolsToUse).length > 0 ? toolsToUse : undefined,
        maxSteps: 20,
        system: systemPrompt,
        abortSignal: abortSignalRef.current.signal,
        onError: err => {
          if (InvalidToolArgumentsError.isInstance(err)) {
            // Handle the error
            console.error('Invalid tool arguments error', err);

            onNewMessage({
              role: 'error',
              content: 'LLM did not give the correct parameters to the tool',
            });
          }

          if (TypeValidationError.isInstance(err.error) && err.error.cause) {
            console.error(err.error.message);

            onNewMessage({
              role: 'error',
              content: 'Server error',
            });
          }
        },
        experimental_repairToolCall: async ({
          toolCall,
          parameterSchema,
          error,
        }) => {
          if (NoSuchToolError.isInstance(error)) {
            console.log('No such tool error', error);

            return null; // do not attempt to fix invalid tool names
          }

          console.log('arg error', error);
          console.log('Repairing tool call', toolCall.toolName);

          const { object: repairedArgs } = await generateObject({
            model: openrouter('qwen/qwq-32b:free'),
            output: 'no-schema',
            mode: 'json',
            temperature: 0.1,
            prompt: [
              `The model tried to call the tool "${toolCall.toolName}"` +
                ` with the following arguments:`,
              JSON.stringify(toolCall.args),
              `The tool accepts the following schema:`,
              JSON.stringify(parameterSchema(toolCall)),
              'Please fix the arguments.',
            ].join('\n'),
          });

          console.log('Repaired tool call', repairedArgs);

          return { ...toolCall, args: JSON.stringify(repairedArgs) };
        },
      });
    } catch (err) {
      console.error(err);
      setAiState(AIState.Stopped);

      return;
    }

    let ownOnGoingMessage: OngoingMessagePart = {
      type: 'text',
      text: '',
    };

    const pendingToolCalls: ToolCallPart[] = [];
    let isReasoning = false;

    try {
      for await (const part of textStream.fullStream) {
        // Update ongoing message with streamed chunks
        // console.log('Part', part);

        if (part.type === 'tool-call') {
          const toolCallMessage: AIChatDisplayMessage = {
            role: 'assistant',
            content: [part],
          };

          // If the llm was talking before we should display that text before the tool call.
          if (ownOnGoingMessage) {
            toolCallMessage.content = [ownOnGoingMessage, part];

            ownOnGoingMessage = {
              type: 'text',
              text: '',
            };

            setOngoingMessage(ownOnGoingMessage);
          }

          onNewMessage(toolCallMessage);

          pendingToolCalls.push(part);
        }

        // if (part.type === 'tool-result') {
        //   onNewMessage({
        //     role: 'tool',
        //     content: [part],
        //   });

        //   pendingToolCalls = pendingToolCalls.filter(
        //     call => call.toolCallId !== part.toolCallId,
        //   );
        // }

        if (part.type === 'reasoning') {
          isReasoning = true;
          ownOnGoingMessage.type = 'reasoning';
          ownOnGoingMessage.text += part.textDelta;
          setOngoingMessage({ ...ownOnGoingMessage });
        }

        if (part.type === 'text-delta') {
          if (isReasoning) {
            isReasoning = false;
            onNewMessage({
              role: 'assistant',
              content: [ownOnGoingMessage],
            });

            ownOnGoingMessage = {
              type: 'text',
              text: '',
            };

            setOngoingMessage(ownOnGoingMessage);
          }

          ownOnGoingMessage.text += part.textDelta;
          setOngoingMessage({ ...ownOnGoingMessage });
        }

        if (part.type === 'finish') {
          if (ownOnGoingMessage) {
            onNewMessage({
              role: 'assistant',
              content: [ownOnGoingMessage],
            });
          }

          setOngoingMessage({
            type: 'text',
            text: '',
          });

          if (
            part.usage &&
            part.usage.promptTokens &&
            part.usage.completionTokens
          ) {
            setTokensUsed(([prevInput, prevOutput]) => [
              prevInput + part.usage.promptTokens || 0,
              prevOutput + part.usage.completionTokens || 0,
            ]);
          }

          if (part.finishReason === 'tool-calls') {
            // We need to include all new tool calls in the check
            // Check all messages, including the ones we just added
            // const resultMessage: CoreToolMessage = {
            //   role: 'tool',
            //   content: [],
            // };
            // console.log('pendingToolCalls', pendingToolCalls);
            // setAiState(AIState.UsingTool);
            // Promise.all(
            //   pendingToolCalls.map(toolCall => {
            //     return callMPCTool(toolCall);
            //   }),
            // ).then(results => {
            //   results.forEach((result, index) => {
            //     const r = {
            //       type: 'tool-result',
            //       result: result.content[0].text,
            //       isError: result.isError,
            //       toolCallId: pendingToolCalls[index].toolCallId,
            //       toolName: pendingToolCalls[index].toolName,
            //     };
            //     console.log('result', r);
            //     resultMessage.content.push(r);
            //   });
            //   onNewMessage(prev => [...prev, resultMessage]);
            //   setHasToolResultFollowUp(true);
            // });
          } else {
            setAiState(AIState.Stopped);
          }
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleAcceptChanges = async () => {
    try {
      // Save all edited resources
      await Promise.all(
        editedResources.map(subject =>
          store.getResource(subject).then(resource => resource.save()),
        ),
      );
      // Clear the edited resources list after saving
      setEditedResources([]);
      toast.success('Changes saved successfully');
    } catch (error) {
      console.error('Error saving changes:', error);
      toast.error('Failed to save changes');
    }
  };

  useEffect(() => {
    if (hasToolResultFollowUp) {
      setHasToolResultFollowUp(false);
      sendMessage(true);
    }
  }, [hasToolResultFollowUp]);

  // Combine both context item lists when needed
  const allContextItems = [
    ...externalContextItems,
    ...userSelectedContextItems,
  ];

  const handleSubmit = () => {
    requestAnimationFrame(() => {
      sendMessage();
    });
  };

  return (
    <ChatWindow fullView={fullView}>
      {children}
      <ChatMessagesContainer
        enableAutoScroll={aiState !== AIState.Stopped}
        fullView={fullView}
      >
        {messages.filter(cleanMessages).map(message => (
          <AIChatMessage key={JSON.stringify(message)} message={message} />
        ))}
        {ongoingMessage.text && (
          <AIChatMessage
            message={{ role: 'assistant', content: [ongoingMessage] }}
          />
        )}
      </ChatMessagesContainer>
      <Column>
        {aiState !== AIState.Stopped && (
          <Row center gap='0.2ch'>
            <GeneratingIndicator state={aiState} />
            <IconButton
              title='Stop generating'
              onClick={() => {
                abortSignalRef.current?.abort();
              }}
            >
              <FaXmark />
            </IconButton>
          </Row>
        )}
        {!readonly && (
          <>
            <ChatInputWrapper>
              <Column fullWidth gap='none' style={{ position: 'relative' }}>
                <FloatingChatWidgetsContainer>
                  {editedResources.length > 0 && (
                    <UnsavedChangesIndicator>
                      <Row center gap='1ch' justify='flex-end'>
                        <span>Unsaved changes</span>
                        <AcceptButton onClick={handleAcceptChanges}>
                          <FaCheck />
                          <span>Accept</span>
                        </AcceptButton>
                      </Row>
                    </UnsavedChangesIndicator>
                  )}
                  {attachedFile && (
                    <AttachmentPreview>
                      <Row gap='1ch' center>
                        <FaFile />
                        <span>{attachedFile.name}</span>
                      </Row>
                      <IconButton
                        title='Remove file'
                        onClick={removeAttachedFile}
                        size='small'
                      >
                        <FaXmark />
                      </IconButton>
                    </AttachmentPreview>
                  )}
                </FloatingChatWidgetsContainer>
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
                <AIChatInput
                  onMentionUpdate={(mentions: string[]) => {
                    // Convert mentions to context items
                    const newContextItems = mentions.map(subject => ({
                      type: 'resource' as const,
                      id: crypto.randomUUID(),
                      subject,
                    }));
                    setUserSelectedContextItems(newContextItems);
                  }}
                  onChange={setUserInput}
                  onSubmit={handleSubmit}
                />
                <Row justify='space-between'>
                  <Row gap='0.5rem'>
                    <SubtleButton onClick={() => setAgentConfigOpen(true)}>
                      {autoAgentSelectEnabled
                        ? 'Automatic'
                        : selectedAgent.name}
                    </SubtleButton>
                    <input
                      type='file'
                      ref={fileInputRef}
                      onChange={handleFileUpload}
                      style={{ display: 'none' }}
                    />
                    <IconButton
                      title='Attach file'
                      onClick={() => fileInputRef.current?.click()}
                      color='textLight'
                    >
                      <FaPaperclip />
                    </IconButton>
                  </Row>
                  <IconButton
                    disabled={userInput.length === 0 && !attachedFile}
                    onClick={() => sendMessage()}
                    title='Send'
                    variant={IconButtonVariant.Fill}
                  >
                    <FaArrowRight />
                  </IconButton>
                </Row>
              </Column>
              <NoKeyOverlay />
            </ChatInputWrapper>
            <TokensUsed>
              Tokens used: {tokensUsed[0]} input, {tokensUsed[1]} output
            </TokensUsed>
          </>
        )}
      </Column>

      {/* Agent configuration dialog */}
      <AgentConfig
        open={agentConfigOpen}
        onOpenChange={setAgentConfigOpen}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
      />
    </ChatWindow>
  );
};

/**
 * Prepares a user message with optional file attachment
 */
const prepareUserMessage = (
  inputText: string,
  fileAttachment: FileAttachment | null,
  contextItems: AIMessageContext[],
): AIChatDisplayMessage => {
  const wrapWithContext = (message: CoreMessage): AIChatDisplayMessage => {
    if (contextItems.length === 0) {
      return message;
    }

    return {
      role: 'annotated-message',
      message,
      context: contextItems,
    };
  };

  if (fileAttachment) {
    // Create an ImagePart for the image file
    const filePart: ImagePart | FilePart = fileAttachment.isImage
      ? {
          type: 'image',
          image: `data:${fileAttachment.type};base64,${fileAttachment.base64Content}`,
          mimeType: fileAttachment.type,
        }
      : {
          type: 'file',
          data: `data:${fileAttachment.type};base64,${fileAttachment.base64Content}`,
          mimeType: fileAttachment.type,
        };

    // Create a message with text and image content
    const newMessage: AIChatDisplayMessage = {
      role: 'user',
      content: inputText
        ? [{ type: 'text', text: inputText }, filePart]
        : [filePart],
    };

    return wrapWithContext(newMessage);
  } else {
    // No file, just text
    return wrapWithContext({ role: 'user', content: inputText });
  }
};

const cleanMessages = (m: AIChatDisplayMessage) => {
  const content = isMessageWithContext(m) ? m.message.content : m.content;

  if (content.length === 0) return false;

  if (Array.isArray(content)) {
    if (
      content.length === 1 &&
      typeof content !== 'string' &&
      'text' in content[0] &&
      content[0].text === ''
    )
      return false;
  }

  return true;
};

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
  background-color: ${p => p.theme.colors.bg1};
  padding: ${p => p.theme.size(1)};
  border-radius: ${p => p.theme.radius};
  font-size: 0.8rem;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
`;

const ChatWindow = styled.div<{ fullView?: boolean }>`
  padding-top: ${p => (p.fullView ? p.theme.size(2) : 0)};
  position: relative;
  display: grid;
  grid-template-rows: auto 1fr auto;
  height: 90vh;
  width: min(100%, 40rem);
  margin-inline: auto;
  gap: 1rem;

  pre {
    white-space: pre-wrap;
    word-break: break-word;
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

// New styled components for the Unsaved Changes indicator
const UnsavedChangesIndicator = styled.div`
  color: ${p => p.theme.colors.text};
  padding: ${p => p.theme.size(1)} ${p => p.theme.size(2)};
  border-radius: ${p => p.theme.radius};
  font-size: 0.85rem;
`;

const AcceptButton = styled(Button)`
  padding: ${p => p.theme.size(1)} ${p => p.theme.size(2)};
  font-size: 0.75rem;
`;

const FloatingChatWidgetsContainer = styled.div`
  display: flex;
  flex-direction: column;
  height: fit-content;
  gap: ${p => p.theme.size(2)};
  position: absolute;
  width: 100%;
  bottom: calc(100% + ${p => p.theme.size(2)});
  left: 0;
  right: 0;
  z-index: 10;
`;

const ContextItemRow = styled(Row)`
  padding-inline: ${p => p.theme.size(2)};
`;
