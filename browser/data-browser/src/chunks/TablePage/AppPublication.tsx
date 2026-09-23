import { useEffect, useMemo, useState } from 'react';
import { styled } from 'styled-components';
import {
  core,
  Datatype,
  useCanWrite,
  useStore,
  type Resource,
} from '@tomic/react';
import { Button } from '@components/Button';
import Field from '@components/forms/Field';
import { ResourceSelector } from '@components/forms/ResourceSelector';
import { ResourceRow } from '@views/ResourceRow';
import { readTableColumns, type TableColumnInfo } from './tableOps';
import { WebsiteHosting } from '@chunks/Website/WebsiteHosting';
import { WebsitePreview } from '@chunks/Website/WebsitePreview';
import {
  buildWebsiteArtifact,
  saveAppRelease,
} from '@chunks/Website/websiteExport';
import {
  readAppPublicationDraft,
  saveAppPublicationDraft,
  starterWebsite,
} from '@chunks/Website/websiteModel';
import type { WebsiteArtifact } from '@chunks/Website/renderWebsite';

const SCALAR_TYPES: ReadonlySet<Datatype> = new Set([
  Datatype.STRING,
  Datatype.MARKDOWN,
  Datatype.SLUG,
  Datatype.DATE,
  Datatype.TIMESTAMP,
  Datatype.INTEGER,
  Datatype.FLOAT,
  Datatype.BOOLEAN,
]);

