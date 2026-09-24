import { Button } from './Button';
import { useState } from 'react';
import { styled } from 'styled-components';
import { useStore } from '@tomic/react';
import { useNavigate } from '@tanstack/react-router';
import { constructOpenURL } from '../helpers/navigation';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { fetchPrivateDriveSubject } from '../helpers/privateDrive';
import type { ActiveDemo, TemplateDemo } from '../chunks/Templates/demoSession';
import { leaveTemplatePreview } from '../chunks/Templates/leaveTemplatePreview';
import { paths } from '../routes/paths';

/**
 * The bar above navigation while the current drive is a demo drive — the
 * interactive demo or a template preview — on every page of it, including the
 * template gallery. `NavWrapper` decides *whether* to show it
 * (`demoForDrive`); this only decides what it offers:
 *
 * - interactive demo: leave it, or go on to choosing a template;
 * - template preview: back to the gallery it was picked from, or keep it;
 * - on the gallery itself: back to the demo or preview that is still open.
 *
 * The labels only name places the user has actually been.
 */
export function DemoActionsBar({
  demo,
  onGallery,
}: {
  demo: ActiveDemo;
  onGallery: boolean;
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
    // "Leaving…" button: `finally` always resets, a `catch` always navigates
    // out, and the personal-drive lookup is time-boxed (a guest's DID isn't
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
    } finally {
      setLeaving(false);
    }
  }

  function backToTemplates(session: TemplateDemo) {
    leaveTemplatePreview(store, session, navigate, async () => {
      const { cleanupDemoDrive } = await import('../chunks/Demo/startDemo');
      await cleanupDemoDrive(store, session.drive);
    });
  }

  if (onGallery) {
    const [label, target] =
      demo.kind === 'interactive'
        ? ['Back to the demo', demo.welcomeDoc]
        : ['Back to the preview', demo.session.drive];

    return (
      <PreviewBar role='region' aria-label='Demo'>
        <Button subtle onClick={() => navigate(constructOpenURL(target))}>
          {label}
        </Button>
      </PreviewBar>
    );
  }

  if (demo.kind === 'interactive') {
    return (
      <PreviewBar role='region' aria-label='Demo'>
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
      </PreviewBar>
    );
  }

  return (
    <PreviewBar role='region' aria-label='Demo'>
      <Button subtle onClick={() => backToTemplates(demo.session)}>
        <BackLabel>Back to templates</BackLabel>
        <ShortBackLabel>Back</ShortBackLabel>
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
    </PreviewBar>
  );
}

/** Resolve `p`, but give up with `undefined` after `ms` — so a hung fetch
 *  can't freeze the caller. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    p,
    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms)),
  ]);
}

const PreviewBar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  height: 100%;
  box-sizing: border-box;
  padding: 0.5rem 1rem;
  button {
    white-space: nowrap;
  }
  @media (max-width: 600px) {
    padding: 0.5rem;
    button {
      font-size: 0.875rem;
    }
  }
  background: ${p => p.theme.colors.bg1};
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
`;

const BackLabel = styled.span`
  @media (max-width: 600px) {
    display: none;
  }
`;
const ShortBackLabel = styled.span`
  display: none;
  @media (max-width: 600px) {
    display: inline;
  }
`;
