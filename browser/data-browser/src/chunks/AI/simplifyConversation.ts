import { type AtomicUIMessage } from './types';

export function simplifyConversation(conversation: AtomicUIMessage[]): {
  role: 'user' | 'assistant' | 'system';
  parts: { type: 'text'; text: string }[];
}[] {
  return conversation.map(message => {
    return {
      role: message.role,
      parts: message.parts
        .filter(part => part.type === 'text')
        .map(part => ({
          type: part.type,
          text: part.text.replace(/```\n|```/g, ''),
        })),
    };
  });
}
