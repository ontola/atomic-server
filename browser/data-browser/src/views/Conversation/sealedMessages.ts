import { createContext, useContext } from 'react';
import type { SealedPayload } from '../../helpers/conversations/conversationCrypto';

/** The decrypted messages of one conversation. */
export interface SealedMessages {
  /** The conversation they belong to: its subject is bound into every key. */
  conversation: string;
  /** SealedMessages by subject. `null`: a message this reader can't open.
   *  Absent: not opened yet. */
  opened: Map<string, SealedPayload | null>;
}

/**
 * Decrypted SealedMessages, by subject. A conversation opens its messages once
 * and provides them here, so the chat's Message rows show the text instead of
 * reading `description`. Absent from the tree: not a conversation.
 */
export const SealedMessagesContext = createContext<SealedMessages | null>(null);

export type SealedState =
  | { sealed: false }
  | {
      sealed: true;
      conversation: string;
      payload: SealedPayload | null | undefined;
    };

/** Whether `subject` is a sealed message, and its content once opened. */
export function useSealedMessage(subject: string): SealedState {
  const messages = useContext(SealedMessagesContext);

  if (!messages) {
    return { sealed: false };
  }

  return {
    sealed: true,
    conversation: messages.conversation,
    payload: messages.opened.get(subject),
  };
}
