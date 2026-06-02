// @wc-ignore-file
import { generateText, Output } from 'ai';
import { type AtomicUIMessage } from './types';
import z from 'zod';
import { useAISettings } from '@components/AI/AISettingsContext';
import { useGetModel } from './useModel';
import { simplifyConversation } from './simplifyConversation';

const titleSystemPrompt = `You are a specialized AI system that generates titles for AI conversations.
You will be given the first part of a conversation between the user and an AI assistant.
Think of a short title that fits the given conversation. This title will be shown in the UI as the title of the conversation.

ALWAYS write the title in the same natural language as the user's own message text.
Do NOT use the language of quoted text, existing titles, URLs, resource names, or language names mentioned by the user.
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

    const filteredConversation = simplifyConversation(
      conversation.slice(0, 2).filter(m => m.role !== 'system'),
    );
    const convoString = JSON.stringify(filteredConversation);

    const { output } = await generateText({
      model,
      system: titleSystemPrompt,
      output: Output.object({
        schema: z.object({
          title: z.string(),
        }),
      }),
      prompt: `Generate a title for the following conversation:
\`\`\`json
${convoString}
\`\`\`
`,
    });

    if (!output.title) {
      return undefined;
    }

    const cleaned = output.title.trim();

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

    const filteredConversation = simplifyConversation(
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

  return {
    generateTitleFromConversation,
    generateFollowUpQuestions,
  };
};
