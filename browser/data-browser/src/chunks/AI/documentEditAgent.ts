// @wc-ignore-file
import { generateText, type LanguageModel } from 'ai';
import { applyPatch } from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';
import {
  dataBrowser,
  useStore,
  type DataBrowser,
  type Store,
} from '@tomic/react';
import type { JSONContent } from '@tiptap/core';
import { z } from 'zod';
import { useAISettings } from '@components/AI/AISettingsContext';
import { useGetModel } from './useModel';
import type { AIModelIdentifier } from './types';
import { getCollaborativeEditorSchema } from '@chunks/RTE/getCollaborativeEditorSchema';
import { applyPatchedJsonToYDocCollaborative } from '@chunks/RTE/applyPatchedJsonToYDocCollaborative';
import { getProsemirrorObjFromYDoc } from '@chunks/RTE/prosemirrorObjFromYDoc';
import { flushSync } from 'react-dom';

const EDIT_PROMPT = `## Role
You are a JSON Patch Compiler. Your goal is to take a Tiptap JSON document and apply precise modifications based on an "Edit Instruction" and an "XML-based Diff".

## Input Format
1. **Current Document:** The full Tiptap JSON structure. Each node includes \`_path\`: a **RFC 6901 JSON Pointer** from the document root to that object (for navigation only).
2. **Instruction:** A brief description of the intent (e.g., "Adding a research question").
3. **Semantic Edit:** An XML-like string containing \`<unchanged-text>\` (context) and \`<edit>\` (the new content).

## Output Format
Respond with **only** a single JSON object (no markdown fences, no commentary) of the form \`{"patch":[...]}\` where \`patch\` is a **JSON Patch (RFC 6902)** array of operations.

## Rules for Patching Tiptap
1. **Use \`_path\` from the document:** Prefer the \`_path\` on the **parent** you are modifying (e.g. the \`bulletList\` node) over counting siblings. Your \`path\` / \`from\` fields must match pointers into the **same** tree (without \`_path\` keys). **Never** put \`_path\` inside \`value\` objects you add—those are real Tiptap nodes only.
2. **Verify the parent exists:** If a node has no \`content\` array in the JSON, there is no \`/content/...\` beneath it. Do not invent \`/content/N/content/M\` without a \`bulletList\` / \`orderedList\` / block parent that actually has \`content\` at that pointer.
3. **Schema Alignment:** Tiptap documents follow a strict hierarchy: \`doc\` -> block (\`paragraph\`, \`bulletList\`, …) -> (\`listItem\` ->) \`paragraph\` -> \`text\`. Ensure your \`value\` in the patch matches this schema exactly.
4. **Operation Types:**
    - Use \`add\` to insert new list items or paragraphs.
    - Use \`replace\` to modify existing text.
    - Use \`remove\` for deletions.
5. **Arrays — append with \`-\`:** To add a \`listItem\` at the end of a list, use \`/content/<doc-index>/content/-\` (JSON Patch \`-\` means “append”). Only use a numeric index when inserting at a specific position; prefer \`-\` when adding to the end of a list.
6. **Contextual Accuracy:** The \`<unchanged-text>\` may contain simplified markup. Map these back to the actual JSON (e.g. bold → mark \`{"type": "bold"}\`).

## Example Transformation
**If the Edit is:** \`<unchanged-text>...listitem...How can we produce hardware...</unchanged-text><edit><listitem><paragraph>New Item</paragraph></listitem></edit>\`

**Your Patch should look like (use the list’s \`_path\` + \`/content/-\` when appending):**
[
  {
    "op": "add",
    "path": "/content/5/content/-",
    "value": {
      "type": "listItem",
      "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "New Item" }] }]
    }
  }
]`;

/**
 * Validates parsed model output locally. Not passed to the provider as JSON Schema
 * (Azure rejects many Zod→schema constructs, e.g. `propertyNames` from `z.record`).
 */
const jsonPatchOperationSchema = z.union([
  z.object({
    op: z.literal('add'),
    path: z.string(),
    value: z.any(),
  }),
  z.object({
    op: z.literal('remove'),
    path: z.string(),
  }),
  z.object({
    op: z.literal('replace'),
    path: z.string(),
    value: z.any(),
  }),
  z.object({
    op: z.literal('move'),
    path: z.string(),
    from: z.string(),
  }),
  z.object({
    op: z.literal('copy'),
    path: z.string(),
    from: z.string(),
  }),
  z.object({
    op: z.literal('test'),
    path: z.string(),
    value: z.any(),
  }),
]);

