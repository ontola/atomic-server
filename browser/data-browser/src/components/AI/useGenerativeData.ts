import { generateText, type CoreMessage } from 'ai';
import {
  type AIChatDisplayMessage,
  isAIErrorMessage,
  isMessageWithContext,
} from './types';
import { useSettings } from '../../helpers/AppSettings';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

const generateTitleSystemPrompt = `You are part of a well oiled machine that responds to user input.
It is your job to think of a short title that fits the given conversation.
The user will provide a JSON object containing the conversation.

ALWAYS USE THE SAME LANGUAGE AS THE USER!
ONLY RESPOND WITH JUST THE TITLE, NOTHING ELSE! NO FORMATTING OR EXTRA TEXT!`;

export const useGenerativeData = () => {
  const { openRouterApiKey } = useSettings() as { openRouterApiKey?: string };
  const openrouter = createOpenRouter({
    apiKey: openRouterApiKey,
    compatibility: 'strict',
    extraBody: {
      transforms: ['middle-out'],
    },
  });

  const generateTitleFromConversation = async (
    conversation: AIChatDisplayMessage[],
  ) => {
    const filteredConversation = removeFilesAndImages(
      conversation.slice(0, 2).filter(m => m.role !== 'system'),
    );
    const convoString = JSON.stringify(filteredConversation);

    const { text } = await generateText({
      model: openrouter('google/gemma-3-4b-it:free'),
      system: generateTitleSystemPrompt,
      prompt: convoString,
    });

    const cleaned = text.trim();

    if (cleaned) {
      return cleaned;
    }

    return undefined;
  };

  return { generateTitleFromConversation };
};

function removeFilesAndImages(
  conversation: AIChatDisplayMessage[],
): AIChatDisplayMessage[] {
  return conversation.map(displayMessage => {
    // If it's a MessageWithContext, check the nested message
    const message = isMessageWithContext(displayMessage)
      ? displayMessage.message
      : displayMessage;

    // We are only interested in CoreMessages that are not error messages
    if (isAIErrorMessage(message) || !('content' in message)) {
      return displayMessage;
    }

    const coreMessage = message as CoreMessage;

    if (Array.isArray(coreMessage.content)) {
      return {
        ...coreMessage,
        content: coreMessage.content.filter(
          part => part.type !== 'file' && part.type !== 'image',
        ),
      };
    }

    return displayMessage;
  }) as AIChatDisplayMessage[];
}
