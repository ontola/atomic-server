import { generateText } from 'ai';
import type { AIChatDisplayMessage } from './types';
import { useSettings } from '../../helpers/AppSettings';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

const generateTitleSystemPrompt = `You are part of a well oiled machine that responds to user input.
It is your job to think of a short title that fits the given conversation.
You are known for your incredible wordplay and cleverness.
Make the title funny and clever, things like wordplay, puns or titles that just sound funny.

The user will provide a JSON object containing the conversation.

ALWAYS USE THE SAME LANGUAGE AS THE USER!
ONLY RESPOND WITH THE TITLE, NOTHING ELSE!`;

export const useGenerativeData = () => {
  const { openRouterApiKey } = useSettings() as { openRouterApiKey?: string };
  const openrouter = createOpenRouter({
    apiKey: openRouterApiKey,
    compatibility: 'strict',
  });

  const generateTitleFromConversation = async (
    conversation: AIChatDisplayMessage[],
  ) => {
    const convoString = JSON.stringify(conversation);

    const { text } = await generateText({
      model: openrouter('google/gemma-3-12b-it:free'),
      system: generateTitleSystemPrompt,
      prompt: convoString,
    });

    console.log('text', text);

    const cleaned = text.trim();

    if (cleaned) {
      return cleaned;
    }

    return null;
  };

  return { generateTitleFromConversation };
};
