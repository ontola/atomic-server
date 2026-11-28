// @wc-ignore-file
import { generateText, jsonSchema, tool } from 'ai';
import {
  extractWithModel,
  findCandidates,
  getClassesOnDrive,
  buildSnapshot,
  type ImportCapture,
  type ImportProposal,
  type ModelCall,
  type Store,
} from '@tomic/react';
import { AIProvider } from '@components/AI/aiContstants';
import type { AIModelIdentifier } from './types';
import { resolveModel, type ModelSettings } from './useModel';

const TIMEOUT_MS = 90_000;

/** Parses a JSON object out of a model's plain text answer (no tool support). */
function parseJsonText(text: string): unknown {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  if (start < 0 || end <= start) throw new Error('The model did not answer.');

  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * One structured call: the model must call the given tool, whose input schema
 * is the answer. Models without tool support may answer with JSON text.
 */
export function createModelCall(
  identifier: AIModelIdentifier,
  settings: ModelSettings,
  abortSignal?: AbortSignal,
): ModelCall {
  const model = resolveModel(identifier, settings);

  if (!model) throw new Error('No AI model is available.');

  return async request => {
    const result = await generateText({
      model,
      maxRetries: identifier.provider === AIProvider.Hosted ? 0 : 1,
      abortSignal: abortSignal ?? AbortSignal.timeout(TIMEOUT_MS),
      system: request.system,
      prompt: request.prompt,
      temperature: 0,
      tools: {
        [request.toolName]: tool({
          description: request.toolDescription,
          inputSchema: jsonSchema(request.schema as never),
        }),
      },
      toolChoice: { type: 'tool', toolName: request.toolName },
    });
    const call = result.toolCalls.find(c => c.toolName === request.toolName);

    return call ? call.input : parseJsonText(result.text);
  };
}

/**
 * Reads the page with the model and proposes one record in an existing class.
 * Candidates come from the store; nothing is created or saved here.
 */
export async function runImportExtraction(args: {
  store: Store;
  drive: string;
  capture: ImportCapture;
  fallback?: ImportProposal;
  identifier: AIModelIdentifier;
  settings: ModelSettings;
  hint?: string;
}): Promise<ImportProposal> {
  const { store, drive, capture, fallback, identifier, settings, hint } = args;
  const snapshot = buildSnapshot(capture);
  const driveClasses = await getClassesOnDrive(drive, store).catch(
    () => [] as string[],
  );
  const candidates = await findCandidates(
    store,
    driveClasses,
    `${snapshot.title ?? ''} ${snapshot.text}`,
    hint,
  );

  return extractWithModel({
    capture,
    candidates,
    call: createModelCall(identifier, settings),
    fallback,
  });
}
