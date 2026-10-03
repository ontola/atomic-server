import type { AtomicUIMessage } from './types';

export const MAX_AI_CHAT_REPORT_LENGTH = 60_000;

function formatMessage(message: AtomicUIMessage, index: number): string {
  const content = message.parts
    .map(part => {
      if (part.type === 'text') return part.text;
      if (part.type === 'file')
        return `[Attachment: ${part.filename ?? 'unnamed'}]`;

      // Tool inputs, outputs, files and reasoning can contain document data.
      // The user may describe those in the report without sending them by default.
      return `[${part.type}]`;
    })
    .filter(Boolean)
    .join('\n');
  const error = message.metadata?.error
    ? `\nError: ${message.metadata.error}`
    : '';

  return `${index + 1}. ${message.role}${message.metadata?.isSummary ? ' (summary)' : ''}\n${content || '[No text]'}${error}`;
}

/** A reviewable transcript. Keep recent turns intact if Sentry feedback grows too large. */
export function formatAIChatReport(
  title: string,
  messages: AtomicUIMessage[],
): { text: string; omittedMessages: number } {
  const entries = messages.map(formatMessage);
  const heading = `AI chat: ${title || 'Untitled Chat'}\nMessages: ${messages.length}\n\n`;
  let omittedMessages = 0;
  let body = entries.join('\n\n');

  while (
    heading.length + body.length > MAX_AI_CHAT_REPORT_LENGTH &&
    omittedMessages < entries.length - 1
  ) {
    omittedMessages++;
    body = entries.slice(omittedMessages).join('\n\n');
  }

  const omission = omittedMessages
    ? `${omittedMessages} earlier messages omitted to fit the report.\n\n`
    : '';
  const available =
    MAX_AI_CHAT_REPORT_LENGTH - heading.length - omission.length;

  if (body.length > available) {
    body = `[Earlier text in this message omitted]\n${body.slice(-Math.max(0, available - 39))}`;
  }

  return {
    text: `${heading}${omission}${body}`.slice(0, MAX_AI_CHAT_REPORT_LENGTH),
    omittedMessages,
  };
}
