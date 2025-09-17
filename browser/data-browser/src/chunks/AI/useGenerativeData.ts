import { generateObject, generateText } from 'ai';
import { type AtomicUIMessage } from './types';
import z from 'zod';
import { useAISettings } from '@components/AI/AISettingsContext';
import { useGetModel } from './useModel';

const generateTitleSystemPrompt = (
  conversation: string,
) => `You are part of a well oiled machine that responds to user input.
It is your job to think of a short title that fits the given conversation.
The user will provide a JSON object containing the conversation.

ALWAYS USE THE SAME LANGUAGE AS THE USER!
ONLY RESPOND WITH JUST THE TITLE, NOTHING ELSE! NO FORMATTING OR EXTRA TEXT!

Here follows the conversation as a JSON object:
\`\`\`json
${conversation}
\`\`\`
`;

const generateFollowUpQuestionsSystemPrompt = (
  conversation: string,
) => `You are part of a larger AI chat application.
It is your job to look at a conversation and generate a follow up prompt for the user to use.
The prompt MUST be written from the perspective of the user, not the AI!
The prompt can be a follow up question or response to a question from the assistant.
DO NOT ask for clarification or information from the user, just generate the follow up prompt.
Be concise and to the point. DO NOT INCLUDE ANY TEXT FORMATTING.

If the assistant asks the user a question, generate follow up prompt that answer the question.
If the assistant makes a suggestion, generate follow up prompt that follow up on the suggestion.
If the assistant does neigther, generate a follow up question the user could ask about the topic that are related to the last assistant response.

Here follows the conversation as a JSON object:
\`\`\`json
${conversation}
\`\`\`
`;

export const useGenerativeData = () => {
  const { genFeaturesModel } = useAISettings();

  const getModel = useGetModel();

  const generateTitleFromConversation = async (
    conversation: AtomicUIMessage[],
  ) => {
    const model = getModel(genFeaturesModel);

    if (!model) {
      return undefined;
    }

    const filteredConversation = removeFilesAndImages(
      conversation.slice(0, 2).filter(m => m.role !== 'system'),
    );
    const convoString = JSON.stringify(filteredConversation);

    const { text } = await generateText({
      model,
      // Google/gemma-3-4b-it:free doesn't support system prompts so we have to do it this way
      prompt: generateTitleSystemPrompt(convoString),
    });

    const cleaned = text.trim();

    if (cleaned) {
      return cleaned;
    }

    return undefined;
  };

  const generateFollowUpQuestions = async (conversation: AtomicUIMessage[]) => {
    const model = getModel(genFeaturesModel);

    if (!model) {
      return [];
    }

    const filteredConversation = removeFilesAndImages(
      conversation.slice(-2).filter(m => m.role !== 'system'),
    );
    const convoString = JSON.stringify(filteredConversation);

    const { object } = await generateObject({
      model,
      prompt: generateFollowUpQuestionsSystemPrompt(convoString),
      schema: z.object({
        prompt: z.string(),
      }),
    });

    return object.prompt && object.prompt.trim() !== '' ? [object.prompt] : [];
  };

  return { generateTitleFromConversation, generateFollowUpQuestions };
};

function removeFilesAndImages(
  conversation: AtomicUIMessage[],
): AtomicUIMessage[] {
  return conversation.map(message => {
    return {
      ...message,
      parts: message.parts.filter(part => part.type !== 'file'),
    };
  });
}
