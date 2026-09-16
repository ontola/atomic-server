import {
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useStore } from '@tomic/react';
import { styled } from 'styled-components';
import { getPersistentDiagnostics } from '../../helpers/persistent-diagnostics';
import { Details } from '../Details';
import { Button } from '../Button';
import { Checkbox } from '../forms/Checkbox';
import { Column, Row } from '../Row';
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
  const [preview, setPreview] = useState<DiagnosticPreview | undefined>();
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
    <DiagnosticsLayout>
      <label htmlFor={includeId}>
        <Checkbox
          id={includeId}
          checked={included}
          disabled={disabled || !active}
          onChange={value => {
            setIncluded(value);

            if (!value) {
              onSelect(undefined);

              return;
            }

            const selected = previewDiagnostics(recorder);

            setPreview(selected);
            onSelect(selected);
          }}
        />
        Include diagnostic data
      </label>
      {children}
      <Details
        title={
          <DiagnosticsTitle>
            <span>Diagnostic data</span>
          </DiagnosticsTitle>
        }
        noIndent
      >
        <DiagnosticsCard>
          <RecordingState $active={active}>
            {active ? 'Recording locally' : 'Not recording'}
          </RecordingState>
          <p>
            Recent save and connection activity only. No document content,
            names, URLs, or error messages. Nothing is shared unless you attach
            it below.
          </p>
          {persistenceStatus === 'memory-only' && (
            <StatusMessage role='status'>
              Kept in this tab only; it will be lost on reload.
            </StatusMessage>
          )}
          {persistenceStatus === 'clear-failed' && (
            <StatusMessage role='alert'>
              Couldn’t clear local diagnostics. Recording is stopped; retry
              before leaving this browser.
            </StatusMessage>
          )}
          {persistenceStatus === 'paused' && (
            <StatusMessage role='status'>
              Reset in another tab. Reload to record again.
            </StatusMessage>
          )}
          <Row gap='0.5rem' wrapItems>
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
                  ? 'Stop and clear'
                  : 'Start recording'}
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
                Review report
              </Button>
            )}
          </Row>
          {current && (
            <ReviewPanel>
              <p>Review the timing and activity counts before sharing.</p>
              <TextAreaStyled
                aria-label='Diagnostic report preview'
                readOnly
                rows={8}
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
                Download report
              </Button>
            </ReviewPanel>
          )}
        </DiagnosticsCard>
      </Details>
    </DiagnosticsLayout>
  );
}

const DiagnosticsLayout = styled(Column)`
  gap: 1rem;
`;

const DiagnosticsTitle = styled.span`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
`;

const RecordingState = styled.span<{ $active: boolean }>`
  color: ${({ theme, $active }) =>
    $active ? theme.colors.main : theme.colors.textLight};
  font-size: 0.8em;
  font-weight: normal;
`;

const DiagnosticsCard = styled(Column)`
  gap: 0.75rem;
  margin: 0.5rem 0 0;
  padding: 0.85rem;
  border: 1px solid ${({ theme }) => theme.colors.bg2};
  border-radius: ${({ theme }) => theme.radius};
  background: ${({ theme }) => theme.colors.bg1};
`;

const StatusMessage = styled.p`
  color: ${({ theme }) => theme.colors.textLight};
`;

const ReviewPanel = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  padding-top: 0.25rem;
  border-top: 1px solid ${({ theme }) => theme.colors.bg2};
`;
