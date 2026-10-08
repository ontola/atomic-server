// @wc-ignore-file
import { createLazyRoute } from '@tanstack/react-router';
import { useEffect, useState, type JSX } from 'react';
import { findSchema, type Store } from '@tomic/lib';
import { useStore } from '@tomic/react';
import { piecesSchema } from '@chunks/Pieces/piecesSchema';
import { ContainerFull } from '../components/Containers';
import { Button } from '../components/Button';
import { constructOpenURL } from '../helpers/navigation';
import {
  seedPiecesDemo,
  type SeededDemo,
} from '@chunks/Pieces/demo/seedPiecesDemo';
import {
  PIECES_FLAG_KEY,
  piecesEnabled,
  setPiecesEnabled,
} from '@chunks/Pieces/piecesFlag';
import { useDevDrive } from '../hooks/useDevDrive';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';

/**
 * Reviewing a drive-local lens (Q-089). In a real flow this would sit on the
 * lens's own page, showing the mapping; here one button is enough.
 */
async function approveLens(store: Store, drive: string, subject: string) {
  const schema = await findSchema(store, drive, piecesSchema());
  const review = schema.properties?.['lens-review'];
  if (!review) return;

  const lens = await store.getResource(subject);
  await lens.set(review, 'approved');
  await lens.save();
}

/** What the tester entry seeded into a drive, so a second visit does not seed again. */
const seededKey = (drive: string) => `${PIECES_FLAG_KEY}.seeded:${drive}`;

function readSeeded(drive: string | undefined): SeededDemo | undefined {
  if (!drive) return undefined;

  try {
    const raw = localStorage.getItem(seededKey(drive));

    return raw ? (JSON.parse(raw) as SeededDemo) : undefined;
  } catch {
    return undefined;
  }
}

function writeSeeded(drive: string, seeded: SeededDemo): void {
  try {
    localStorage.setItem(seededKey(drive), JSON.stringify(seeded));
  } catch {
    // Storage blocked: a later visit seeds again, which is only untidy.
  }
}

// StrictMode runs the effect twice in dev, and the effect re-runs when the new
// dev drive changes its dependencies: one setup per page load. After a
// failure, a reload tries again.
let testerStarted = false;

/**
 * The entry for user tests, `/app/pieces-demo?tester`: no explanation of
 * views, integrations or lenses, since the test asks whether those make
 * sense on their own. The first visit signs in with a fresh dev drive if
 * needed, seeds the demo, turns the flag on and opens the Hours table. Later
 * visits show only a link back to Hours and the "Approve lens" action.
 */
function TesterEntry(): JSX.Element {
  const store = useStore();
  const { createDevDrive } = useDevDrive();
  const navigate = useNavigateWithTransition();
  const [seeded] = useState(() => readSeeded(store.getDrive()));
  const [error, setError] = useState<string>();
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    if (seeded || testerStarted) return;
    testerStarted = true;

    const signedIn = !!store.getAgent() && store.getDrive();
    (async () => {
      const drive = signedIn
        ? store.getDrive()!
        : await createDevDrive({ stay: true });
      const demo = await seedPiecesDemo(store, drive);
      writeSeeded(drive, demo);
      setPiecesEnabled(true);
      navigate(constructOpenURL(demo.hours));
    })().catch((e: Error) => setError(e.message));
  }, [seeded, store, createDevDrive, navigate]);

  if (error) {
    return (
      <ContainerFull>
        <p role='alert'>Setup failed: {error}</p>
      </ContainerFull>
    );
  }

  if (!seeded) {
    return (
      <ContainerFull>
        <p>Setting up…</p>
      </ContainerFull>
    );
  }

  return (
    <ContainerFull>
      <p>
        <a href={constructOpenURL(seeded.hours)}>Hours</a>
      </p>
      <Button
        disabled={approved}
        onClick={async () => {
          const drive = store.getDrive();
          if (!drive) return;
          await approveLens(store, drive, seeded.togglLens);
          setApproved(true);
        }}
      >
        {approved ? 'Approved' : 'Approve lens'}
      </Button>
    </ContainerFull>
  );
}

/**
 * Dev-only page for the split-pieces exploration: seeds one table view, one
 * integration and one lens into the current drive, switches the flag on, and
 * links to tables that show what is and is not offered.
 */
function PiecesDemo(): JSX.Element {
  if (new URLSearchParams(window.location.search).has('tester')) {
    return <TesterEntry />;
  }

  return <ExplainedDemo />;
}

/** The explained page, for developers and reviewers. */
function ExplainedDemo(): JSX.Element {
  const store = useStore();
  const [enabled, setEnabled] = useState(piecesEnabled());
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState<SeededDemo>();
  const [error, setError] = useState<string>();
  const [togglApproved, setTogglApproved] = useState(false);
  const drive = store.getDrive();

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
