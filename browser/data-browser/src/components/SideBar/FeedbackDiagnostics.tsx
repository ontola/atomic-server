import {
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useStore } from '@tomic/react';
import { getPersistentDiagnostics } from '../../helpers/persistent-diagnostics';
import { Details } from '../Details';
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
  children,
}: {
  onSelect: (preview: DiagnosticPreview | undefined) => void;
  disabled: boolean;
  children?: ReactNode;
}) {
  const includeId = useId();
  const store = useStore();
  const recorder = store.diagnostics;
  const persistence = getPersistentDiagnostics(recorder);
  const persistenceStatus = useSyncExternalStore(
    persistence?.subscribe ?? recorder.subscribe,
    () => persistence?.status ?? 'memory-only',
  );
  const session = useSyncExternalStore(
    recorder.subscribe,
    () => recorder.session,
  );
  const active = useSyncExternalStore(
    recorder.subscribe,
    () => recorder.active,
  );
  const [preview, setPreview] = useState<DiagnosticPreview | undefined>(() =>
    recorder.active ? previewDiagnostics(recorder) : undefined,
  );
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
    <>
      <label htmlFor={includeId}>
        <Checkbox
          id={includeId}
          checked={included}
          disabled={disabled || !current}
          onChange={value => {
            setIncluded(value);
            onSelect(value ? current : undefined);
          }}
        />
        Include diagnostic data
      </label>
      {children}
      <Details title='Diagnostics'>
        <Column>
          <p>
            Recent save and connection events are recorded locally by default.
            No document text, filenames, URLs, or error messages are collected.
            Up to 500 events from the last 10 minutes are kept in this browser,
            including across reloads. Expired records are removed when the app
            next accesses storage. Nothing is uploaded automatically.
          </p>
          {persistenceStatus === 'memory-only' && (
            <p role='status'>
              Diagnostic storage is unavailable. Recent events are only in
              memory and may be lost on reload.
            </p>
          )}
          {persistenceStatus === 'clear-failed' && (
            <p role='alert'>
              Could not clear diagnostic storage or save the recording
              preference. Recording is stopped. Retry clearing before leaving
              this browser.
            </p>
          )}
          {persistenceStatus === 'paused' && (
            <p role='status'>
              Recording was reset in another tab. Reload this tab before
              recording again.
            </p>
          )}
          <Button
            subtle
            disabled={
              disabled ||
              persistenceStatus === 'loading' ||
              persistenceStatus === 'paused'
            }
            onClick={() => {
              if (persistence) {
                void persistence.setEnabled(
                  persistenceStatus === 'clear-failed'
                    ? false
                    : !recorder.active,
                );
              } else if (recorder.active) recorder.clear();
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
            {persistenceStatus === 'clear-failed'
              ? 'Retry clearing diagnostics'
              : active
                ? 'Stop and clear recording'
                : 'Start local recording'}
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
      </Details>
    </>
  );
}
