import { Button } from '@components/Button';
import { PopoverContainer } from '@components/Popover';
import { useWebsitePreviewHtml } from './useWebsitePreviewHtml';
import { lazy, Suspense, useState } from 'react';
import { StyleSheetManager } from 'styled-components';
import { createPortal } from 'react-dom';
import { Editable, EditModeProvider } from '@tomic/edit-mode/react';
import {
  core,
  dataBrowser,
  Datatype,
  useStore,
  type Resource,
} from '@tomic/react';
import type { WebsiteArtifact } from './renderWebsite';
import {
  commitWebsiteField,
  pageFields,
  type WebsiteField,
} from './websiteInlineEditing';
import { assertPrivateWebsiteParent } from './websiteModel';

const CollaborativeEditor = lazy(() => import('../RTE/CollaborativeEditor'));
interface DocumentTarget {
  element: Element;
  resource: Resource;
}

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
  const [documents, setDocuments] = useState<DocumentTarget[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const page =
    artifact.config.pages.find(candidate => candidate.path === pagePath) ??
    artifact.config.pages[0];
  // The sandbox blocks scripts anyway; dropping the runtime tag avoids a console error per load.
  const html = artifact.files[`${page.path.slice(1)}index.html`].replace(
    '<script src="website-runtime.js" defer></script>',
    '',
  );

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
        ![Datatype.STRING, Datatype.INTEGER, Datatype.FLOAT].includes(
          property.get(core.properties.datatype) as Datatype,
        )
      )
        continue;

      // Shared/public source content cannot become a private draft through an inline edit.
      try {
        await assertPrivateWebsiteParent(store, binding.subject);
      } catch {
        continue;
      }

      const original = resource.get(binding.property) ?? '';
      if (
        !['string', 'number'].includes(typeof original) ||
        element.textContent !== String(original)
      )
        continue;
      next.push({
        element,
        field: { ...binding, original: original as string | number },
      });
    }

    const documentTargets: DocumentTarget[] = [];

    for (const [index, subject] of page.documents.entries()) {
      const element =
        doc.querySelector(`[data-website-document="${index}"]`) ??
        doc.querySelectorAll('article')[index];
      if (!element) continue;
      const resource = await store.getResource(subject);
      const agent = store.getAgent();
      if (
        !agent ||
        !(await resource.canWrite(agent.subject)) ||
        !resource.getLoroDoc()
      )
        continue;

      try {
        await assertPrivateWebsiteParent(store, subject);
      } catch {
        continue;
      }

      documentTargets.push({ element, resource });
    }

    if (!frame.isConnected || frame.contentDocument !== doc) return;
    next.forEach(target => {
      target.element.textContent = '';
    });
    documentTargets.forEach(target => {
      target.element.textContent = '';
    });
    setDocuments(documentTargets);
    setTargets(next);
  };

  const commit = (target: string, value: string) => {
    const binding = targets[Number(target)];
    if (!binding || saving) return;
    setSaving(true);
    setError('');
    setSaved(false);
    commitWebsiteField(store, artifact.project, binding.field, value)
      .then(parsed => {
        setTargets(current =>
          current.map(item =>
            item === binding
              ? { ...item, field: { ...item.field, original: parsed } }
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

  const previewHtml = useWebsitePreviewHtml(html, artifact);

  if (previewHtml.error)
    return (
      <div role='alert'>
        <p>{previewHtml.error}</p>
        <Button subtle onClick={previewHtml.retry}>
          Retry preview
        </Button>
      </div>
    );

  return (
    <>
      <p>
        Click an outlined field to edit its Atomic record. Leave the field to
        save. Documents save automatically as you type.
      </p>
      {error && <p role='alert'>{error}</p>}
      <p role='status'>
        {saving
          ? 'Saving content…'
          : saved
            ? 'Content saved. The existing release is unchanged.'
            : `${targets.length} editable fields and ${documents.length} documents`}
      </p>
      <iframe
        title='Website preview'
        sandbox='allow-same-origin'
        srcDoc={previewHtml.html}
        onLoad={event => {
          void setup(event.currentTarget).catch(cause => {
            setError(String(cause));
            store.notifyError(
              cause instanceof Error ? cause : new Error(String(cause)),
            );
          });
        }}
      />
      {documents.map(({ element, resource }) =>
        createPortal(
          <StyleSheetManager target={element.ownerDocument.head}>
            {/* Popovers (link form) must portal into the iframe, not the app document. */}
            <PopoverContainer>
              <Suspense fallback={<p>Loading document editor…</p>}>
                <CollaborativeEditor
                  embedded
                  menuContainer={element.ownerDocument.body}
                  resource={resource}
                  doc={resource.getLoroDoc()!}
                  property={dataBrowser.properties.documentContent}
                />
              </Suspense>
            </PopoverContainer>
          </StyleSheetManager>,
          element,
          resource.subject,
        ),
      )}
      <EditModeProvider active={!saving} commit={commit}>
        {targets.map((target, index) =>
          createPortal(
            <Editable
              target={String(index)}
              multiline={typeof target.field.original === 'string'}
              allowEmpty
            >
              {String(target.field.original)}
            </Editable>,
            target.element,
            String(index),
          ),
        )}
      </EditModeProvider>
    </>
  );
}
