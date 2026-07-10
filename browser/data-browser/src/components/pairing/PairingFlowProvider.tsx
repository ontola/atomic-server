import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { styled } from 'styled-components';
import { FaCheck, FaCircleExclamation } from 'react-icons/fa6';
import { useStore } from '@tomic/react';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '../Dialog';
import { Button } from '../Button';
import { Spinner } from '../Spinner';
import { runPairing } from '../../helpers/pairing';

export interface StartPairingOptions {
  /** The drive to pull. Defaults to whatever this device is currently on. */
  drive?: string;
  /**
   * Resolves the drive once it has actually landed on this device, or
   * `undefined` if it hasn't. Supplying it adds the second step to the dialog:
   * a peer sync answers as soon as the push is imported, which is a moment
   * before the drive becomes readable.
   */
  awaitWorkspace?: () => Promise<string | undefined>;
  /** Called when the user chooses to open the workspace that just arrived. */
  onWorkspaceReady?: (drive: string) => void;
}

type Phase =
  | { kind: 'closed' }
  /** Dialing the peer, proving the agent key, reconciling. */
  | { kind: 'connecting' }
  /** Synced; now waiting for the drive to become readable. */
  | { kind: 'awaiting-workspace'; peerName?: string; count: number }
  | {
      kind: 'done';
      peerName?: string;
      /** Absent when there was no drive to sync — the peer is just remembered. */
      count?: number;
      /** Absent when a workspace was expected but hasn't landed yet. */
      drive?: string;
      workspaceExpected: boolean;
    }
  | { kind: 'error'; message: string };

type StartPairing = (code: string, options?: StartPairingOptions) => void;

const PairingFlowContext = createContext<StartPairing>(() => undefined);

/** Start the pairing flow for a scanned, pasted, or deep-linked code. */
export function usePairingFlow(): StartPairing {
  return useContext(PairingFlowContext);
}

function isRunning(phase: Phase): boolean {
  return phase.kind === 'connecting' || phase.kind === 'awaiting-workspace';
}

/**
 * Owns the one dialog that every pairing entry point drives — the in-app
 * scanner, the paste field, and a tapped `atomic://pair` deep link.
 *
 * Pairing is a short linear flow with a couple of waits in it, so it reads as
 * steps rather than as a status line plus a toast that lands after the user has
 * looked away.
 */
export function PairingFlowProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const store = useStore();
  const [phase, setPhase] = useState<Phase>({ kind: 'closed' });
  // Kept so "Try again" doesn't make the user re-scan.
  const [lastAttempt, setLastAttempt] = useState<{
    code: string;
    options?: StartPairingOptions;
  }>();
  // A dismissed dialog must not be resurrected by the run it was showing.
  const runId = useRef(0);

  const [dialogProps, showDialog, closeDialog] = useDialog({
    bindShow: open => {
      if (!open) {
        runId.current++;
        setPhase({ kind: 'closed' });
      }
    },
  });

  const run = useCallback(
    async (code: string, options?: StartPairingOptions) => {
      const id = ++runId.current;
      const stale = () => runId.current !== id;

      setLastAttempt({ code, options });
      setPhase({ kind: 'connecting' });

      const drive = options?.drive ?? store.getSyncStatus().drive;
      const result = await runPairing(code, drive);

      if (stale()) return;

      if (!result.ok) {
        setPhase({ kind: 'error', message: result.message });

        return;
      }

      const peerName = result.outcome?.peerName;
      // `undefined` when there was no drive to sync: the peer is recorded, and
      // a later sync (Sync page, auto-connect) will use it.
      const count = result.outcome?.count;

      if (!options?.awaitWorkspace) {
        setPhase({ kind: 'done', peerName, count, workspaceExpected: false });

        return;
      }

      setPhase({ kind: 'awaiting-workspace', peerName, count: count ?? 0 });
      const arrived = await options.awaitWorkspace();

      if (stale()) return;

      setPhase({
        kind: 'done',
        peerName,
        count,
        drive: arrived,
        workspaceExpected: true,
      });
    },
    [store],
  );

  const start = useCallback<StartPairing>(
    (code, options) => {
      showDialog();
      void run(code, options);
    },
    [run, showDialog],
  );

  const openWorkspace = (drive: string) => {
    const onReady = lastAttempt?.options?.onWorkspaceReady;
    closeDialog();
    onReady?.(drive);
  };

  return (
    <PairingFlowContext.Provider value={start}>
      {children}
      <Dialog {...dialogProps}>
        <DialogTitle>
          <h1>Pairing device</h1>
        </DialogTitle>
        <DialogContent>
          <Steps>
            <Step status={connectStatus(phase)} label={connectLabel(phase)} />
            {expectsWorkspace(phase) && (
              <Step
                status={workspaceStatus(phase)}
                label={workspaceLabel(phase)}
              />
            )}
          </Steps>

          {phase.kind === 'error' && (
            <Explainer role='alert'>{phase.message}</Explainer>
          )}
          {phase.kind === 'done' && phase.workspaceExpected && !phase.drive && (
            <Explainer role='status'>
              The device is paired, so this can still finish on its own. If it
              doesn’t, check that the other device is online and signed in as
              you.
            </Explainer>
          )}
        </DialogContent>
        <DialogActions>
          {phase.kind === 'error' && lastAttempt && (
            <Button
              subtle
              onClick={() => void run(lastAttempt.code, lastAttempt.options)}
            >
              Try again
            </Button>
          )}
          {phase.kind === 'done' && phase.drive && (
            <Button onClick={() => openWorkspace(phase.drive!)}>
              Open workspace
            </Button>
          )}
          <Button
            subtle={phase.kind === 'done' && !!phase.drive}
            disabled={isRunning(phase)}
            onClick={() => closeDialog()}
          >
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </PairingFlowContext.Provider>
  );
}

