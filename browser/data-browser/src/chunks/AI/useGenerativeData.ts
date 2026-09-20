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
Also pick ONE emoji that represents the topic of the conversation; it is shown next to the title.

ALWAYS write the title in the same natural language as the user's own message text.
Do NOT use the language of quoted text, existing titles, URLs, resource names, or language names mentioned by the user.
Respond with exactly one line: the emoji, a single space, then the title text. Do not wrap it in JSON, quotes, markdown, or commentary.
Example: 🥐 Bakery website
`;

export interface ChatTitle {
  title: string;
  emoji?: string;
}

// A leading emoji (including skin tones, variation selectors and ZWJ
// sequences) followed by whitespace and the title.
const emojiTitlePattern =
  /^((?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\p{Emoji_Modifier}|\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}))*)\s+(.+)$/u;
const trailingEmojiPattern =
  /(?:\s*(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\p{Emoji_Modifier}|\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}))*)+$/u;

/** Splits "🥐 Bakery website" into emoji and title; a bare title keeps no emoji. */
export function parseChatTitle(
  line: string | undefined,
): ChatTitle | undefined {
  const text = line?.trim();

  if (!text) return undefined;

  const match = text.match(emojiTitlePattern);

  // Some models decorate both ends; the title itself should carry no emoji.
  const strip = (title: string) =>
    title.replace(trailingEmojiPattern, '').trim();

  return match
    ? { emoji: match[1], title: strip(match[2]) }
    : { title: strip(text) };
}

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

        return parseChatTitle(cleanGeneratedTextLine(text));
      },
    );
  };

  return {
    generateTitleFromConversation,
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
