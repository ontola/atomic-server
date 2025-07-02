/* -----------------------------------
 * GENERATED WITH @tomic/cli
 * For more info on how to use ontologies: https://github.com/atomicdata-dev/atomic-server/blob/develop/browser/cli/readme.md
 * -------------------------------- */

import type { OntologyBaseObject, BaseProps } from '../index.js';

export const ai = {
  classes: {
    aiChat: 'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/ai-chat',
    aiMessage:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/ai-message',
    filePart:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/file-part',
    mcpResource:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/mcp-resource',
    reasoningPart:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/reasoning-part',
    textPart:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/text-part',
    toolCallPart:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/tool-call-part',
    toolResultPart:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/tool-result-part',
  },
  properties: {
    content:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/content',
    data: 'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/data',
    mcpServerId:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/mcp-server-id',
    mcpUri:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/mcp-uri',
    messages:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/messages',
    providedContext:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/provided-context',
    reasoningSignature:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/reasoning-signature',
    role: 'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/role',
    toolArguments:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/tool-arguments',
    toolId:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/tool-id',
    toolName:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/tool-name',
    toolResult:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/tool-result',
    toolResultIsError:
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/tool-result-is-error',
  },
  __classDefs: {
    ['https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/ai-chat']: [
      'https://atomicdata.dev/properties/name',
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/messages',
    ],
    ['https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/ai-message']: [
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/role',
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/content',
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/provided-context',
    ],
    ['https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/file-part']: [
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/data',
      'https://atomicdata.dev/properties/mimetype',
      'https://atomicdata.dev/properties/filename',
    ],
    ['https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/mcp-resource']: [
      'https://atomicdata.dev/properties/name',
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/mcp-uri',
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/mcp-server-id',
      'https://atomicdata.dev/properties/mimetype',
      'https://atomicdata.dev/properties/description',
    ],
    ['https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/reasoning-part']:
      [
        'https://atomicdata.dev/properties/description',
        'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/reasoning-signature',
      ],
    ['https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/text-part']: [
      'https://atomicdata.dev/properties/description',
    ],
    ['https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/tool-call-part']:
      [
        'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/tool-id',
        'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/tool-name',
        'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/tool-arguments',
      ],
    ['https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/tool-result-part']:
      [
        'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/tool-id',
        'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/tool-name',
        'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/tool-result',
        'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/property/tool-result-is-error',
      ],
  },
} as const satisfies OntologyBaseObject;

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Ai {
  export type AiChat = typeof ai.classes.aiChat;
  export type AiMessage = typeof ai.classes.aiMessage;
  export type FilePart = typeof ai.classes.filePart;
  export type McpResource = typeof ai.classes.mcpResource;
  export type ReasoningPart = typeof ai.classes.reasoningPart;
  export type TextPart = typeof ai.classes.textPart;
  export type ToolCallPart = typeof ai.classes.toolCallPart;
  export type ToolResultPart = typeof ai.classes.toolResultPart;
}

declare module '../index.js' {
  interface Classes {
    [ai.classes.aiChat]: {
      requires: BaseProps | 'https://atomicdata.dev/properties/name';
      recommends: typeof ai.properties.messages;
    };
    [ai.classes.aiMessage]: {
      requires:
        | BaseProps
        | typeof ai.properties.role
        | typeof ai.properties.content;
      recommends: typeof ai.properties.providedContext;
    };
    [ai.classes.filePart]: {
      requires: BaseProps | typeof ai.properties.data;
      recommends:
        | 'https://atomicdata.dev/properties/mimetype'
        | 'https://atomicdata.dev/properties/filename';
    };
    [ai.classes.mcpResource]: {
      requires:
        | BaseProps
        | 'https://atomicdata.dev/properties/name'
        | typeof ai.properties.mcpUri
        | typeof ai.properties.mcpServerId;
      recommends:
        | 'https://atomicdata.dev/properties/mimetype'
        | 'https://atomicdata.dev/properties/description';
    };
    [ai.classes.reasoningPart]: {
      requires: BaseProps | 'https://atomicdata.dev/properties/description';
      recommends: typeof ai.properties.reasoningSignature;
    };
    [ai.classes.textPart]: {
      requires: BaseProps | 'https://atomicdata.dev/properties/description';
      recommends: never;
    };
    [ai.classes.toolCallPart]: {
      requires:
        | BaseProps
        | typeof ai.properties.toolId
        | typeof ai.properties.toolName
        | typeof ai.properties.toolArguments;
      recommends: never;
    };
    [ai.classes.toolResultPart]: {
      requires:
        | BaseProps
        | typeof ai.properties.toolId
        | typeof ai.properties.toolName
        | typeof ai.properties.toolResult;
      recommends: typeof ai.properties.toolResultIsError;
    };
  }

  interface PropTypeMapping {
    [ai.properties.content]: string[];
    [ai.properties.data]: string;
    [ai.properties.mcpServerId]: string;
    [ai.properties.mcpUri]: string;
    [ai.properties.messages]: string[];
    [ai.properties.providedContext]: string[];
    [ai.properties.reasoningSignature]: string;
    [ai.properties.role]: string;
    [ai.properties.toolArguments]: string;
    [ai.properties.toolId]: string;
    [ai.properties.toolName]: string;
    [ai.properties.toolResult]: string;
    [ai.properties.toolResultIsError]: boolean;
  }

  interface PropSubjectToNameMapping {
    [ai.properties.content]: 'content';
    [ai.properties.data]: 'data';
    [ai.properties.mcpServerId]: 'mcpServerId';
    [ai.properties.mcpUri]: 'mcpUri';
    [ai.properties.messages]: 'messages';
    [ai.properties.providedContext]: 'providedContext';
    [ai.properties.reasoningSignature]: 'reasoningSignature';
    [ai.properties.role]: 'role';
    [ai.properties.toolArguments]: 'toolArguments';
    [ai.properties.toolId]: 'toolId';
    [ai.properties.toolName]: 'toolName';
    [ai.properties.toolResult]: 'toolResult';
    [ai.properties.toolResultIsError]: 'toolResultIsError';
  }
}
