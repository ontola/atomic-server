// @wc-ignore-file
import { generateText } from 'ai';
import { type AIModelIdentifier, type AtomicUIMessage } from './types';
import { useAISettings } from '@components/AI/AISettingsContext';
import { useGetModel } from './useModel';
import { simplifyConversation } from './simplifyConversation';
import { AIProvider } from '@components/AI/aiContstants';

const titleSystemPrompt = `You are a specialized AI system that generates titles for AI conversations.
You will be given the first part of a conversation between the user and an AI assistant.
Think of a short title that fits the given conversation. This title will be shown in the UI as the title of the conversation.

ALWAYS write the title in the same natural language as the user's own message text.
Do NOT use the language of quoted text, existing titles, URLs, resource names, or language names mentioned by the user.
Respond with only the title text. Do not wrap it in JSON, quotes, markdown, or commentary.
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
Respond with only the prompt text. Do not wrap it in JSON, quotes, markdown, or commentary.

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
  const { defaultChatModel, genFeaturesModel, isProviderAvailable } =
    useAISettings();

  const getModel = useGetModel();
  const modelIdentifier = selectGenerativeFeaturesModel(
    genFeaturesModel,
    defaultChatModel,
    isProviderAvailable,
  );

  const generateTitleFromConversation = async (
    conversation: AtomicUIMessage[],
  ) => {
    const model = modelIdentifier ? getModel(modelIdentifier) : undefined;

    if (!model) {
      return undefined;
    }

    const filteredConversation = simplifyConversation(
      conversation.slice(0, 2).filter(m => m.role !== 'system'),
    );
    const convoString = JSON.stringify(filteredConversation);

    return optionalGeneratedData(
      'AI chat title generation failed',
      undefined,
      async () => {
        const { text } = await generateText({
          model,
          system: titleSystemPrompt,
          prompt: `Generate a title for the following conversation:
\`\`\`json
${convoString}
\`\`\`
`,
        });

        return cleanGeneratedTextLine(text);
      },
    );
  };

  const generateFollowUpQuestions = async (conversation: AtomicUIMessage[]) => {
    const model = modelIdentifier ? getModel(modelIdentifier) : undefined;

    if (!model) {
      return [];
    }

    const filteredConversation = simplifyConversation(
      conversation.slice(-2).filter(m => m.role !== 'system'),
    );
    const convoString = JSON.stringify(filteredConversation);

    return optionalGeneratedData(
      'AI chat follow-up prompt generation failed',
      [],
      async () => {
        const { text } = await generateText({
          model,
          prompt: generateFollowUpQuestionsSystemPrompt(convoString),
        });
        const prompt = cleanGeneratedTextLine(text);

        return prompt ? [prompt] : [];
      },
    );
  };

  return {
    generateTitleFromConversation,
    generateFollowUpQuestions,
  };
};

export async function optionalGeneratedData<T>(
  message: string,
  fallback: T,
  generate: () => Promise<T>,
): Promise<T> {
  try {
    return await generate();
  } catch (error) {
    console.warn(message, error);

    return fallback;
  }
}

export function cleanGeneratedTextLine(text: string): string | undefined {
  const withoutReasoning = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const withoutFences = withoutReasoning.replace(/```(?:\w+)?|```/g, '');
  const trimmed = withoutFences
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  const [firstLine] = trimmed.split(/\r?\n/).map(line => line.trim());

  return firstLine || undefined;
}

export function selectGenerativeFeaturesModel(
  genFeaturesModel: AIModelIdentifier,
  defaultChatModel: AIModelIdentifier,
  isProviderAvailable: (provider: AIProvider) => boolean,
): AIModelIdentifier | undefined {
  if (isProviderAvailable(genFeaturesModel.provider)) {
    return genFeaturesModel;
  }

  if (isProviderAvailable(defaultChatModel.provider)) {
    return defaultChatModel;
  }

  return undefined;
}
