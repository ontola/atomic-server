import { useRef, useState } from 'react';
import { useResource, useStore } from '@tomic/react';
import type { ImporterRunResult } from '@tomic/plugin';
import { Button } from '@components/Button';
import { Row } from '@components/Row';
import { ProxyConsentBar, ProxyConsentText } from '@components/ProxyConsentBar';
import { RunPluginDialog } from '@chunks/PluginRuns/RunPluginDialog';
import {
  acceptAttribute,
  previewImport,
  readUpload,
  type ImportUpload,
} from '@chunks/PluginRuns/importFile';
import {
  importerRunSummary,
  type AppImporter,
  type HostReply,
} from './hostStore';

/** An app's `store.importer.run()`, waiting for the person. */
export interface ImporterAsk {
  id: number | string;
  resolved: AppImporter;
  reply: (reply: HostReply) => void;
}

/**
 * The person's side of an app running its own importer.
 *
 * Drawn by this page, not the frame: the frame is sandboxed, so the file
 * picker has to be the host's, and only a click here counts as the person
 * agreeing. The run then goes through the same preview and review as the
 * importer's own Import tab ({@link RunPluginDialog}); nothing is written
 * unless the person applies it there. The app hears back once, with counts.
 */
export function AppImporterRun({
  ask,
  drive,
  onDone,
}: {
  ask: ImporterAsk;
  drive: string;
  onDone: () => void;
}): React.JSX.Element {
  const store = useStore();
  const { resolved } = ask;
  const resource = useResource(resolved.importer);
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<'ask' | 'previewing'>('ask');
  const [verdict, setVerdict] = useState<string>();
  const accepts = resolved.manifest.accepts ?? [];

  const finish = (result: ImporterRunResult) => {
    ask.reply({ id: ask.id, result });
    onDone();
  };

  const preview = (upload: Promise<ImportUpload>) => {
    setStep('previewing');
    upload
      .then(file =>
        previewImport(store, {
          drive,
          plugin: resolved.importer,
          source: resolved.source,
          config: resolved.config,
          upload: file,
        }),
      )
      .then(setVerdict)
      .catch((e: Error) =>
        finish(importerRunSummary(resolved.importer, { error: e.message })),
      );
  };

  const cancel = () =>
    finish({ status: 'cancelled', importer: resolved.importer });

  return (
    <>
      {verdict === undefined && (
        <ProxyConsentBar aria-label='Import with this app'>
          {resolved.upload ? (
            <AskWithFile
              file={resolved.upload.name}
              importer={resolved.title}
            />
          ) : (
            <AskForFile importer={resolved.title} />
          )}
          <Row gap='0.5rem'>
            {resolved.upload ? (
              <Button
                disabled={step !== 'ask'}
                onClick={() => preview(Promise.resolve(resolved.upload!))}
              >
                {step === 'previewing'
                  ? 'Preparing preview…'
                  : 'Preview import'}
              </Button>
            ) : (
              <Button
                disabled={step !== 'ask'}
                onClick={() => input.current?.click()}
              >
                {step === 'previewing' ? 'Preparing preview…' : 'Choose file'}
              </Button>
            )}
            <Button subtle disabled={step !== 'ask'} onClick={cancel}>
              Cancel
            </Button>
          </Row>
          <input
            ref={input}
            type='file'
            hidden
            aria-label='File to import'
            accept={acceptAttribute(accepts)}
            onChange={event => {
              const file = event.target.files?.[0];
              if (file) preview(readUpload(file, accepts));
            }}
          />
        </ProxyConsentBar>
      )}
      {verdict !== undefined && (
        <RunPluginDialog
          resource={resource}
          drive={drive}
          show
          verdict={verdict}
          triggerKind='manual'
          onShowChange={() => undefined}
          onFinished={outcome =>
            finish(
              outcome.report && outcome.plan
                ? importerRunSummary(resolved.importer, {
                    report: outcome.report,
                    plan: outcome.plan,
                  })
                : importerRunSummary(resolved.importer, { plan: outcome.plan }),
            )
          }
        />
      )}
    </>
  );
}

/** The ask, naming the file the app handed over. */
function AskWithFile({
  file,
  importer,
}: {
  file: string;
  importer: string;
}): React.JSX.Element {
  return (
    <ProxyConsentText>
      This app wants to import <strong>{file}</strong> with{' '}
      <strong>{importer}</strong>. You review the changes before anything is
      saved.
    </ProxyConsentText>
  );
}

/** The ask when the person chooses the file here. */
function AskForFile({ importer }: { importer: string }): React.JSX.Element {
  return (
    <ProxyConsentText>
      This app wants to import a file with <strong>{importer}</strong>. Choose
      the file here. You review the changes before anything is saved.
    </ProxyConsentText>
  );
}
