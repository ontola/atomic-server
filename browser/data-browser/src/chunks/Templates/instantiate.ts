// @wc-ignore-file
import {
  canvas,
  core,
  dataBrowser,
  enableLoro,
  server,
  type Store,
  type Resource,
} from '@tomic/react';
import { TABLE_TEMPLATES } from '../TablePage/tableTemplates';
import { instantiateTableTemplate } from './instantiateTable';

import type { TemplatePlan } from './model';

export interface TemplateInstance {
  release: TemplatePlan['release'];
  root: string;
  subjects: Record<string, string>;
}
type Json = { type: string; [k: string]: unknown };

/**
 * Document text is one block per line: `# ` heading, `- ` bullet,
 * `- [ ] ` / `- [x] ` task (unchecked / checked), else a paragraph. Inside a line `**bold**` and `{{key}}` (a chip linking to the
 * part with that key) work.
 */
export function textToBlocks(
  text: string,
  subjects: Record<string, string>,
): Json[] {
  const inline = (line: string): Json[] =>
    line
      .split(/(\*\*[^*]+\*\*|\{\{[\w/-]+\}\})/)
      .filter(Boolean)
      .map(piece => {
        const key = piece.match(/^\{\{([\w/-]+)\}\}$/)?.[1];
        if (key && subjects[key])
          return {
            type: 'atomic-data-resource-inline',
            attrs: { subject: subjects[key] },
          };
        if (/^\*\*.+\*\*$/.test(piece))
          return {
            type: 'text',
            text: piece.slice(2, -2),
            marks: [{ type: 'bold' }],
          };

        return { type: 'text', text: piece };
      });
  const blocks: Json[] = [];

  for (const line of text.split('\n')) {
    const task = line.match(/^- \[([ x])\] /);
    const item = line.startsWith('- ');
    const heading = line.startsWith('# ');
    const content = inline(
      task ? line.slice(6) : item || heading ? line.slice(2) : line,
    );

    if (item) {
      const li = task
        ? {
            type: 'taskItem',
            attrs: { checked: task[1] === 'x' },
            content: [{ type: 'paragraph', content }],
          }
        : { type: 'listItem', content: [{ type: 'paragraph', content }] };
      const listType = task ? 'taskList' : 'bulletList';
      const last = blocks[blocks.length - 1];
      if (last?.type === listType) (last.content as Json[]).push(li);
      else blocks.push({ type: listType, content: [li] });
    } else if (heading) {
      blocks.push({ type: 'heading', attrs: { level: 2 }, content });
    } else {
      blocks.push({ type: 'paragraph', content });
    }
  }

  return blocks;
}

/** Uses the same table and document writers as ordinary authoring. No HTTP import. */
export async function instantiateTemplate(
  store: Store,
  plan: TemplatePlan,
  target: { parent: string; drive: string },
): Promise<TemplateInstance> {
  // Reject unsupported plans before any writes, including missing catalog entries.
  for (const part of plan.parts) {
    if (
      part.kind === 'table' &&
      !TABLE_TEMPLATES.some(t => t.id === part.catalogId && t.spec)
    ) {
      throw new Error(`Unknown table template: ${part.catalogId}`);
    }
  }

  await enableLoro();
  const subjects: Record<string, string> = {};
  const documents: Array<{ resource: Resource; text: string }> = [];

  for (const part of plan.parts) {
    if (part.kind === 'table') {
      const result = await instantiateTableTemplate(
        store,
        part.catalogId,
        part.name,
        undefined,
        {
          parent: target.parent,
          driveSubject: target.drive,
          addToOntology: resource =>
            addToOntology(store, target.drive, resource),
        },
        plan.examples,
      );
      subjects[part.key] = result.tableSubject;
    } else if (part.kind === 'canvas') {
      const resource = await store.newResource({
        parent: target.parent,
        isA: canvas.classes.canvas,
        propVals: { [core.properties.name]: part.name },
      });
      await resource.save();
      subjects[part.key] = resource.subject;
    } else if (part.kind === 'document') {
      const resource = await store.newResource({
        parent: target.parent,
        isA: dataBrowser.classes.documentV2,
        propVals: { [core.properties.name]: part.name },
      });
      documents.push({
        resource,
        text: part.text,
      });
      subjects[part.key] = resource.subject;
    }
  }

  // Written last, so a document can link to the other parts.
  for (const { resource, text } of documents) {
    if (text) {
      const { applyPatchedJsonToLoroDocCollaborative } =
        await import('../RTE/applyPatchedJsonToLoroDocCollaborative');
      const loroDoc = resource.getLoroDoc();
      if (!loroDoc) throw new Error('Document storage is not ready.');
      await applyPatchedJsonToLoroDocCollaborative({
        store,
        subject: resource.subject,
        loroDoc,
        patchedJson: { type: 'doc', content: textToBlocks(text, subjects) },
      });
    }

    await resource.save();
  }

  return { release: plan.release, root: target.parent, subjects };
}

/** Mirrors `useAddToOntology` for imperative (non-hook) callers: parent
 *  the class/property under the drive's default ontology and link it in
 *  the matching ontology list. */
async function addToOntology(
  store: Store,
  driveSubject: string,
  resource: Resource,
): Promise<void> {
  const drive = await store.getResource(driveSubject);
  const ontologySubject = drive.get(server.properties.defaultOntology) as
    | string
    | undefined;

  if (!ontologySubject) {
    await resource.set(core.properties.parent, driveSubject);
    await resource.save();

    return;
  }

  await resource.set(core.properties.parent, ontologySubject);
  await resource.save();

  const ontology = await store.getResource(ontologySubject);

  if (resource.hasClasses(core.classes.class)) {
    ontology.push(core.properties.classes, [resource.subject], true);
  } else if (resource.hasClasses(core.classes.property)) {
    ontology.push(core.properties.properties, [resource.subject], true);
  } else {
    ontology.push(core.properties.instances, [resource.subject], true);
  }

  await ontology.save();
}