function expectsWorkspace(phase: Phase): boolean {
  return (
    phase.kind === 'awaiting-workspace' ||
    (phase.kind === 'done' && phase.workspaceExpected)
  );
}

function connectStatus(phase: Phase): StepStatus {
  if (phase.kind === 'connecting') return 'active';
  if (phase.kind === 'error') return 'failed';
  if (phase.kind === 'closed') return 'pending';

  return 'done';
}

function connectLabel(phase: Phase): string {
  if (phase.kind === 'connecting') {
    return 'Connecting to the device…';
  }

  if (phase.kind === 'error') {
    return 'Could not connect';
  }

  if (phase.kind === 'awaiting-workspace' || phase.kind === 'done') {
    const device = phase.peerName ?? 'the device';

    // No count means there was no drive to sync — we only recorded the peer.
    if (phase.kind === 'done' && phase.count === undefined) {
      return `Paired with ${device}`;
    }

    const count = phase.kind === 'done' ? phase.count! : phase.count;
    const resources = count === 1 ? 'resource' : 'resources';

    return `Synced ${count} ${resources} with ${device}`;
  }

  return 'Connect to the device';
}

function workspaceStatus(phase: Phase): StepStatus {
  if (phase.kind === 'awaiting-workspace') return 'active';
  if (phase.kind === 'done') return phase.drive ? 'done' : 'failed';

  return 'pending';
}

function workspaceLabel(phase: Phase): string {
  if (phase.kind === 'awaiting-workspace') {
    return 'Bringing your workspace over…';
  }

  if (phase.kind === 'done') {
    return phase.drive
      ? 'Your workspace is here'
      : 'Your workspace hasn’t arrived yet';
  }

  return 'Bring your workspace over';
}

type StepStatus = 'pending' | 'active' | 'done' | 'failed';

function Step({
  status,
  label,
}: {
  status: StepStatus;
  label: string;
}): JSX.Element {
  return (
    <StepRow $status={status}>
      <StepIcon>
        {status === 'active' && <Spinner size='1.1rem' inheritColor />}
        {status === 'done' && <FaCheck aria-hidden />}
        {status === 'failed' && <FaCircleExclamation aria-hidden />}
        {status === 'pending' && <PendingDot aria-hidden />}
      </StepIcon>
      <span>{label}</span>
    </StepRow>
  );
}

const Steps = styled.ol`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
`;

const StepRow = styled.li<{ $status: StepStatus }>`
  display: flex;
  align-items: center;
  gap: 0.7rem;
  font-size: 0.95rem;
  color: ${p =>
    p.$status === 'pending' ? p.theme.colors.textLight : p.theme.colors.text};

  svg {
    color: ${p =>
      p.$status === 'failed' ? p.theme.colors.alert : p.theme.colors.main};
  }
`;

const StepIcon = styled.span`
  flex-shrink: 0;
  width: 1.2rem;
  height: 1.2rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: ${p => p.theme.colors.main};
`;

const PendingDot = styled.span`
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: ${p => p.theme.colors.bg2};
`;

const Explainer = styled.p`
  margin-top: 1rem;
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85rem;
`;