const patchOutputSchema = z.object({
  patch: z.array(jsonPatchOperationSchema),
});

/** Parse `{"patch":[...]}` from model text; tolerates optional ```json fences. */
function parsePatchResponseText(text: string): unknown {
  const trimmed = text.trim();
  const fenceOpen = trimmed.indexOf('```');

  let body = trimmed;

  if (fenceOpen !== -1) {
    const afterFirst = trimmed
      .slice(fenceOpen + 3)
      .replace(/^(json)?\s*\n?/, '');
    const close = afterFirst.indexOf('```');

    if (close !== -1) {
      body = afterFirst.slice(0, close).trim();
    }
  }

  const start = body.indexOf('{');

  if (start === -1) {
    throw new Error('Response did not contain a JSON object');
  }

  let depth = 0;
  let end = -1;

  for (let i = start; i < body.length; i++) {
    const c = body[i];

    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;

      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) {
    throw new Error('Unclosed JSON object in response');
  }

  return JSON.parse(body.slice(start, end + 1));
}

const MAX_PATCH_ATTEMPTS = 3;

/**
 * Deep-clone Tiptap JSON and add `_path` on each node: RFC 6901 pointer from the
 * document root. Shown only in the model prompt; `applyPatch` still runs on the
 * original document (same pointer paths, since `_path` is metadata, not extra
 * array elements).
 */
function annotateTiptapJsonWithJsonPointers(
  node: JSONContent,
  jsonPointer: string,
): JSONContent {
  const withPath = {
    ...node,
    _path: jsonPointer === '' ? '/' : jsonPointer,
  } as JSONContent & { _path: string };

  if (node.content?.length) {
    withPath.content = node.content.map((child, index) =>
      annotateTiptapJsonWithJsonPointers(
        child,
        `${jsonPointer}/content/${index}`,
      ),
    );
  }

  return withPath;
}

function buildDocumentEditUserPrompt(
  instruction: string,
  edit: string,
  docJson: JSONContent,
  previousFailure?: string,
): string {
  const retrySection = previousFailure
    ? `## Previous attempt failed — correct your patch
The following error occurred. Respond again with **only** a JSON object \`{"patch":[...]}\` that fixes the issue.

${previousFailure}

`
    : '';

  return `## Instruction
${instruction}

## Semantic edit (XML)
${edit}

${retrySection}## Current Tiptap JSON document
Each object includes \`_path\` (JSON Pointer) for addressing; omit \`_path\` from any \`value\` you emit in the patch.
\`\`\`json
${JSON.stringify(annotateTiptapJsonWithJsonPointers(docJson, ''), null, 2)}
\`\`\`
`;
}

/**
 * Calls the patch compiler model outside the chat `streamText` turn.
 * Some providers (notably Azure behind OpenRouter) mis-handle a second in-flight
 * completion started synchronously inside a tool call; yielding first avoids
 * competing with the parent SSE. The abort signal is isolated from the tool
 * execution signal so the nested request cannot cancel the chat stream.
 */
async function generatePatchCompilerText(
  model: LanguageModel,
  userPrompt: string,
): Promise<string> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });

  const abortController = new AbortController();

  const { text } = await generateText({
    model,
    system: EDIT_PROMPT,
    prompt: userPrompt,
    abortSignal: abortController.signal,
  });

  return text;
}

