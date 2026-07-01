// @wc-ignore-file
import { getStaticToolName, isStaticToolUIPart, type ToolUIPart } from 'ai';
import {
  type AIMessageContext,
  type AtomicUIMessage,
  type MessageMetadata,
} from './types';

export type SummaryConversationMessage = {
  role: 'user' | 'assistant' | 'system';
  parts: { type: 'text'; text: string }[];
};

/** Max characters per tool output blob passed to the summarizer. */
export const MAX_TOOL_OUTPUT_CHARS = 6_000;

/** Max characters of RAG / server context embedded per message. */
export const MAX_SERVER_CONTEXT_CHARS = 8_000;

/** Max JSON length for the full conversation payload sent to the summarizer. */
export const MAX_CONVERSATION_JSON_CHARS = 120_000;

const MIN_MESSAGES_AFTER_CAP = 2;

export function prepareConversationForSummary(
  conversation: AtomicUIMessage[],
): SummaryConversationMessage[] {
  const prepared = conversation
    .map(messageToSummaryMessage)
    .filter(
      (message): message is SummaryConversationMessage => message !== null,
    );

  return capPreparedConversation(prepared);
}

function messageToSummaryMessage(
  message: AtomicUIMessage,
): SummaryConversationMessage | null {
  const parts: { type: 'text'; text: string }[] = [];

  const metadataContext = formatMessageMetadataContext(message.metadata);

  if (metadataContext) {
    parts.push({ type: 'text', text: metadataContext });
  }

  for (const part of message.parts) {
    if (part.type === 'text' && part.text.length > 0) {
      parts.push({ type: 'text', text: part.text });
      continue;
    }

    if (part.type === 'file') {
      const label = part.filename ?? 'unnamed';
      const mime = part.mediaType ?? 'unknown';
      parts.push({
        type: 'text',
        text: `[attachment: ${label} (${mime})]`,
      });
      continue;
    }

    if (part.type === 'source-url') {
      const title = part.title?.trim();
      parts.push({
        type: 'text',
        text: title
          ? `[source: ${title} — ${part.url}]`
          : `[source: ${part.url}]`,
      });
      continue;
    }

    if (isStaticToolUIPart(part)) {
      const toolText = formatToolPartForSummary(part);

      if (toolText) {
        parts.push({ type: 'text', text: toolText });
      }
    }
  }

  if (parts.length === 0) {
    return null;
  }

  return {
    role: message.role,
    parts,
  };
}

function formatToolPartForSummary(part: ToolUIPart): string | undefined {
  const toolName = getStaticToolName(part);
  const lines = [`[tool-call: ${toolName} (${part.state})]`];

  if ('input' in part && part.input !== undefined) {
    lines.push(
      `input: ${serializeForSummary(part.input, MAX_TOOL_OUTPUT_CHARS)}`,
    );
  }

  if (
    part.state === 'output-available' &&
    'output' in part &&
    part.output !== undefined
  ) {
    lines.push(
      `output: ${serializeForSummary(part.output, MAX_TOOL_OUTPUT_CHARS)}`,
    );
  }

  if (part.state === 'output-error') {
    const errorText =
      'errorText' in part && typeof part.errorText === 'string'
        ? part.errorText
        : 'Tool call failed';
    lines.push(`error: ${truncateText(errorText, 2_000)}`);
  }

  return lines.join('\n');
}

export function formatMessageMetadataContext(
  metadata?: MessageMetadata,
): string | undefined {
  if (!metadata) {
    return undefined;
  }

  const lines: string[] = [];

  if (metadata.userContext?.length) {
    for (const ctx of metadata.userContext) {
      lines.push(formatContextItem(ctx));
    }
  }

  if (metadata.serverContext?.trim()) {
    const rag = truncateText(
      metadata.serverContext.trim(),
      MAX_SERVER_CONTEXT_CHARS,
    );
    const truncated =
      rag.length < metadata.serverContext.trim().length
        ? `${rag}\n[RAG context truncated.]`
        : rag;
    lines.push(`rag-context:\n${truncated}`);
  }

  if (lines.length === 0) {
    return undefined;
  }

  return `<message-context>\n${lines.join('\n')}\n</message-context>`;
}

function formatContextItem(ctx: AIMessageContext): string {
  switch (ctx.type) {
    case 'atomic-resource':
      return `atomic-resource: ${ctx.subject}`;
    case 'mcp-resource':
      return `mcp-resource: ${ctx.name} (${ctx.uri})`;
    case 'skill':
      return `skill: ${ctx.name}`;
    default:
      return 'unknown-context-item';
  }
}

export function serializeForSummary(value: unknown, maxChars: number): string {
  if (value === undefined) {
    return 'undefined';
  }

  let serialized: string;

  try {
    serialized =
      typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    serialized = String(value);
  }

  return truncateText(serialized, maxChars);
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars).trimEnd()}\n...[truncated]`;
}

function capPreparedConversation(
  messages: SummaryConversationMessage[],
): SummaryConversationMessage[] {
  let result = messages;
  let json = JSON.stringify(result);

  while (
    json.length > MAX_CONVERSATION_JSON_CHARS &&
    result.length > MIN_MESSAGES_AFTER_CAP
  ) {
    result = result.slice(1);
    json = JSON.stringify(result);
  }

  if (json.length <= MAX_CONVERSATION_JSON_CHARS) {
    return result;
  }

  const partCount = result.reduce((n, m) => n + m.parts.length, 0);

  if (partCount === 0) {
    return result;
  }

  const budget =
    MAX_CONVERSATION_JSON_CHARS -
    '[conversation truncated for summarization]'.length;
  const perPart = Math.max(256, Math.floor(budget / partCount));

  return result.map(message => ({
    ...message,
    parts: message.parts.map(part => ({
      type: 'text' as const,
      text: truncateText(part.text, perPart),
    })),
  }));
}
