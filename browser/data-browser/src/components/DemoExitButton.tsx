import { Button } from './Button';
import { SetupBar, ShortLabel } from './SetupBar';
import { useState } from 'react';
import { useResource, useStore } from '@tomic/react';
import { useNavigate } from '@tanstack/react-router';
import { constructOpenURL } from '../helpers/navigation';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { fetchPrivateDriveSubject } from '../helpers/privateDrive';
import type { ActiveDemo, TemplateDemo } from '../chunks/Templates/demoSession';
import { leaveTemplatePreview } from '../chunks/Templates/leaveTemplatePreview';
import { paths } from '../routes/paths';

/**
 * The setup bar on the pages of a demo drive: the interactive demo or a
 * template preview. `NavWrapper` decides *whether* to show it
 * (`demoForDrive`); the template gallery renders its own `SetupBar`, with a
 * way back here. Labels only name places the user has actually been.
 */
export function DemoActionsBar({
  demo,
}: {
  demo: ActiveDemo;
}): React.JSX.Element {
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const routerNavigate = useNavigate();
  const [leaving, setLeaving] = useState(false);

  function toStartScreen() {
    routerNavigate({
      to: paths.welcome,
      search: { next: undefined, from_portal: undefined },
      replace: true,
    });
  }

  async function exitInteractiveDemo(demoDrive: string) {
    if (leaving) return;
    setLeaving(true);

    // Nothing in here may leave the user stranded in the demo with a stuck
    // "Leaving…" button: the `catch` always navigates out and falls through
    // to the reset below, and the personal-drive lookup is time-boxed (a guest's DID isn't
    // on the server, so that fetch can stall indefinitely).
    try {
      try {
        const { stopDemoDirector } = await import('../chunks/Demo/startDemo');
        stopDemoDirector();
      } catch {
        // The demo chunk failing to load must not trap the user here.
      }

      const agent = store.getAgent();
      const home = agent
        ? await withTimeout(
            fetchPrivateDriveSubject(store, agent).catch(() => undefined),
            2500,
          )
        : undefined;
      const target = home && home !== demoDrive ? home : undefined;

      store.setDrive(target ?? '');
      const { cleanupDemoDrive } = await import('../chunks/Demo/startDemo');
      await cleanupDemoDrive(store, demoDrive);
      localStorage.removeItem('atomic.demoWorkspace');
      // Back to where the visitor came from: their own drive, or for a guest
      // the start screen. The gallery is what "Choose a template" is for.
      if (target) navigate({ to: constructOpenURL(target), replace: true });
      else toStartScreen();
    } catch {
      // Last resort — the start screen, never a deleted demo drive.
      store.setDrive('');
      toStartScreen();
    }

    setLeaving(false);
  }

  function backToTemplates(session: TemplateDemo) {
    leaveTemplatePreview(store, session, navigate, async () => {
      const { cleanupDemoDrive } = await import('../chunks/Demo/startDemo');
      await cleanupDemoDrive(store, session.drive);
    });
  }

  if (demo.kind === 'interactive') {
    return (
      <SetupBar title='Demo workspace'>
        <Button
          subtle
          disabled={leaving}
          onClick={() => void exitInteractiveDemo(demo.drive)}
        >
          Leave demo
        </Button>
        <Button disabled={leaving} onClick={() => navigate(paths.newDrive)}>
          Choose a template
        </Button>
      </SetupBar>
    );
  }

  return (
    <SetupBar title={<PreviewTitle drive={demo.session.drive} />}>
      <Button subtle onClick={() => backToTemplates(demo.session)}>
        <ShortLabel full='Back to templates' short='Back' />
      </Button>
      <Button
        onClick={() =>
          navigate(
            `/app/new-drive?template=${encodeURIComponent(demo.session.template)}&keep_preview=1`,
          )
        }
      >
        Use this template
      </Button>
    </SetupBar>
  );
}

/** "Preview: Student demo", from the preview drive's own name. */
function PreviewTitle({ drive }: { drive: string }): React.JSX.Element {
  const resource = useResource(drive);

  return <>Preview: {resource.title}</>;
}

/** Resolve `p`, but give up with `undefined` after `ms` — so a hung fetch
 *  can't freeze the caller. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    p,
    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms)),
  ]);
}