async function runDocumentEdit(
  store: Store,
  getModel: ReturnType<typeof useGetModel>,
  genFeaturesModel: AIModelIdentifier,
  subject: string,
  instruction: string,
  edit: string,
  beforeApply: () => void,
): Promise<string> {
  const resource = await store.getResource<DataBrowser.DocumentV2>(subject);

  if (!resource.hasClasses(dataBrowser.classes.documentV2)) {
    return `Error: Resource ${subject} is not a Document (document-v2).`;
  }

  const model = getModel(genFeaturesModel);

  if (!model) {
    return 'Error: No AI model configured for document features (set a model in AI settings).';
  }

  const { schema } = getCollaborativeEditorSchema(store);
  const yDoc = resource.getYDoc(dataBrowser.properties.documentContent);
  const docJson = getProsemirrorObjFromYDoc(yDoc, schema);

  let previousFailure: string | undefined;
  let patched: JSONContent | undefined;
  let winningPatch: Operation[] | undefined;

  for (let attempt = 1; attempt <= MAX_PATCH_ATTEMPTS; attempt++) {
    const userPrompt = buildDocumentEditUserPrompt(
      instruction,
      edit,
      docJson,
      previousFailure,
    );

    let patch: Operation[];

    try {
      const text = await generatePatchCompilerText(model, userPrompt);

      const parsed = parsePatchResponseText(text);
      const validated = patchOutputSchema.safeParse(parsed);

      if (!validated.success) {
        previousFailure = `Invalid { patch } JSON: ${validated.error.message}`;

        if (attempt === MAX_PATCH_ATTEMPTS) {
          return `Error: Model response was not valid { patch } JSON after ${MAX_PATCH_ATTEMPTS} attempts: ${validated.error.message}`;
        }

        continue;
      }

      if (!validated.data.patch.length) {
        previousFailure = 'The edit model returned an empty patch.';

        if (attempt === MAX_PATCH_ATTEMPTS) {
          return `Error: The edit model returned an empty patch after ${MAX_PATCH_ATTEMPTS} attempts.`;
        }

        continue;
      }

      patch = validated.data.patch as Operation[];
    } catch (e) {
      previousFailure = `Generating or parsing the model response: ${e}`;

      if (attempt === MAX_PATCH_ATTEMPTS) {
        return `Error generating document patch after ${MAX_PATCH_ATTEMPTS} attempts: ${e}`;
      }

      continue;
    }

    try {
      const result = applyPatch(docJson, patch, true, false);

      patched = result.newDocument as JSONContent;
    } catch (e) {
      previousFailure = `Applying JSON Patch failed: ${e}`;

      if (attempt === MAX_PATCH_ATTEMPTS) {
        return `Error applying JSON Patch after ${MAX_PATCH_ATTEMPTS} attempts: ${e}`;
      }

      continue;
    }

    if (patched.type !== 'doc') {
      previousFailure = `Patched document must have type "doc", got ${String(patched.type)}.`;

      if (attempt === MAX_PATCH_ATTEMPTS) {
        return `Error: Patched document must have type "doc" after ${MAX_PATCH_ATTEMPTS} attempts (got ${String(patched.type)}).`;
      }

      continue;
    }

    winningPatch = patch;
    break;
  }

  if (!patched || !winningPatch) {
    return `Error: Document edit failed after ${MAX_PATCH_ATTEMPTS} attempts.`;
  }

  try {
    flushSync(() => {
      beforeApply();
    });

    const freshDocJson = getProsemirrorObjFromYDoc(yDoc, schema);
    let patchedToApply: JSONContent;

    try {
      const reapply = applyPatch(
        structuredClone(freshDocJson),
        winningPatch,
        true,
        false,
      );
      patchedToApply = reapply.newDocument as JSONContent;
    } catch (e) {
      return `Error: The document changed while the edit was generated; try again. (${e})`;
    }

    if (patchedToApply.type !== 'doc') {
      return `Error: Re-applied patch did not produce a doc root (got ${String(patchedToApply.type)}).`;
    }

    await applyPatchedJsonToYDocCollaborative({
      store,
      yDoc,
      subject,
      patchedJson: patchedToApply,
    });
  } catch (e) {
    return `Error writing Tiptap content to Yjs: ${e}`;
  }

  // Intentionally no resource.save(): keep edits local until the user confirms in the UI.

  return `Document edit successful for ${subject}`;
}

export function useDocumentEditAgent() {
  const store = useStore();
  const { genFeaturesModel } = useAISettings();
  const getModel = useGetModel();

  return async (
    subject: string,
    instruction: string,
    edit: string,
    beforeApply: () => void,
  ) =>
    runDocumentEdit(
      store,
      getModel,
      genFeaturesModel,
      subject,
      instruction,
      edit,
      beforeApply,
    );
}
