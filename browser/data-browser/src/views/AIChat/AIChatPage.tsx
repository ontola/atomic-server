import { useEffect, useState } from 'react';
import { SimpleAIChat } from '../../components/AI/SimpleAIChat';
import {
  ai,
  core,
  server,
  useArray,
  useCanWrite,
  useStore,
  useTitle,
  Ai,
  type Resource,
  type Store,
} from '@tomic/react';
import type {
  FilePart,
  ImagePart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from 'ai';
import type { ResourcePageProps } from '../ResourcePage';
import toast from 'react-hot-toast';
import {
  type AIChatDisplayMessage,
  type AIMessageContext,
  isMessageWithContext,
} from '../../components/AI/types';
import { Row } from '../../components/Row';
import { EditableTitle } from '../../components/EditableTitle';
import { newContextItem } from '../../components/AI/AISidebarContext';
import { DEFAULT_AICHAT_NAME } from '../../components/AI/aiContstants';
import { useGenerativeData } from '../../components/AI/useGenerativeData';

// Not exported from 'ai' for some reason, for now we need to define it ourselves.
type ReasoningPart = {
  type: 'reasoning';
  text: string;
  signature?: string;
};

export const AIChatPage: React.FC<ResourcePageProps> = ({ resource }) => {
  const store = useStore();
  const [messages, setMessages] = useState<AIChatDisplayMessage[]>([]);
  const [contextItems, setContextItems] = useState<AIMessageContext[]>([]);
  const [messageSubjects] = useArray(resource, ai.properties.messages, {
    commit: true,
  });
  const [title, setTitle] = useTitle(resource);

  const canWrite = useCanWrite(resource);
  const { generateTitleFromConversation } = useGenerativeData();

  const addNewMessage = async (message: AIChatDisplayMessage) => {
    console.log('addNewMessage', message);
    setMessages(prev => [...prev, message]);

    try {
      const messageResource = await messageToResource(message, resource, store);
      resource.push(ai.properties.messages, [messageResource.subject]);
      await resource.save();
    } catch (error) {
      console.error(error);
      toast.error('Failed to create message resource');
    }
  };

  // On load create AIChatDisplayMessages from the resource's messages.
  useEffect(() => {
    messageResourcesToDisplayMessages(messageSubjects, store).then(setMessages);
  }, []);

  useEffect(() => {
    if (messages.length === 2 && title === DEFAULT_AICHAT_NAME) {
      generateTitleFromConversation(messages).then(setTitle);
    }
  }, [messages, title]);

  return (
    <SimpleAIChat
      fullView
      messages={messages}
      onNewMessage={addNewMessage}
      readonly={!canWrite}
      externalContextItems={contextItems}
      setExternalContextItems={setContextItems}
    >
      <Row>
        <EditableTitle resource={resource} />
      </Row>
    </SimpleAIChat>
  );
};

const messageToResource = async (
  message: AIChatDisplayMessage,
  parent: Resource<Ai.AiChat>,
  store: Store,
  context?: string[],
): Promise<Resource<Ai.AiMessage>> => {
  if (isMessageWithContext(message)) {
    // TODO: Add context to the resource
    const contextSubjects = message.context.map(c => c.subject);

    return messageToResource(message.message, parent, store, contextSubjects);
  }

  const messageResource = await store.newResource<Ai.AiMessage>({
    isA: ai.classes.aiMessage,
    parent: parent.subject,
    propVals: {
      [ai.properties.role]: roleToTag(message.role),
    },
  });

  if (context && context.length > 0) {
    messageResource.props.providedContext = context;
  }

  if (typeof message.content === 'string') {
    const textPart = await store.newResource<Ai.TextPart>({
      isA: ai.classes.textPart,
      parent: messageResource.subject,
      propVals: {
        [core.properties.description]: message.content,
      },
    });

    await textPart.save();
    messageResource.push(ai.properties.content, [textPart.subject]);
  } else {
    const builder = partsToResourceBuilder(messageResource, store);
    const partResources = await Promise.all(
      message.content.map(content => {
        switch (content.type) {
          case 'file':
          case 'image':
            return builder.filePartToResource(content);
          case 'text':
            return builder.textPartToResource(content);
          case 'reasoning':
            return builder.reasoningPartToResource(content);
          case 'tool-call':
            return builder.toolCallPartToResource(content);
          case 'tool-result':
            return builder.toolResultPartToResource(content);
          default:
            throw new Error(`Unknown content type: ${content.type}`);
        }
      }),
    );

    for (const partResource of partResources) {
      await partResource.save();
      messageResource.push(ai.properties.content, [partResource.subject]);
    }
  }

  await messageResource.save();

  return messageResource;
};

const messageResourcesToDisplayMessages = async (
  subjects: string[],
  store: Store,
): Promise<AIChatDisplayMessage[]> => {
  const resources = await Promise.all(
    subjects.map(s => store.getResource<Ai.AiMessage>(s)),
  );

  const messages: AIChatDisplayMessage[] = [];

  for (const resource of resources) {
    if (resource.error) {
      throw resource.error;
    }

    const role = tagToRole(resource.props.role);
    const contentResources = await Promise.all(
      resource.props.content.map(s => store.getResource(s)),
    );

    let message: AIChatDisplayMessage | undefined;

    if (role === 'user') {
      message = {
        role,
        content: contentResources.map(r => {
          if (resourceIsFilePart(r)) {
            return toFilePart(r);
          }

          if (resourceIsTextPart(r)) {
            return toTextPart(r);
          }

          throw new Error(
            `Content with class ${r.getClasses()} not supported on role: user`,
          );
        }),
      };

      if (resource.props.providedContext) {
        message = {
          role: 'annotated-message',
          message,
          context: resource.props.providedContext.map(c =>
            newContextItem({
              subject: c,
              type: 'resource',
            }),
          ),
        };
      }
    }

    if (role === 'assistant') {
      message = {
        role,
        content: contentResources.map(r => {
          if (resourceIsReasoningPart(r)) {
            return toReasoningPart(r);
          }

          if (resourceIsTextPart(r)) {
            return toTextPart(r);
          }

          if (resourceIsToolCallPart(r)) {
            return toToolCallPart(r);
          }

          throw new Error(
            `Content with class ${r.getClasses()} not supported on role: assistant`,
          );
        }),
      };
    }

    if (role === 'system') {
      const contentResource = contentResources[0];

      if (!resourceIsTextPart(contentResource)) {
        throw new Error(
          `Content with class ${contentResource.getClasses()} not supported on role: system`,
        );
      }

      message = {
        role,
        content: contentResource.props.description,
      };
    }

    if (role === 'tool') {
      message = {
        role,
        content: contentResources.map(r => {
          if (resourceIsToolResultPart(r)) {
            return toToolResultPart(r);
          }

          throw new Error(
            `Content with class ${r.getClasses()} not supported on role: tool`,
          );
        }),
      };
    }

    if (role === 'error') {
      const contentResource = contentResources[0];

      if (!resourceIsTextPart(contentResource)) {
        throw new Error(
          `Content with class ${contentResource.getClasses()} not supported on role: error`,
        );
      }

      message = {
        role,
        content: contentResource.props.description,
      };
    }

    if (message) {
      messages.push(message);
    }
  }

  return messages;
};

const tagToRoleMapping = {
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/user': 'user',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/assistant':
    'assistant',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/system': 'system',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/tool': 'tool',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/error': 'error',
} as const;

const roleToTagMapping = Object.fromEntries(
  Object.entries(tagToRoleMapping).map(([tag, role]) => [role, tag]),
);

const tagToRole = (subject: string) => {
  const tag = tagToRoleMapping[subject as keyof typeof tagToRoleMapping];

  if (!tag) {
    throw new Error(`Unknown message role: ${subject}`);
  }

  return tag;
};

const roleToTag = (role: string) => {
  const tag = roleToTagMapping[role as keyof typeof roleToTagMapping];

  if (!tag) {
    throw new Error(`Unknown message role: ${role}`);
  }

  return tag;
};

const toFilePart = (resource: Resource<Ai.FilePart>): FilePart | ImagePart => {
  if (resource.props.mimetype?.startsWith('image/')) {
    return {
      type: 'image',
      image: resource.props.data,
      mimeType: resource.props.mimetype,
    };
  }

  return {
    type: 'file',
    data: resource.props.data,
    filename: resource.props.filename,
    mimeType: resource.props.mimetype!,
  };
};

const toTextPart = (resource: Resource<Ai.TextPart>): TextPart => ({
  type: 'text',
  text: resource.props.description,
});

const toReasoningPart = (
  resource: Resource<Ai.ReasoningPart>,
): ReasoningPart => ({
  type: 'reasoning',
  text: resource.props.description,
  signature: resource.props.reasoningSignature,
});

const toToolCallPart = (resource: Resource<Ai.ToolCallPart>): ToolCallPart => ({
  type: 'tool-call',
  toolName: resource.props.toolName,
  toolCallId: resource.props.toolId,
  args: resource.props.toolArguments,
});

const toToolResultPart = (
  resource: Resource<Ai.ToolResultPart>,
): ToolResultPart => ({
  type: 'tool-result',
  toolName: resource.props.toolName,
  toolCallId: resource.props.toolId,
  result: resource.props.toolResult,
  isError: resource.props.toolResultIsError,
});

const partsToResourceBuilder = (
  parent: Resource<Ai.AiMessage>,
  store: Store,
) => ({
  async filePartToResource(filePart: FilePart | ImagePart) {
    const data = filePart.type === 'file' ? filePart.data : filePart.image;

    if (typeof data !== 'string') {
      throw new Error('Incompatible file data.');
    }

    return await store.newResource<Ai.FilePart>({
      isA: ai.classes.filePart,
      parent: parent.subject,
      propVals: {
        [ai.properties.data]: data,
        [server.properties.mimetype]: filePart.mimeType,
        ...(filePart.type === 'file'
          ? {
              [server.properties.filename]: filePart.filename,
            }
          : {}),
      },
    });
  },
  async textPartToResource(textPart: TextPart) {
    return await store.newResource<Ai.TextPart>({
      isA: ai.classes.textPart,
      parent: parent.subject,
      propVals: { [core.properties.description]: textPart.text },
    });
  },
  async reasoningPartToResource(reasoningPart: ReasoningPart) {
    return await store.newResource<Ai.ReasoningPart>({
      isA: ai.classes.reasoningPart,
      parent: parent.subject,
      propVals: { [core.properties.description]: reasoningPart.text },
    });
  },
  async toolCallPartToResource(toolCallPart: ToolCallPart) {
    return await store.newResource<Ai.ToolCallPart>({
      isA: ai.classes.toolCallPart,
      parent: parent.subject,
      propVals: {
        [ai.properties.toolName]: toolCallPart.toolName,
        [ai.properties.toolId]: toolCallPart.toolCallId,
        [ai.properties.toolArguments]: JSON.stringify(toolCallPart.args),
      },
    });
  },
  async toolResultPartToResource(toolResultPart: ToolResultPart) {
    return await store.newResource<Ai.ToolResultPart>({
      isA: ai.classes.toolResultPart,
      parent: parent.subject,
      propVals: {
        [ai.properties.toolName]: toolResultPart.toolName,
        [ai.properties.toolId]: toolResultPart.toolCallId,
        [ai.properties.toolResult]: JSON.stringify(toolResultPart.result),
        [ai.properties.toolResultIsError]: !!toolResultPart.isError,
      },
    });
  },
});

const resourceIsFilePart = (
  resource: Resource,
): resource is Resource<Ai.FilePart> =>
  resource.hasClasses(ai.classes.filePart);

const resourceIsTextPart = (
  resource: Resource,
): resource is Resource<Ai.TextPart> =>
  resource.hasClasses(ai.classes.textPart);

const resourceIsReasoningPart = (
  resource: Resource,
): resource is Resource<Ai.ReasoningPart> =>
  resource.hasClasses(ai.classes.reasoningPart);

const resourceIsToolCallPart = (
  resource: Resource,
): resource is Resource<Ai.ToolCallPart> =>
  resource.hasClasses(ai.classes.toolCallPart);

const resourceIsToolResultPart = (
  resource: Resource,
): resource is Resource<Ai.ToolResultPart> =>
  resource.hasClasses(ai.classes.toolResultPart);
