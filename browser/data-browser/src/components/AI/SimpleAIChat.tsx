import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../../helpers/AppSettings';
import { Column, Row } from '../Row';
import toast from 'react-hot-toast';
import { useAtomicMCPTools } from './useAtomicTools';
import {
  AIChatMessage,
  isMessageWithContext,
  normalizeMessageForAPIIngestion,
  type AIChatDisplayMessage,
} from './AIChatMessage';
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
  FaPlus,
  FaXmark,
  FaPaperclip,
  FaFile,
  FaCheck,
} from 'react-icons/fa6';
import { ChatMessagesContainer } from './ChatMessagesContainer';
import { useStore } from '@tomic/react';
import { AIAgent, AIState, type AIMessageContext } from './types';
import {
  AgentConfig,
  useAIAgentConfig,
  useAutoAgentSelect,
} from './AgentConfig';
import { Button } from '../Button';
import { useContextDataForAgent } from './useContextForAgent';
import { newContextItem, useAISidebar } from './AISidebarContext';
import { MessageContextItem } from './MessageContextItem';
import { useCurrentSubject } from '../../helpers/useCurrentSubject';

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

export const SimpleAIChat = () => {
  const { setIsOpen: setSidebarOpen, isOpen } = useAISidebar();
  const abortSignalRef = useRef<AbortController>(null);
  const [aiState, setAiState] = useState<AIState>(AIState.Stopped);
  const [editedResources, setEditedResources] = useState<string[]>([]);
  const { agents, autoAgentSelectEnabled } = useAIAgentConfig();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachedFile, setAttachedFile] = useState<FileAttachment | null>(null);
  const store = useStore();
  const { contextItems, setContextItems } = useAISidebar();
  const [selectedAgent, setSelectedAgent] = useState<AIAgent>(agents[0]);
  const [userInput, setUserInput] = useState('');
  const { openRouterApiKey } = useSettings() as { openRouterApiKey?: string };
  const openrouter = createOpenRouter({
    apiKey: openRouterApiKey,
    compatibility: 'strict',
  });
  const [messages, setMessages] = useState<AIChatDisplayMessage[]>([]);
  const [ongoingMessage, setOngoingMessage] = useState<OngoingMessagePart>({
    type: 'text',
    text: '',
  });
  const [tokensUsed, setTokensUsed] = useState<[number, number]>([0, 0]);
  // Google models do not support tools with enum parameters for now.
  // TODO: Remove this once we have a model that supports tools with enum parameters
  const getToolsForAgent = useTools();
  const [hasToolResultFollowUp, setHasToolResultFollowUp] = useState(false);
  const { injectContextIntoPrompt, addExtraContextToMessage } =
    useContextDataForAgent();
  const [agentConfigOpen, setAgentConfigOpen] = useState(false);
  const pickAgent = useAutoAgentSelect();
  const [currentSubject] = useCurrentSubject();

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

    console.log('toolsToUse', toolsToUse);

    let input = userInput;

    if (contextItems.length > 0) {
      input = await addExtraContextToMessage(input, contextItems);
    }

    if (!isFollowUp) {
      messagesToUse = prepareUserMessage(
        messages,
        input,
        attachedFile,
        contextItems,
      );
    } else {
      messagesToUse = messages;
    }

    // Filter message to only include non-error messages, error messages are only intended for the user.
    const filteredMessages = normalizeMessageForAPIIngestion(messagesToUse);

    // Update messages with the user message first
    setMessages(messagesToUse);
    setContextItems([]);
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
            console.log('Invalid tool arguments error', err);

            setMessages(prev => [
              ...prev,
              {
                role: 'error',
                content: 'LLM did not give the correct parameters to the tool',
              },
            ]);
          }

          if (TypeValidationError.isInstance(err.error) && err.error.cause) {
            console.error(err.error.message);

            setMessages(prev => [
              ...prev,
              {
                role: 'error',
                content: 'Server error',
              },
            ]);
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
          // const tool = tools[toolCall.toolName as keyof typeof tools];

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

    let pendingToolCalls: ToolCallPart[] = [];
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

          setMessages(prev => [...prev, toolCallMessage]);

          pendingToolCalls.push(part);
        }

        if (part.type === 'tool-result') {
          setMessages(prev => [
            ...prev,
            {
              role: 'tool',
              content: [part],
            },
          ]);

          pendingToolCalls = pendingToolCalls.filter(
            call => call.toolCallId !== part.toolCallId,
          );
        }

        if (part.type === 'reasoning') {
          isReasoning = true;
          ownOnGoingMessage.type = 'reasoning';
          ownOnGoingMessage.text += part.textDelta;
          setOngoingMessage({ ...ownOnGoingMessage });
        }

        if (part.type === 'text-delta') {
          if (isReasoning) {
            isReasoning = false;
            setMessages(prev => [
              ...prev,
              {
                role: 'assistant',
                content: [ownOnGoingMessage],
              },
            ]);

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
          console.log('Stream finished', part);

          if (ownOnGoingMessage) {
            setMessages(prev => [
              ...prev,
              {
                role: 'assistant',
                content: [ownOnGoingMessage],
              },
            ]);
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
            //   setMessages(prev => [...prev, resultMessage]);
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

  useEffect(() => {
    // When the user opens the AI sidebar and the chat is completely empty, we add the current subject to the context.
    if (
      isOpen &&
      currentSubject &&
      messages.length === 0 &&
      userInput.length === 0 &&
      contextItems.length === 0
    ) {
      setContextItems([
        newContextItem({
          type: 'resource',
          subject: currentSubject,
        }),
      ]);
    }
  }, [isOpen, currentSubject]);

  return (
    <ChatWindow>
      <Row center justify='space-between' fullWidth>
        <Row center gap='1ch'>
          <IconButton
            title='Reset'
            onClick={() => setMessages([])}
            color='textLight'
            style={{ alignSelf: 'flex-end' }}
          >
            <FaPlus />
          </IconButton>
          <Heading>Atomic Assistant</Heading>
        </Row>
        <IconButton
          title='Close AI Sidebar'
          color='textLight'
          style={{ alignSelf: 'flex-end' }}
          onClick={() => {
            abortSignalRef.current?.abort();
            setSidebarOpen(false);
          }}
        >
          <FaXmark />
        </IconButton>
      </Row>
      <ChatMessagesContainer enableAutoScroll={aiState !== AIState.Stopped}>
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
        <Row fullWidth>
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
                {contextItems.map(item => (
                  <MessageContextItem
                    key={item.subject}
                    contextItem={item}
                    onRemove={() =>
                      setContextItems(prev =>
                        prev.filter(i => i.id !== item.id),
                      )
                    }
                  />
                ))}
              </ContextItemRow>
              <StyledTextarea
                value={userInput}
                placeholder='Ask me anything...'
                onChange={e => setUserInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                style={{ flex: 1 }}
              />
              <Row justify='space-between'>
                <Row gap='0.5rem'>
                  <SubtleButton onClick={() => setAgentConfigOpen(true)}>
                    {autoAgentSelectEnabled ? 'Automatic' : selectedAgent.name}
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
          </ChatInputWrapper>
        </Row>
        <TokensUsed>
          Tokens used: {tokensUsed[0]} input, {tokensUsed[1]} output
        </TokensUsed>
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
  existingMessages: AIChatDisplayMessage[],
  inputText: string,
  fileAttachment: FileAttachment | null,
  contextItems: AIMessageContext[],
): AIChatDisplayMessage[] => {
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

    return [...existingMessages, wrapWithContext(newMessage)];
  } else {
    // No file, just text
    return [
      ...existingMessages,
      wrapWithContext({ role: 'user', content: inputText }),
    ];
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

const StyledTextarea = styled.textarea`
  appearance: none;
  border: none;
  outline: none;
  resize: none;
  font-size: 16px;
  line-height: 1.5;
  padding: ${p => p.theme.size(2)};
`;

const ChatWindow = styled.div`
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

const Heading = styled.h2`
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: ${p => p.theme.size(2)};
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
