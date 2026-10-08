// @wc-ignore-file
import { createLazyRoute } from '@tanstack/react-router';
import { useState, type JSX } from 'react';
import { useStore } from '@tomic/react';
import { approveLens } from '@chunks/Pieces/lensReview';
import { ContainerFull } from '../components/Containers';
import { Button } from '../components/Button';
import { constructOpenURL } from '../helpers/navigation';
import {
  seedPiecesDemo,
  type SeededDemo,
} from '@chunks/Pieces/demo/seedPiecesDemo';
import { piecesEnabled, setPiecesEnabled } from '@chunks/Pieces/piecesFlag';

/**
 * Dev-only page for the split-pieces exploration: seeds one table view, one
 * integration and one lens into the current drive, switches the flag on, and
 * links to tables that show what is and is not offered.
 */
function PiecesDemo(): JSX.Element {
  const store = useStore();
  const [enabled, setEnabled] = useState(piecesEnabled());
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState<SeededDemo>();
  const [error, setError] = useState<string>();
  const [togglApproved, setTogglApproved] = useState(false);
  const drive = store.getDrive();

  // Reviewing a drive-local lens (Q-089). In a real flow this would sit on the
  // lens's own page, showing the mapping; here one button is enough.
  const approveTogglLens = async () => {
    if (!drive || !seeded) return;

    await approveLens(store, drive, seeded.togglLens);
    setTogglApproved(true);
  };

  const seed = async () => {
    if (!drive) return;
    setBusy(true);
    setError(undefined);

    try {
      setSeeded(await seedPiecesDemo(store, drive));
      setPiecesEnabled(true);
      setEnabled(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ContainerFull>
      <h1>Split pieces demo</h1>
      <p>
        One <strong>table view</strong> (Timesheet, bound to Time entry), two{' '}
        <strong>integrations</strong> (Clockify and Toggl Track, each with its
        own native class, whose tabs show sync state) and two drive-local{' '}
        <strong>lenses</strong> to them from Time entry. The Clockify lens is
        approved; the Toggl lens waits for review. Both platforms are fixtures:
        nothing leaves the browser.
      </p>
      <p>
        Flag: <code>{enabled ? 'on' : 'off'}</code>{' '}
        <Button
          subtle
          onClick={() => {
            setPiecesEnabled(!enabled);
            setEnabled(!enabled);
          }}
        >
          {enabled ? 'Turn off' : 'Turn on'}
        </Button>
      </p>
      {!store.getAgent() || !drive ? (
        <p>
          Sign in first: open <a href='/app/dev-drive'>/app/dev-drive</a>, then
          come back here.
        </p>
      ) : (
        <Button onClick={seed} disabled={busy || !!seeded}>
          {busy ? 'Seeding…' : 'Seed the demo into this drive'}
        </Button>
      )}
      {error && <p role='alert'>Seeding failed: {error}</p>}
      {seeded && (
        <>
          <h2>Lens review</h2>
          <ul>
            <li>
              <a href={constructOpenURL(seeded.lens)}>
                Time entry ↔ Clockify time entry
              </a>
              : approved
            </li>
            <li>
              <a href={constructOpenURL(seeded.togglLens)}>
                Time entry ↔ Toggl time entry
              </a>
              : {togglApproved ? 'approved' : 'waiting for review'}{' '}
              {!togglApproved && (
                <Button subtle onClick={approveTogglLens}>
                  Approve lens
                </Button>
              )}
            </li>
          </ul>
          <h2>Open a table: + adds views, Connect adds integrations</h2>
          <ul>
            <li>
              <a href={constructOpenURL(seeded.hours)}>Hours</a> (Time entry): +
              offers Timesheet. Connect offers Clockify through its lens (with
              an outbox to look at), and Toggl Track once its lens is approved.
            </li>
            <li>
              <a href={constructOpenURL(seeded.clockifyMirror)}>
                Clockify mirror
              </a>{' '}
              (Clockify time entry): Connect offers Clockify natively. + does
              not offer Timesheet: views match their row class exactly.
            </li>
            <li>
              <a href={constructOpenURL(seeded.groceries)}>Groceries</a>{' '}
              (Grocery item): offers neither, and shows no Connect button.
            </li>
            <li>
              Pieces: <a href={constructOpenURL(seeded.timesheet)}>Timesheet</a>
              , <a href={constructOpenURL(seeded.clockify)}>Clockify</a>,{' '}
              <a href={constructOpenURL(seeded.toggl)}>Toggl Track</a>
            </li>
          </ul>
        </>
      )}
    </ContainerFull>
  );
}

export const piecesDemoRouteLazy = createLazyRoute('/app/pieces-demo')({
  component: PiecesDemo,
});
