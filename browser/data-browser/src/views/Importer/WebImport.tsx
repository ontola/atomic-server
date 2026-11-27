import {
  core,
  importLocalId,
  proposeImport,
  useResource,
  useStore,
  type ImportProposal,
  type JSONValue,
} from '@tomic/react';
import { useEffect, useId, useState, type JSX } from 'react';
import { Button } from '../../components/Button.jsx';
import Field from '../../components/forms/Field.jsx';
import {
  InputStyled,
  InputWrapper,
  TextAreaStyled,
} from '../../components/forms/InputStyles.jsx';
import { ResourceForm } from '../../components/forms/ResourceForm';
import { ResourceSelector } from '../../components/forms/ResourceSelector';
import { ResourceInline } from '../ResourceInline/ResourceInline';
import { useSettings } from '../../helpers/AppSettings';
import { useNewForm } from '@tomic/resource-ui/components/forms/NewForm/useNewForm';
import { Column } from '@tomic/ui/components/Row';
import { InlineErrMessage } from '@tomic/ui/components/forms/InputStyles';

type Analysis = {
  proposal: ImportProposal;
  /** Subject of the resource that already has this source URL, if any. */
  existing?: string;
  /** Remounts the form when the user analyses again. */
  run: number;
};

/**
 * Paste a URL and/or the page's text or source. The result is one proposal in
 * the ordinary resource form; nothing is written before Save.
 */
export function WebImport({ parent }: { parent: string }): JSX.Element {
  const store = useStore();
  const { drive } = useSettings();
  const urlId = useId();
  const textId = useId();
  const [target, setTarget] = useState(parent);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [analysis, setAnalysis] = useState<Analysis>();
  const [busy, setBusy] = useState(false);

  const analyse = async () => {
    setError(undefined);
    const proposal = proposeImport({ url, text });

    if (!proposal) {
      setAnalysis(undefined);
      setError('Add a web address or paste some text or page source.');

      return;
    }

    setBusy(true);

    try {
      // The shared import identity: same drive, same folder, same source URL.
      const existing = proposal.sourceUrl
        ? await store.findByLocalId(
            drive,
            target,
            importLocalId(proposal.sourceUrl),
          )
        : undefined;

      setAnalysis({
        proposal,
        existing: existing?.subject,
        run: (analysis?.run ?? 0) + 1,
      });
    } catch (e) {
      setError((e as Error).message);
    }

    setBusy(false);
  };

  return (
    <Column>
      <p>
        Paste the address of a page, its text, or its source. Atomic Server does
        not fetch pages for you: open the page, copy what you want to keep and
        paste it here.
      </p>
      <Field label='Web address' fieldId={urlId}>
        <InputWrapper>
          <InputStyled
            id={urlId}
            type='url'
            placeholder='https://'
            value={url}
            onChange={e => setUrl(e.target.value)}
          />
        </InputWrapper>
      </Field>
      <Field label='Text or page source' fieldId={textId}>
        <InputWrapper>
          <TextAreaStyled
            id={textId}
            rows={10}
            placeholder='Paste text, or the HTML of the page...'
            value={text}
            onChange={e => setText(e.target.value)}
          />
        </InputWrapper>
      </Field>
      <Field
        label='Save in'
        helper='The folder or drive the result is added to.'
      >
        <ResourceSelector
          setSubject={s => s && setTarget(s)}
          value={target}
          hideCreateOption
          hideClearButton
        />
      </Field>
      <div>
        <Button data-test='import-analyse' onClick={analyse} disabled={busy}>
          Preview
        </Button>
      </div>
      {error && <InlineErrMessage>{error}</InlineErrMessage>}
      {analysis && (
        <Proposal
          key={`${analysis.run}${target}`}
          analysis={analysis}
          parent={target}
        />
      )}
    </Column>
  );
}

function Lead({ proposal }: { proposal: ImportProposal }): JSX.Element {
  const { source, schemaType } = proposal.detected;

  if (source === 'json-ld')
    return <>{`Found ${schemaType} data on the page.`}</>;
  if (source === 'opengraph') return <>Found the page title and description.</>;
  if (source === 'page')
    return <>Found no structured data, so this is a plain link.</>;
  if (source === 'text') return <>Found only text.</>;

  return <>Found only an address.</>;
}

function Proposal({
  analysis,
  parent,
}: {
  analysis: Analysis;
  parent: string;
}): JSX.Element {
  const { proposal, existing } = analysis;

  return (
    <Column data-test='import-proposal'>
      <p data-test='import-summary'>
        <Lead proposal={proposal} />
      </p>
      <p>You can edit everything before saving. Nothing is saved yet.</p>
      {existing ? (
        <>
          <p>
            This page was imported before. Saving updates it instead of making a
            copy.
          </p>
          <ResourceInline subject={existing} />
          <UpdateForm subject={existing} proposal={proposal} />
        </>
      ) : (
        <NewForm proposal={proposal} parent={parent} />
      )}
    </Column>
  );
}

function NewForm({
  proposal,
  parent,
}: {
  proposal: ImportProposal;
  parent: string;
}): JSX.Element {
  const klass = useResource(proposal.class);
  const { initialized, resource } = useNewForm({
    klass,
    setSubject: () => undefined,
    parent,
    initialProps: proposal.propvals,
  });

  if (!initialized) return <p>Preparing...</p>;

  return <ResourceForm resource={resource} classSubject={proposal.class} />;
}

function UpdateForm({
  subject,
  proposal,
}: {
  subject: string;
  proposal: ImportProposal;
}): JSX.Element {
  const resource = useResource(subject);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Only in memory: nothing is sent until the form is saved.
      for (const [prop, value] of Object.entries(proposal.propvals)) {
        if (prop !== core.properties.localId) {
          await resource.set(prop, value as JSONValue);
        }
      }

      if (!cancelled) setReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [resource, proposal]);

  if (!ready) return <p>Preparing...</p>;

  return <ResourceForm resource={resource} classSubject={proposal.class} />;
}
