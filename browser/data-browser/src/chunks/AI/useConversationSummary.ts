// @wc-ignore-file
import { generateText } from 'ai';
import { type AIModelIdentifier, type AtomicUIMessage } from './types';
import { useGetModel } from './useModel';
import { prepareConversationForSummary } from './prepareConversationForSummary';

const summarySystemPrompt = `You are compacting an AI conversation to save context window space.
Summarize the full conversation below into a concise but complete narrative.
Preserve all key facts, data retrieved (including important field values from tool results), decisions made, and the current task state.
Write in past tense from a neutral perspective. Do not include pleasantries or filler.
This summary will replace the earlier messages including earlier summaries in the AI's context window.`;

export function useConversationSummary(agentModel: AIModelIdentifier) {
  const getModel = useGetModel();

  const generateConversationSummary = async (
    conversation: AtomicUIMessage[],
  ): Promise<string | undefined> => {
    const model = getModel(agentModel);

    if (!model) {
      return undefined;
    }

    const filteredConversation = prepareConversationForSummary(
      conversation.filter(m => m.role !== 'system'),
    );
    const convoString = JSON.stringify(filteredConversation);

    const { text } = await generateText({
      model,
      system: summarySystemPrompt,
      prompt: convoString,
    });

    return text.trim() || undefined;
  };

  return { generateConversationSummary };
}