/** Explicit, read-only selection for a table App's public snapshot. */
export function AppPublication({
  app,
  table,
}: {
  app: Resource;
  table: Resource;
}) {
  const store = useStore();
  const drive = store.getDrive()!;
  const canWrite = useCanWrite(app);
  const rowClass = table.get(core.properties.classtype) as string | undefined;
  const [columns, setColumns] = useState<TableColumnInfo[]>([]);
  const [columnSubjects, setColumnSubjects] = useState<string[]>([
    core.properties.name,
  ]);
  const [rows, setRows] = useState<string[]>([]);
  const [candidate, setCandidate] = useState<string>();
  const [draft, setDraft] = useState<WebsiteArtifact>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [saving, setSaving] = useState(false);

  // The App stores the pending selection. Changes to source rows never enter a
  // public release until the owner reviews and publishes a new snapshot.
  useEffect(() => {
    if (!rowClass) return;
    let active = true;
    setLoading(true);
    Promise.all([
      store
        .getResource(rowClass)
        .then(resource => readTableColumns(store, resource)),
      readAppPublicationDraft(store, drive, app),
    ])
      .then(([map, config]) => {
        if (!active) return;
        setColumns([
          {
            name: 'Name',
            shortname: 'name',
            subject: core.properties.name,
            datatype: Datatype.STRING,
          },
          ...map.columns.filter(
            column =>
              column.subject !== core.properties.name &&
              SCALAR_TYPES.has(column.datatype),
          ),
        ]);

        if (config) {
          const selection = config.pages[0]?.tables[0];
          if (selection?.table !== table.subject)
            throw new Error('The saved draft does not match this App.');

          if (active) {
            setRows(selection.rows);
            setColumnSubjects(selection.columns.map(column => column.property));
          }
        }

        if (active) {
          setInitialized(true);
          setLoading(false);
        }
      })
      .catch(cause => {
        if (active) {
          setError(`Could not load publication: ${String(cause)}`);
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [store, drive, app, table.subject, rowClass]);

  const selection = useMemo(() => {
    const config = starterWebsite(app.title);
    config.description = '';
    config.pages[0].tables = [
      {
        table: table.subject,
        title: app.title,
        layout: 'table',
        rows,
        columns: columnSubjects.map(subject => ({
          property: subject,
          label:
            columns.find(column => column.subject === subject)?.name ?? 'Name',
        })),
      },
    ];

    return config;
  }, [app.title, table.subject, rows, columnSubjects, columns]);

  useEffect(() => {
    if (!initialized || columnSubjects.length === 0) return;
    let active = true;
    setLoading(true);
    buildWebsiteArtifact(store, app.subject, selection)
      .then(next => {
        if (active) {
          setDraft(next);
          setError('');
          setLoading(false);
        }
      })
      .catch(cause => {
        if (active) {
          setDraft(undefined);
          setError(`Could not build the preview: ${String(cause)}`);
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [
    store,
    app.subject,
    selection,
    initialized,
    columnSubjects.length,
    refresh,
  ]);

  const addRow = async () => {
    if (!candidate || rows.includes(candidate) || rows.length >= 200) return;

    try {
      const resource = await store.getResource(candidate);

      if (
        resource.error ||
        resource.get(core.properties.parent) !== table.subject
      ) {
        setError('Choose a row from this table.');

        return;
      }

      setRows(current => [...current, candidate]);
      setCandidate(undefined);
    } catch (cause) {
      setError(`Could not read the row: ${String(cause)}`);
    }
  };

  const saveDraft = async () => {
    setSaving(true);

    try {
      await saveAppPublicationDraft(store, drive, app, selection);
      setError('');
    } catch (cause) {
      setError(`Could not save the draft: ${String(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel>
      <h2>Publish {app.title}</h2>
      <p>
        Public, read-only snapshot. Select exactly which rows and fields
        visitors can see. Later changes to the source stay private until you
        publish again.
      </p>
      <Selection>
        <div>
          <h3>Fields</h3>
          {columns.map(column => (
            <label key={column.subject}>
              <input
                type='checkbox'
                checked={columnSubjects.includes(column.subject)}
                disabled={!canWrite}
                onChange={event =>
                  setColumnSubjects(current =>
                    event.target.checked
                      ? current.length < 20
                        ? [...current, column.subject]
                        : current
                      : current.filter(subject => subject !== column.subject),
                  )
                }
              />{' '}
              {column.name}
            </label>
          ))}
        </div>
        <div>
          <h3>Rows ({rows.length})</h3>
          {rows.map(subject => (
            <Row key={subject}>
              <ResourceRow subject={subject} clickable />
              <Button
                subtle
                disabled={!canWrite}
                onClick={() =>
                  setRows(current => current.filter(row => row !== subject))
                }
              >
                Remove
              </Button>
            </Row>
          ))}
          {rowClass && rows.length < 200 && canWrite && (
            <>
              <Field label='Add a row' fieldId='publication-row'>
                <ResourceSelector
                  id='publication-row'
                  isA={rowClass}
                  value={candidate}
                  setSubject={setCandidate}
                  hideCreateOption
                />
              </Field>
              <Button
                subtle
                disabled={!candidate}
                onClick={() => void addRow()}
              >
                Add row
              </Button>
            </>
          )}
        </div>
      </Selection>
      <Button
        subtle
        disabled={!canWrite || saving || columnSubjects.length === 0}
        onClick={() => void saveDraft()}
      >
        {saving ? 'Saving…' : 'Save draft'}
      </Button>
      {columnSubjects.length === 0 && (
        <p role='alert'>Select at least one field.</p>
      )}
      {error && (
        <p role='alert'>
          {error}{' '}
          <Button subtle onClick={() => setRefresh(value => value + 1)}>
            Retry
          </Button>
        </p>
      )}
      <h3>Review public output</h3>
      {draft && !loading ? (
        <Preview>
          <WebsitePreview
            artifact={draft}
            pagePath='/'
            onNavigate={() => undefined}
            frozen
          />
        </Preview>
      ) : (
        <p>Preparing preview…</p>
      )}
      <WebsiteHosting
        project={app.subject}
        draft={!loading && columnSubjects.length > 0 ? draft : undefined}
        draftError={
          error || (columnSubjects.length === 0 ? 'Select a field.' : '')
        }
        canWrite={!!canWrite}
        saveRelease={async artifact => {
          await saveAppPublicationDraft(store, drive, app, selection);

          return saveAppRelease(store, app, artifact);
        }}
      />
    </Panel>
  );
}

const Panel = styled.section`
  padding: ${p => p.theme.size(4)};
  max-width: 76rem;
  margin: auto;
  label {
    display: block;
    margin: 0.5rem 0;
  }
`;
const Selection = styled.div`
  display: grid;
  grid-template-columns: minmax(12rem, 1fr) minmax(16rem, 2fr);
  gap: ${p => p.theme.size(4)};
  @media (max-width: 48rem) {
    grid-template-columns: 1fr;
  }
`;
const Row = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
`;
const Preview = styled.div`
  display: flex;
  min-height: 24rem;
  iframe {
    width: 100%;
    min-height: 24rem;
    border: 1px solid ${p => p.theme.colors.bg2};
  }
`;
