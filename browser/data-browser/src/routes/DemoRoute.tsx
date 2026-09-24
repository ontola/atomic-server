import { createLazyRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import { useSettings } from '../helpers/AppSettings';
import { SIDEBAR_TOGGLE_WIDTH } from '../components/SideBar';
import { useStore, type Store } from '@tomic/react';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../helpers/navigation';
import { isClientDbEnabled, setClientDbEnabled } from '../helpers/clientDbMode';
import { isRunningInTauri } from '../helpers/tauri';
import { Shell } from '../views/getting-started/chrome';
import { Spinner } from '../components/Spinner';
import { Button } from '../components/Button';
import * as Sentry from '@sentry/react';
import type { DemoSetupStep } from '../chunks/Demo/startDemo';
import type { DemoManifest } from '../chunks/Demo/demoWorkspace';
import { localAgentIsDisposable } from '../helpers/managed/reconcile';
import { fetchPrivateDriveSubject } from '../helpers/privateDrive';
import { withDeadline } from '../helpers/withDeadline';
import { readTemplateDemo } from '../chunks/Templates/demoSession';
import { readDemoDrive } from '../components/DemoExitButton';
import { paths } from './paths';

// Setup takes seconds on a laptop and several times that on a phone. Past
// this, say so and offer a way out rather than spin forever: a phone in an
// in-app browser once sat on the spinner with nothing reported (Sentry
// ATOMIC-BROWSER-1G). The step it was on is sent along, so the next such
// report says where it stopped.
const STALLED_AFTER_MS = 45_000;

const STEP_LABELS: Record<DemoSetupStep, string> = {
  storage: 'opening local storage',
  identity: 'creating a guest identity',
  cleanup: 'clearing a previous demo',
  workspace: 'building the demo workspace',
};

type DemoRun = {
  startedAt: number;
  step?: DemoSetupStep;
  error?: Error;
  done: boolean;
  reported: boolean;
};

// One setup at a time, kept outside the component. React 19 StrictMode
// mounts effects twice and navigation can remount the route; without this
// each mount would build a whole demo workspace (see DevDriveRoute for the
// same pattern). It used to be a bare in-flight promise, and a remount then
// lost the run's outcome: the first instance heard the error, the visible one
// kept spinning. Every mount now reads the same run.
let run: DemoRun | undefined;
const listeners = new Set<() => void>();

function updateRun(patch: Partial<DemoRun>): void {
  if (!run) return;
  run = { ...run, ...patch };
  for (const listener of listeners) listener();
}

/**
 * The drive a signed-in visitor lands on instead of the demo: the one open
 * now unless that is a demo drive, else their home. Undefined when neither
 * resolves, which sends them to the drive gallery.
 */
async function signedInDrive(
  store: Store,
  currentDrive: string | undefined,
): Promise<string | undefined> {
  const agent = store.getAgent();
  if (!agent?.subject) return undefined;
  // Guests and identities without a workspace keep getting the demo.
  if (await localAgentIsDisposable(store, agent.subject)) return undefined;

  const demoDrive = readTemplateDemo()?.drive ?? readDemoDrive();
  if (currentDrive && currentDrive !== demoDrive) return currentDrive;

  return (
    (await withDeadline(
      fetchPrivateDriveSubject(store, agent).catch(() => undefined),
      2_500,
      undefined,
    )) ?? paths.newDrive
  );
}

function startRun(
  store: Store,
  currentDrive: string | undefined,
  onReady: (manifest: DemoManifest) => void,
  onSignedIn: (target: string) => void,
): void {
  run = { startedAt: Date.now(), done: false, reported: false };
  // Someone with an account who follows "Try the app" wants their own
  // workspace, not a scripted one built next to it.
  signedInDrive(store, currentDrive)
    .then(async target => {
      if (target) return target;
      const { startDemoWorkspace } = await import('../chunks/Demo/startDemo');

      return startDemoWorkspace(store, step => updateRun({ step }));
    })
    .then(result => {
      updateRun({ done: true });
      if (typeof result === 'string') onSignedIn(result);
      else onReady(result);
    })
    .catch(e => {
      updateRun({
        error: e instanceof Error ? e : new Error('Could not start the demo'),
      });
    });
}

/**
 * Starts the demo workspace immediately: mints a guest agent when
 * nobody is signed in, builds a FRESH drive (cleaning up a previous
 * demo run), starts the scripted scenario, and navigates to the
 * welcome doc. No interstitial — "Try the live demo" means the demo
 * starts.
 */
const DemoRoute: React.FC = () => {
  const store = useStore();
  const { setSideBarLocked, drive, setDrive } = useSettings();
  const navigate = useNavigateWithTransition();
  const [current, setCurrent] = useState<DemoRun | undefined>(run);
  const [stalled, setStalled] = useState(false);

  const supported = isClientDbEnabled();

  useEffect(() => {
    if (!supported) {
      // Under Tauri the ClientDb is merely off by default (the embedded
      // server covers normal persistence), but the demo's local-only drives
      // need it. Opt in and reboot the webview — the worker only spawns at
      // app boot, and this route re-runs with it enabled.
      if (isRunningInTauri()) {
        setClientDbEnabled(true);
        window.location.reload();
      }

      return;
    }

    // Re-running the demo must always start fresh, so only a run still in
    // progress is joined.
    if (!run || run.done || run.error) {
      startRun(
        store,
        drive,
        manifest => {
          if (window.innerWidth < SIDEBAR_TOGGLE_WIDTH) setSideBarLocked(true);
          navigate(constructOpenURL(manifest.welcomeDoc));
        },
        target => {
          if (target === paths.newDrive) {
            navigate(target);

            return;
          }

          setDrive(target);
          navigate(constructOpenURL(target));
        },
      );
    }

    const sync = () => setCurrent(run);
    listeners.add(sync);
    sync();

    const timer = setTimeout(
      () => {
        if (!run || run.done || run.error) return;
        setStalled(true);
        if (run.reported) return;
        run.reported = true;
        Sentry.captureMessage('Demo setup stalled', {
          level: 'warning',
          tags: { demo_step: run.step ?? 'loading' },
        });
      },
      Math.max(0, STALLED_AFTER_MS - (Date.now() - run!.startedAt)),
    );

    return () => {
      listeners.delete(sync);
      clearTimeout(timer);
    };
  }, []);

  const error = current?.error;
  const step = current?.step;

  return (
    <Shell>
      <DemoStatus>
        {!error && <Spinner size='3.5rem' />}
        <DemoTitle>
          {error ? 'The demo could not start' : 'Setting up your demo…'}
        </DemoTitle>
        {!supported && !isRunningInTauri() && (
          <p>
            The demo needs the local database, which is disabled in this
            browser. Enable it on the Sync page and try again.
          </p>
        )}
        {error && <p role='alert'>{error.message}</p>}
        {!error && stalled && (
          <p>
            This is taking longer than usual.
            {step && ` Still busy with: ${STEP_LABELS[step]}.`}
          </p>
        )}
        {(error || stalled) && (
          <Button onClick={() => window.location.reload()}>Try again</Button>
        )}
      </DemoStatus>
    </Shell>
  );
};

const DemoStatus = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${p => p.theme.size(5)};
  max-width: 24rem;
  text-align: center;

  p {
    margin: 0;
    color: ${p => p.theme.colors.textLight};
  }
`;

const DemoTitle = styled.h1`
  margin: 0;
  font-size: 1.4rem;
  font-weight: 700;
  line-height: 1.25;
`;

export const demoRouteLazy = createLazyRoute('/app/demo')({
  component: DemoRoute,
});
