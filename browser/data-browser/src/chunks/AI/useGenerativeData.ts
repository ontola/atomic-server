// @wc-ignore-file
import { generateText, Output } from 'ai';
import { type AtomicUIMessage } from './types';
import z from 'zod';
import { useAISettings } from '@components/AI/AISettingsContext';
import { useGetModel } from './useModel';

const titleSystemPrompt = `You a specialized AI system that generates titles for AI conversations.
You will given the first part of a conversion between the user and an AI assistatn.
Think of a short title that fits the given conversation. This title will be shown in the UI as the title of the conversation.

ALWAYS USE THE SAME LANGUAGE AS THE USER!
ONLY RESPOND WITH JUST THE TITLE, NOTHING ELSE! NO FORMATTING OR EXTRA TEXT!
`;

const generateFollowUpQuestionsSystemPrompt = (
  conversation: string,
) => `You are part of a larger AI chat application.
It is your job to look at a conversation and generate a follow up prompt for the user to use.
The prompt MUST be written from the perspective of the user, not the AI!
The prompt can be a follow up question or response to a question from the assistant.
DO NOT ask for clarification or information from the user, just generate the follow up prompt.
Be concise and to the point. Keep the scentence as short as possible.
DO NOT INCLUDE ANY TEXT FORMATTING.

If the assistant asks the user a question, generate follow up prompt that answer the question.
If the assistant makes a suggestion, generate follow up prompt that follows up on the suggestion.
If the assistant does neigther, generate a follow up question the user could ask about the topic that are related to the last assistant response.

Examples:
The AI ends its message with a question: "Would you like me to show you some examples of ontologies or classes in your Atomic Data database?"
Follow up prompt: "Yes, show some examples"

The AI does not end its message with a question: "The Eifel Tower is located in Paris, France."
Follow up prompt: "When was the tower built?"

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
      system: titleSystemPrompt,
      prompt: `\`\`\`json
${convoString}
\`\`\`
`,
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

    const { output } = await generateText({
      model,
      prompt: generateFollowUpQuestionsSystemPrompt(convoString),
      output: Output.object({
        schema: z.object({
          prompt: z.string(),
        }),
      }),
    });

    return output.prompt && output.prompt.trim() !== '' ? [output.prompt] : [];
  };

  return { generateTitleFromConversation, generateFollowUpQuestions };
};

function removeFilesAndImages(
  conversation: AtomicUIMessage[],
): AtomicUIMessage[] {
  return conversation.map(message => {
    return {
      ...message,
      parts: message.parts.filter(part => part.type === 'text'),
    };
  });
}
