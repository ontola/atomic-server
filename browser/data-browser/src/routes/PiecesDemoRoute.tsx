// @wc-ignore-file
import { createLazyRoute } from '@tanstack/react-router';
import { useState, type JSX } from 'react';
import { useStore } from '@tomic/react';
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
  const drive = store.getDrive();

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
        One <strong>table view</strong> (Timesheet, bound to Time entry), one{' '}
        <strong>integration</strong> (Clockify, native class Clockify time
        entry, whose tab shows sync state) and one <strong>lens</strong> (Time
        entry ↔ Clockify time entry). The Clockify platform is a fixture:
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
          <h2>Open a table and press + in its view tabs</h2>
          <ul>
            <li>
              <a href={constructOpenURL(seeded.hours)}>Hours</a> (Time entry):
              offers Timesheet natively and Clockify through the lens. Clockify
              is already installed with an outbox to look at.
            </li>
            <li>
              <a href={constructOpenURL(seeded.clockifyMirror)}>
                Clockify mirror
              </a>{' '}
              (Clockify time entry): offers Clockify natively, not Timesheet
              (views do not follow lenses yet).
            </li>
            <li>
              <a href={constructOpenURL(seeded.groceries)}>Groceries</a>{' '}
              (Grocery item): offers neither.
            </li>
            <li>
              Pieces: <a href={constructOpenURL(seeded.timesheet)}>Timesheet</a>
              , <a href={constructOpenURL(seeded.clockify)}>Clockify</a>,{' '}
              <a href={constructOpenURL(seeded.lens)}>the lens</a>
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
