import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Editable, EditModeProvider } from '@tomic/edit-mode/react';
import { core, Datatype, useStore } from '@tomic/react';
import type { WebsiteArtifact } from './renderWebsite';
import {
  commitWebsiteField,
  pageFields,
  type WebsiteField,
} from './websiteInlineEditing';
import { assertPrivateWebsiteParent } from './websiteModel';

interface Target {
  element: Element;
  field: WebsiteField;
}

/** The parent owns React, credentials and writes. No scripts run inside the iframe. */
export function WebsiteInlinePreview({
  artifact,
  pagePath,
}: {
  artifact: WebsiteArtifact;
  pagePath: string;
}) {
  const store = useStore();
  const [targets, setTargets] = useState<Target[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const page =
    artifact.config.pages.find(candidate => candidate.path === pagePath) ??
    artifact.config.pages[0];
  const html = artifact.files[`${page.path.slice(1)}index.html`];

  const setup = async (frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument;
    if (!doc) return;
    // Navigation must not load third-party documents into the authorized preview host.
    doc.addEventListener('click', event => {
      if ((event.target as Element).closest('a')) event.preventDefault();
    });
    const style = doc.createElement('style');
    style.textContent =
      '.tomic-editable{display:inline-block;min-width:1ch;outline:1px dashed var(--accent);outline-offset:3px;cursor:text}.tomic-editable:focus{outline:2px solid var(--accent)}';
    doc.head.appendChild(style);
    doc.querySelectorAll('.snapshot-view').forEach(view => view.remove());
    const next: Target[] = [];

    for (const binding of pageFields(page)) {
      const section = doc.querySelector(
        `[data-website-table="${binding.tableIndex}"]`,
      );
      const rows = section?.querySelectorAll(
        binding.layout === 'grid' ? 'dl.card' : 'tbody > tr',
      );
      const element = rows?.[binding.rowIndex]?.querySelectorAll(
        binding.layout === 'grid' ? 'dd' : 'td',
      )[binding.columnIndex];
      if (!element) continue;
      const resource = await store.getResource(binding.subject);
      const property = await store.getResource(binding.property);
      const agent = store.getAgent();
      if (
        !agent ||
        !(await resource.canWrite(agent.subject)) ||
        property.get(core.properties.datatype) !== Datatype.STRING
      )
        continue;

      // Shared/public source content cannot become a private draft through an inline edit.
      try {
        await assertPrivateWebsiteParent(store, binding.subject);
      } catch {
        continue;
      }

      const original = resource.get(binding.property) ?? '';
      if (typeof original !== 'string' || element.textContent !== original)
        continue;
      next.push({ element, field: { ...binding, original } });
    }

    if (!frame.isConnected || frame.contentDocument !== doc) return;
    next.forEach(target => {
      target.element.textContent = '';
    });
    setTargets(next);
  };

  const commit = (target: string, value: string) => {
    const binding = targets[Number(target)];
    if (!binding || saving) return;
    setSaving(true);
    setError('');
    setSaved(false);
    commitWebsiteField(store, artifact.project, binding.field, value)
      .then(() => {
        setTargets(current =>
          current.map(item =>
            item === binding
              ? { ...item, field: { ...item.field, original: value } }
              : item,
          ),
        );
        setSaved(true);
      })
      .catch(cause => {
        store.notifyError(
          cause instanceof Error ? cause : new Error(String(cause)),
        );
      })
      .finally(() => setSaving(false));
  };

  return (
    <>
      <p>
        Click an outlined text field to edit its Atomic record. Leave the field
        to save. Document formatting stays in the document editor.
      </p>
      {error && <p role='alert'>{error}</p>}
      <p role='status'>
        {saving
          ? 'Saving content…'
          : saved
            ? 'Content saved. The existing release is unchanged.'
            : `${targets.length} editable text fields`}
      </p>
      <iframe
        title='Website preview'
        sandbox='allow-same-origin'
        srcDoc={html}
        onLoad={event => {
          void setup(event.currentTarget).catch(cause =>
            setError(String(cause)),
          );
        }}
      />
      <EditModeProvider active={!saving} commit={commit}>
        {targets.map((target, index) =>
          createPortal(
            <Editable target={String(index)} multiline allowEmpty>
              {target.field.original}
            </Editable>,
            target.element,
            String(index),
          ),
        )}
      </EditModeProvider>
    </>
  );
}
