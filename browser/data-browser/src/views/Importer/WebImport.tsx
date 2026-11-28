import {
  core,
  importLocalId,
  offersAiExtraction,
  proposeImport,
  type ImportCapture,
  useResource,
  useStore,
  type ImportProposal,
  type JSONValue,
} from '@tomic/react';
import { useEffect, useId, useRef, useState, type JSX } from 'react';
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
import { useAISettings } from '@components/AI/AISettingsContext';
import { AIProvider } from '@components/AI/aiContstants';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';

// The AI SDK only loads when someone asks for extraction.
const loadExtractor = () => import('@chunks/AI/importExtract');

type Analysis = {
  proposal: ImportProposal;
  /** What was pasted, for the AI step. */
  capture: ImportCapture;
  /** The plain proposal that AI extraction replaced, to go back to. */
  plain?: ImportProposal;
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

  // The shared import identity: same drive, same folder, same source URL.
  const locate = async (proposal: ImportProposal) => {
    const found = proposal.sourceUrl
      ? await store.findByLocalId(
          drive,
          target,
          importLocalId(proposal.sourceUrl),
        )
      : undefined;

    // An earlier import of another kind is not updated into this one.
    return found?.hasClasses(proposal.class) ? found.subject : undefined;
  };

  const analyse = async () => {
    setError(undefined);
    const capture = { url, text };
    const proposal = proposeImport(capture);

    if (!proposal) {
      setAnalysis(undefined);
      setError('Add a web address or paste some text or page source.');

      return;
    }

    setBusy(true);

    try {
      setAnalysis({
        proposal,
        capture,
        existing: await locate(proposal),
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
      {analysis && offersAiExtraction(analysis.proposal) && (
        <AIExtract
          analysis={analysis}
          onResult={async (proposal, plain) =>
            setAnalysis({
              ...analysis,
              proposal,
              plain,
              existing: await locate(proposal),
              run: analysis.run + 1,
            })
          }
        />
      )}
      {analysis?.plain && (
        <div>
          <Button
            subtle
            onClick={() =>
              setAnalysis({
                ...analysis,
                proposal: analysis.plain!,
                plain: undefined,
                existing: undefined,
                run: analysis.run + 1,
              })
            }
          >
            Back to the plain link
          </Button>
        </div>
      )}
      {analysis && (
        <Proposal key={target} analysis={analysis} parent={target} />
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

  if (source === 'ai') return <>AI read the page and filled in this item.</>;

  return <>Found only an address.</>;
}

function AINotes({
  proposal,
}: {
  proposal: ImportProposal;
}): JSX.Element | null {
  const ai = proposal.ai;

  if (!ai) return null;

  return (
    <>
      {ai.reason && <p data-test='import-ai-reason'>{ai.reason}</p>}
      {ai.dropped.length > 0 && (
        <p>{`Left out because they did not fit: ${ai.dropped.map(d => d.property).join(', ')}`}</p>
      )}
      {ai.missing.length > 0 && (
        <p>{`Still to fill in: ${ai.missing.join(', ')}`}</p>
      )}
    </>
  );
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
      <AINotes proposal={proposal} />
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
        <NewForm key={proposal.class} proposal={proposal} parent={parent} />
      )}
    </Column>
  );
}

function splitIdentity(proposal: ImportProposal) {
  const fields = { ...proposal.propvals };
  const identity = fields[core.properties.localId];

  delete fields[core.properties.localId];

  return { identity, fields };
}

function NewForm({
  proposal,
  parent,
}: {
  proposal: ImportProposal;
  parent: string;
}): JSX.Element {
  const klass = useResource(proposal.class);
  // The import identity is set at save time, so an unsaved draft is never
  // mistaken for an earlier import.
  const { identity, fields: initialProps } = splitIdentity(proposal);
  const { initialized, resource } = useNewForm({
    klass,
    setSubject: () => undefined,
    parent,
    initialProps,
  });

  const applied = useRef<string[]>([]);

  // A second Preview reuses this draft: its values are replaced in place.
  useEffect(() => {
    if (!initialized) return;

    const { fields } = splitIdentity(proposal);

    (async () => {
      for (const prop of applied.current) {
        if (!(prop in fields)) await resource.remove(prop);
      }

      for (const [prop, value] of Object.entries(fields)) {
        await resource.set(prop, value as JSONValue);
      }

      applied.current = Object.keys(fields);
    })();
  }, [initialized, resource, proposal]);

  if (!initialized) return <p>Preparing...</p>;

  return (
    // Without validation `set` writes synchronously, so this lands before the
    // form's own submit handler signs the resource.
    <div
      onSubmitCapture={() => {
        if (typeof identity === 'string') {
          void resource.set(core.properties.localId, identity, false);
        }
      }}
    >
      <ResourceForm resource={resource} classSubject={proposal.class} />
    </div>
  );
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

/**
 * Offers AI extraction when the plain import found little. The model sees a
 * bounded text snapshot and may only choose an existing class; its answer is a
 * proposal in the form below, never saved by itself.
 */
function AIExtract({
  analysis,
  onResult,
}: {
  analysis: Analysis;
  onResult: (proposal: ImportProposal, plain: ImportProposal) => Promise<void>;
}): JSX.Element {
  const store = useStore();
  const { drive } = useSettings();
  const navigate = useNavigateWithTransition();
  const settings = useAISettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const {
    enableAI,
    hostedAI,
    enableIncludedAI,
    defaultChatModel,
    genFeaturesModel,
    isProviderAvailable,
  } = settings;
  const model = [defaultChatModel, genFeaturesModel].find(m =>
    isProviderAvailable(m.provider),
  );
  const openSettings = () => navigate('/app/settings?q=ai');

  if (!enableAI || !model) {
    return (
      <Column gap='0.5rem' data-test='import-ai-setup'>
        <p>
          {enableAI
            ? 'AI can read this page and file it under a better kind of item. Set up a model first.'
            : 'AI is turned off. Turn it on in the settings to let it read this page and file it under a better kind of item.'}
        </p>
        <div>
          <Button subtle onClick={openSettings}>
            Set up AI
          </Button>
        </div>
      </Column>
    );
  }

  const run = async () => {
    setError(undefined);
    setBusy(true);

    try {
      if (model.provider === AIProvider.Hosted && !hostedAI?.consent) {
        await enableIncludedAI();
      }

      const { runImportExtraction } = await loadExtractor();
      const proposal = await runImportExtraction({
        store,
        drive,
        capture: analysis.capture,
        fallback: analysis.proposal,
        identifier: model,
        settings,
        hint: analysis.proposal.detected.schemaType,
      });

      await onResult(proposal, analysis.proposal);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'The AI could not read this page.',
      );
    }

    setBusy(false);
  };

  return (
    <Column gap='0.5rem' data-test='import-ai'>
      <p>
        The plain import found little to go on. AI can read the page and choose
        one of the kinds of item you already have.
      </p>
      <div>
        <Button data-test='import-ai-run' onClick={run} disabled={busy}>
          {busy ? 'Reading the page...' : 'Extract with AI'}
        </Button>
      </div>
      <p>
        {model.provider === AIProvider.Hosted
          ? 'Sends the page title and its main text (at most 8,000 characters) through Atomic to its AI providers. You review the result before anything is saved.'
          : model.provider === AIProvider.Ollama
            ? 'Sends the page title and its main text (at most 8,000 characters) to your Ollama server. You review the result before anything is saved.'
            : 'Sends the page title and its main text (at most 8,000 characters) to OpenRouter. You review the result before anything is saved.'}
      </p>
      {error && <InlineErrMessage>{error}</InlineErrMessage>}
    </Column>
  );
}
