// @wc-ignore-file
import { TEMPLATE_DEMO_KEY, readTemplateDemo } from './demoSession';
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
 * Document text is one block per line: `# ` heading, `- ` bullet, else a
 * paragraph. Inside a line `**bold**` and `{{key}}` (a chip linking to the
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
    const item = line.startsWith('- ');
    const heading = line.startsWith('# ');
    const content = inline(item || heading ? line.slice(2) : line);

    if (item) {
      const li = {
        type: 'listItem',
        content: [{ type: 'paragraph', content }],
      };
      const last = blocks[blocks.length - 1];
      if (last?.type === 'bulletList') (last.content as Json[]).push(li);
      else blocks.push({ type: 'bulletList', content: [li] });
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

  const { addToOntology } = await import('../Demo/demoWorkspace');
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
        text: plan.examples ? (part.exampleText ?? part.text) : part.text,
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
export async function startTemplateDemo(
  store: Store,
  plan: TemplatePlan,
): Promise<string> {
  const db = store.getClientDb();
  if (!db) throw new Error('Enable local storage to preview this template.');
  await db.waitForReady();
  const { cleanupDemoDrive, stopDemoDirector } =
    await import('../Demo/startDemo');
  stopDemoDirector();
  const previous = readTemplateDemo();
  const previousDrive = previous?.previousDrive ?? store.getDrive() ?? '';
  if (previous) await cleanupDemoDrive(store, previous.drive);
  const agent = store.getAgent();
  if (!agent) throw new Error('Sign in before previewing a template.');
  await enableLoro();
  const drive: Resource = await store.newResource({
    isA: server.classes.drive,
    noParent: true,
    propVals: {
      [core.properties.name]: `${plan.title} demo`,
      [core.properties.read]: [agent.subject],
      [core.properties.write]: [agent.subject],
    },
  });
  // Register and track before the first save; a failed preview can still be cleaned up.
  store.registerLocalOnlyDrive(drive.subject);
  localStorage.setItem(
    TEMPLATE_DEMO_KEY,
    JSON.stringify({
      drive: drive.subject,
      template: plan.release.id,
      previousDrive,
    }),
  );
  await drive.save();
  await store.createDefaultOntology(drive);
  const instance = await instantiateTemplate(
    store,
    { ...plan, examples: true },
    { parent: drive.subject, drive: drive.subject },
  );
  store.setDrive(drive.subject);

  return Object.values(instance.subjects)[0] ?? drive.subject;
}
