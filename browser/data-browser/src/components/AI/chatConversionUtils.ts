import {
  type Resource,
  type Ai,
  type Store,
  ai,
  core,
  server,
} from '@tomic/react';
import type {
  FilePart,
  ImagePart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from 'ai';
import { newContextItem } from './AISidebarContext';
import { type AIChatDisplayMessage, isMessageWithContext } from './types';

// Not exported from 'ai' for some reason, for now we need to define it ourselves.
type ReasoningPart = {
  type: 'reasoning';
  text: string;
  signature?: string;
};

const TAG_TO_ROLE_MAPPING = {
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/user': 'user',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/assistant':
    'assistant',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/system': 'system',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/tool': 'tool',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/error': 'error',
} as const;

const roleToTagMapping = Object.fromEntries(
  Object.entries(TAG_TO_ROLE_MAPPING).map(([tag, role]) => [role, tag]),
);

export const displayMessageToResource = async (
  message: AIChatDisplayMessage,
  parent: Resource<Ai.AiChat>,
  store: Store,
  context?: string[],
): Promise<Resource<Ai.AiMessage>> => {
  if (isMessageWithContext(message)) {
    // TODO: Add context to the resource
    const contextSubjects = message.context.map(c => c.subject);

    return displayMessageToResource(
      message.message,
      parent,
      store,
      contextSubjects,
    );
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

export const messageResourcesToDisplayMessages = async (
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

const tagToRole = (subject: string) => {
  const tag = TAG_TO_ROLE_MAPPING[subject as keyof typeof TAG_TO_ROLE_MAPPING];

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

const toToolCallPart = (resource: Resource<Ai.ToolCallPart>): ToolCallPart => {
  let args = resource.props.toolArguments;

  try {
    args = JSON.parse(resource.props.toolArguments);
  } catch (e) {
    // Arguments are not a json object.
  }

  return {
    type: 'tool-call',
    toolName: resource.props.toolName,
    toolCallId: resource.props.toolId,
    args,
  };
};

const toToolResultPart = (
  resource: Resource<Ai.ToolResultPart>,
): ToolResultPart => {
  let result = resource.props.toolResult;

  try {
    result = JSON.parse(resource.props.toolResult);
  } catch (e) {
    // Result is not a json object.
  }

  return {
    type: 'tool-result',
    toolName: resource.props.toolName,
    toolCallId: resource.props.toolId,
    result,
    isError: resource.props.toolResultIsError,
  };
};

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
        [ai.properties.toolResult]:
          typeof toolResultPart.result === 'string'
            ? toolResultPart.result
            : JSON.stringify(toolResultPart.result),
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
