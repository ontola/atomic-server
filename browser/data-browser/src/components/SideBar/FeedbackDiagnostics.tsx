import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { useStore } from '@tomic/react';
import { Button } from '../Button';
import { Checkbox } from '../forms/Checkbox';
import { Column } from '../Row';
import { TextAreaStyled } from '../forms/InputStyles';
import {
  previewDiagnostics,
  currentDiagnosticText,
  downloadDiagnostics,
  type DiagnosticPreview,
} from '../../helpers/diagnostic-report';

export function FeedbackDiagnostics({
  onSelect,
  disabled,
}: {
  onSelect: (preview: DiagnosticPreview | undefined) => void;
  disabled: boolean;
}) {
  const includeId = useId();
  const store = useStore();
  const recorder = store.diagnostics;
  const session = useSyncExternalStore(
    recorder.subscribe,
    () => recorder.session,
  );
  const active = useSyncExternalStore(
    recorder.subscribe,
    () => recorder.active,
  );
  const [preview, setPreview] = useState<DiagnosticPreview>();
  const [included, setIncluded] = useState(false);
  const current = preview?.session === session ? preview : undefined;

  useEffect(
    () =>
      recorder.subscribe(() => {
        setPreview(undefined);
        setIncluded(false);
        onSelect(undefined);
      }),
    [recorder, onSelect],
  );

  return (
    <Column>
      <h2>Local diagnostics</h2>
      <p>
        Record save and connection events for troubleshooting. No document text,
        filenames, URLs, or error messages are collected. Recording stays in
        memory: up to 500 events from the last 10 minutes. It stops and clears
        after 30 minutes, on reload, or when switching accounts. Nothing is
        uploaded automatically.
      </p>
      <Button
        subtle
        disabled={disabled}
        onClick={() => {
          if (recorder.active) recorder.clear();
          else {
            recorder.start();
            recorder.connection(store.serverConnected);
            const status = store.getSyncStatus();
            recorder.queue(
              status.pendingDirtyCount,
              status.blockedCount,
              status.serverConnected,
            );
          }
        }}
      >
        {active ? 'Stop and clear recording' : 'Start local recording'}
      </Button>
      {active && (
        <Button
          subtle
          disabled={disabled}
          onClick={() => {
            setPreview(previewDiagnostics(recorder));
            setIncluded(false);
            onSelect(undefined);
          }}
        >
          Preview diagnostics
        </Button>
      )}
      {current && (
        <>
          <p>
            Events show timing and activity counts, which can still be
            sensitive. Review before sharing.
          </p>
          <TextAreaStyled
            aria-label='Diagnostic report preview'
            readOnly
            rows={10}
            value={current.text}
          />
          <label htmlFor={includeId}>
            <Checkbox
              id={includeId}
              checked={included}
              disabled={disabled}
              onChange={value => {
                setIncluded(value);
                onSelect(value ? current : undefined);
              }}
            />
            Include this preview with my feedback
          </label>
          <Button
            subtle
            disabled={disabled}
            onClick={() => {
              const text = currentDiagnosticText(recorder, current);
              if (text) downloadDiagnostics(text);
            }}
          >
            Download diagnostics
          </Button>
        </>
      )}
    </Column>
  );
}
