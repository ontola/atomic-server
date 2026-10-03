#!/usr/bin/env node
/**
 * Records the short looping product video used in the README (issue #902):
 * six ~2.5s shots of the scripted demo, cropped tight and cut together,
 * 4:3 so it sits well next to a block of text.
 *
 * It runs in two passes.
 *
 * `capture` films two takes with Playwright and writes a marks file per
 * take saying when each beat happened:
 *  - `tour` rides the /app/demo tour (see chunks/Demo/DemoDirector.ts),
 *    which drives the personas: Mara typing, a kanban card moving, Yusuf
 *    drawing. The meeting panel is left open for a while so the chat can
 *    be filmed taking messages.
 *  - `solo` never joins the meeting, so the tour never starts and the
 *    camera stays put. It zooms the page in on the Team table and walks a
 *    teammate's cell selection left to right, then films the search
 *    dialog typed a letter at a time.
 *
 * `cut` resolves each shot in SHOTS against those marks and hands the
 * crops, speed-ups and camera moves to ffmpeg. Shots anchor to *marks*
 * rather than absolute timestamps because the tour's beats land seconds
 * apart from one run to the next.
 *
 * Usage:
 *   node scripts/record-loop.mjs [--capture] [--cut] [--out <dir>]
 *
 * With neither flag it does both. `--cut` alone re-cuts the footage
 * already in <dir>, which is the fast way to iterate on framing.
 *
 * Requires the data-browser dev server at FRONTEND_URL (default
 * http://localhost:6747) and ffmpeg on PATH. No backend needed — the demo
 * drive is local-only.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:6747';

/** The tour take. 1728 wide gives the meeting panel its roomy 480px
 *  layout (see record-demo.mjs for why that breakpoint matters). */
const TOUR_VIEWPORT = { width: 1728, height: 1080 };
/** The solo take is shorter so the Team table doesn't sit in a sea of
 *  empty page — there is nothing below the last row to film. */
const SOLO_VIEWPORT = { width: 1728, height: 900 };
/** Page zoom for the solo take: makes the table's rows big enough to read
 *  at 960px wide. Much more and the columns stop fitting. */
const SOLO_ZOOM = '1.15';
/** How long a teammate lingers on each cell of the Team table. */
const HOP_MS = 950;
/**
 * How long to let the client DB settle before filming anything in the
 * solo take. Building the demo workspace posts hundreds of writes to the
 * client-db worker, and *every* read queues behind them (see the
 * `workQueue` comment in lib/src/client-db.worker.ts). Film too early and
 * the table renders its headers with no rows, and search takes seconds to
 * answer — neither of which is what these features do at rest.
 */
const SETTLE_MS = 35_000;

const OUTPUT = { width: 960, height: 720 };

/**
 * The shot list. `anchor` names a mark from that take's marks file and
 * `offset` moves relative to it, so a shot keeps pointing at the right
 * moment even though the tour's timings drift between runs.
 *
 * `crop` is w:h:x:y in the take's own pixels and must be 4:3 unless the
 * shot has a `move` that ends 4:3. `speed` is the playback multiplier.
 *
 * `move` is the camera:
 *  - `{ type: 'pan', to: { x, y } }` slides a fixed-size window, for
 *    following something that travels across the page.
 *  - `{ type: 'zoom', from, to, at }` changes the framing, for pushing in
 *    on an action or pulling back to reveal its surroundings. `at` is the
 *    point (in crop pixels) the tighter end is centred on.
 * Both ease in and out; a linear move reads like a scroll bar.
 *
 * `mask` paints a white box over w:h:x:y in crop pixels. The tour mirrors
 * Mara's narration into a toast in the bottom-right corner, which is part
 * of the guided demo rather than the product, and on the canvas it sits
 * right where the pen tools are.
 */
const SHOTS = [
  {
    name: 'document',
    take: 'tour',
    anchor: 'beat:welcome',
    offset: 3.4,
    duration: 4,
    speed: 1.6,
    crop: { w: 1160, h: 870, x: 0, y: 88 },
    // Open on the words being typed, pull back to the whole workspace.
    move: { type: 'zoom', from: 1.25, to: 1, at: { x: 850, y: 300 } },
  },
  {
    name: 'table',
    take: 'solo',
    anchor: 'sweep-0',
    offset: -0.2,
    duration: 4,
    speed: 1.6,
    crop: { w: 1120, h: 840, x: 345, y: 60 },
    // Ride along with the cell selection sweeping left to right, which
    // also brings the columns that started off-screen into frame.
    move: { type: 'pan', to: { x: 608, y: 60 } },
  },
  {
    name: 'kanban',
    take: 'tour',
    // ROW_EXPLORE_BOARD, moved to Doing and then to Done; the first of
    // the two is the one framed here.
    anchor: 'card-drag:1',
    offset: -1,
    duration: 4,
    speed: 1.6,
    crop: { w: 960, h: 720, x: 316, y: 88 },
    // Push in on the column the card is being dropped into.
    move: { type: 'zoom', from: 1, to: 1.22, at: { x: 560, y: 330 } },
  },
  {
    name: 'meeting',
    take: 'tour',
    anchor: 'meeting-open',
    offset: 22.6,
    duration: 4,
    speed: 1.6,
    crop: { w: 800, h: 600, x: 928, y: 70 },
    // Drift down as the thread grows.
    move: { type: 'pan', to: { x: 928, y: 190 } },
  },
  {
    name: 'drawing',
    take: 'tour',
    anchor: 'beat:moodboard',
    offset: 0.7,
    duration: 4,
    speed: 1.6,
    crop: { w: 1200, h: 900, x: 528, y: 180 },
    mask: { w: 488, h: 100, x: 712, y: 800 },
    // Start on the ink, pull back to the canvas and its pen tools.
    move: { type: 'zoom', from: 1.18, to: 1, at: { x: 600, y: 400 } },
  },
  {
    name: 'search',
    take: 'solo',
    anchor: 'search-typing',
    offset: -0.3,
    // Slower than the rest: the point of the shot is watching the query
    // narrow as each letter lands.
    duration: 5,
    speed: 1.7,
    crop: { w: 920, h: 690, x: 560, y: 95 },
    // Start on the input, pull back as results and the preview fill in.
    move: { type: 'zoom', from: 1.25, to: 1, at: { x: 300, y: 170 } },
  },
];

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir =
  outIndex !== -1
    ? path.resolve(args[outIndex + 1])
    : path.resolve(__dirname, '../recordings/loop');
const doCapture = args.includes('--capture') || !args.includes('--cut');
const doCut = args.includes('--cut') || !args.includes('--capture');

mkdirSync(outDir, { recursive: true });

const takePath = (take, ext) => path.join(outDir, `${take}.${ext}`);

/** A recorder that stamps named moments against the video's own clock. */
function newClapper() {
  const marks = [];
  const startedAt = Date.now();

  return {
    marks,
    at: () => (Date.now() - startedAt) / 1000,
    mark(label) {
      const t = (Date.now() - startedAt) / 1000;
      marks.push({ label, t });
      console.log(`  ${label} @ ${t.toFixed(1)}s`);
    },
  };
}

async function openTake(browser, viewport) {
  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: outDir, size: viewport },
    locale: 'en-GB',
    timezoneId: 'Europe/Amsterdam',
  });

  return { context, page: await context.newPage() };
}

async function finishTake(context, page, take, marks) {
  const rawPath = await page.video()?.path();
  await context.close();

  if (!rawPath) throw new Error(`No video was recorded for the ${take} take.`);

  renameSync(rawPath, takePath(take, 'webm'));
  writeFileSync(takePath(take, 'json'), JSON.stringify(marks, null, 1));
  console.log(`  ${take} take: ${takePath(take, 'webm')}`);
}

/** The demo workspace's subjects, as DemoRoute left them in localStorage. */
const readManifest = page =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem('atomic.demoWorkspace') ?? '{}'),
  );

async function captureTour(browser) {
  console.log('Tour take …');
  const { context, page } = await openTake(browser, TOUR_VIEWPORT);
  const clapper = newClapper();

  await page.goto(`${FRONTEND_URL}/app/demo`);
  await page.waitForURL(/\/app\/show/, { timeout: 180_000 });
  clapper.mark('setup-done');

  const manifest = await readManifest(page);

  // Watch what the camera is pointed at, and what the personas are doing,
  // so the cut pass can anchor to beats instead of guessed timestamps.
  const beats = {
    [manifest.welcomeDoc]: 'welcome',
    [manifest.checklist?.table]: 'kanban',
    [manifest.moodboard]: 'moodboard',
    [manifest.team?.table]: 'team',
  };
  let lastBeat;
  const marked = new Set();
  let watching = true;
  const watcher = (async () => {
    while (watching) {
      try {
        const seen = await page.evaluate(
          drive => ({
            subject:
              document.querySelector('main[about]')?.getAttribute('about') ??
              null,
            // The director announces `dragging` while a card is in the air.
            dragging: (window.store?.getPresence(drive)?.getSnapshot() ?? [])
              .filter(item => item.data?.dragging === true)
              .map(item => item.data.row),
          }),
          manifest.drive,
        );

        const beat = beats[seen.subject];

        if (beat && beat !== lastBeat) {
          lastBeat = beat;
          clapper.mark(`beat:${beat}`);
        }

        // Label a drag by which checklist card it is (the indices are
        // demoWorkspace.ts's ROW_* constants), because the tour moves
        // several, and the "say hi" one fires early and out of order —
        // it's reactive to us chatting at the top of the take.
        for (const row of seen.dragging) {
          const index = (manifest.checklist?.rows ?? []).indexOf(row);
          const label = `card-drag:${index}`;

          if (index !== -1 && !marked.has(label)) {
            marked.add(label);
            clapper.mark(label);
          }
        }
      } catch {
        // A navigation tore down the execution context mid-evaluate.
      }

      await page.waitForTimeout(200);
    }
  })();

  // Mara opens the tour meeting once she's done typing the welcome doc.
  const joinBanner = page.getByTitle(/led by/);
  await joinBanner.waitFor({ state: 'visible', timeout: 120_000 });
  await joinBanner.click();

  // Chat straight away: the "say hi" beat is reactive, so this keeps the
  // director from idling for four minutes waiting on us.
  const chatInput = page.getByLabel('Chat input');
  await chatInput.waitFor({ state: 'visible', timeout: 30_000 });
  await chatInput.fill('Hi team! 👋');
  await page.getByRole('button', { name: 'Send' }).click();
  clapper.mark('meeting-open');

  // Leave the panel open long enough to film messages arriving in it.
  await page.mouse.move(TOUR_VIEWPORT.width / 2, TOUR_VIEWPORT.height / 2);
  await page.waitForTimeout(34_000);

  try {
    await page
      .getByRole('button', { name: /meeting/i })
      .first()
      .click();
  } catch {
    console.log('  could not close the meeting panel');
  }

  // Ride out the rest of the tour; the director's closing line is the
  // signal that every beat has been filmed.
  try {
    await page
      .getByText('Poke around!', { exact: false })
      .waitFor({ state: 'visible', timeout: 4 * 60_000 });
  } catch {
    console.log('  closing line not seen; wrapping up anyway');
  }

  clapper.mark('tour-end');
  await page.waitForTimeout(1_000);
  watching = false;
  await watcher;

  await finishTake(context, page, 'tour', clapper.marks);
}

async function captureSolo(browser) {
  console.log('Solo take …');
  const { context, page } = await openTake(browser, SOLO_VIEWPORT);
  const clapper = newClapper();

  await page.goto(`${FRONTEND_URL}/app/demo`);
  await page.waitForURL(/\/app\/show/, { timeout: 180_000 });
  clapper.mark('setup-done');

  const manifest = await readManifest(page);

  await page
    .locator(`a[href="${manifest.team.table}"]`)
    .first()
    .click({ timeout: 30_000 });
  await page
    .getByRole('heading', { name: 'Team' })
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1_500);
  await page.evaluate(zoom => {
    document.documentElement.style.zoom = zoom;
  }, SOLO_ZOOM);
  // Park the pointer in the top bar so no row shows a hover state.
  await page.mouse.move(SOLO_VIEWPORT.width / 2, 40);
  await page.waitForTimeout(SETTLE_MS);

  const columns = [
    manifest.team.roleColumn,
    manifest.team.responsibilitiesColumn,
    manifest.team.doingTaskColumn,
    manifest.team.onboardingColumn,
  ];
  const rows = [manifest.personas.mara, manifest.personas.yusuf];

  // Sweep each row left to right, pausing on every cell, so the camera
  // can pan along with the selection. This is the same presence channel
  // the director uses; we drive it directly because the director only
  // visits the Team table during its own tour stop.
  for (const [rowIndex, row] of rows.entries()) {
    for (const [columnIndex, column] of columns.entries()) {
      await page.evaluate(
        ([drive, table, agent, rowSubject, columnSubject]) =>
          window.store.getPresence(drive).injectEntry('film-session', {
            resource: table,
            agent,
            data: { row: rowSubject, column: columnSubject },
          }),
        [
          manifest.drive,
          manifest.team.table,
          manifest.personas.pip,
          row,
          column,
        ],
      );

      if (columnIndex === 0) clapper.mark(`sweep-${rowIndex}`);

      await page.waitForTimeout(HOP_MS);
    }
  }

  await page.evaluate(() => {
    document.documentElement.style.zoom = '1';
  });
  await page.waitForTimeout(1_000);

  clapper.mark('search-open');
  await page.locator('nav button[title^="Search ("]').first().click();
  await page.waitForTimeout(900);
  clapper.mark('search-typing');

  for (const letter of 'team') {
    await page.keyboard.type(letter);
    await page.waitForTimeout(450);
  }

  await page
    .locator('[data-index]')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });
  clapper.mark('search-results');
  await page.waitForTimeout(900);
  // Arrow through a couple of results so the preview pane fills in.
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(800);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(1_400);
  clapper.mark('search-end');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  await finishTake(context, page, 'solo', clapper.marks);
}

async function capture() {
  const browser = await chromium.launch({
    headless: !args.includes('--headed'),
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });

  try {
    await captureTour(browser);
    await captureSolo(browser);
  } finally {
    await browser.close();
  }
}

/** Smoothstep over an ffmpeg expression that runs 0 → 1. */
const ease = u => `(${u})*(${u})*(3-2*(${u}))`;

/**
 * Where the tighter end of a zoom sits. ffmpeg's zoompan takes the
 * top-left of the visible window, so centring on a point means backing
 * off by half the window, and clamping when that falls outside the frame.
 */
function zoomOrigin(at, size, zoom) {
  const visible = size / zoom;

  return Math.max(0, Math.min(size - visible, at - visible / 2));
}

function filterFor(shot) {
  const { crop, move, speed, duration } = shot;
  const frames = Math.round((duration / speed) * 30);
  const stages = [
    `trim=start=${shot.start}:duration=${duration}`,
    'setpts=(PTS-STARTPTS)/' + speed,
  ];

  if (!move || move.type === 'pan') {
    // A pan can ride on crop's own x/y expressions, which is exact and
    // needs no resampling.
    const u = ease(`clip(t/${(duration / speed).toFixed(4)},0,1)`);
    const x = move ? `'${crop.x}+${move.to.x - crop.x}*${u}'` : crop.x;
    const y = move ? `'${crop.y}+${move.to.y - crop.y}*${u}'` : crop.y;
    stages.push(`crop=${crop.w}:${crop.h}:${x}:${y}`);

    if (shot.mask) stages.push(maskStage(shot.mask));

    stages.push(
      `scale=${OUTPUT.width}:${OUTPUT.height}:flags=lanczos`,
      'fps=30',
    );

    return stages.join(',');
  }

  // A zoom resamples every frame, so supersample first: zoompan rounds
  // its window to whole pixels and the step shows as a stutter at 1:1.
  const u = ease(`(on/${frames - 1})`);
  const [tight, wide] =
    move.from > move.to ? [move.from, move.to] : [move.to, move.from];
  const pullingBack = move.from > move.to;
  const w = crop.w * 2;
  const h = crop.h * 2;
  const originX = zoomOrigin(move.at.x * 2, w, tight);
  const originY = zoomOrigin(move.at.y * 2, h, tight);
  // At the wide end the window is the whole frame, so its origin is 0;
  // interpolate between that and the tight end's origin.
  const towardTight = pullingBack ? `(1-${u})` : u;

  stages.push('fps=30', `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);

  if (shot.mask) stages.push(maskStage(shot.mask));

  stages.push(
    `scale=${w}:${h}:flags=lanczos`,
    [
      `zoompan=z='${wide}+${(tight - wide).toFixed(4)}*${towardTight}'`,
      `x='${originX.toFixed(2)}*${towardTight}'`,
      `y='${originY.toFixed(2)}*${towardTight}'`,
      'd=1',
      `s=${OUTPUT.width}x${OUTPUT.height}`,
      'fps=30',
    ].join(':'),
  );

  return stages.join(',');
}

const maskStage = mask =>
  `drawbox=x=${mask.x}:y=${mask.y}:w=${mask.w}:h=${mask.h}:color=white@1:t=fill`;

function ffmpeg(args_) {
  const result = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args_], {
    stdio: 'inherit',
  });

  if (result.error || result.status !== 0) {
    throw new Error(`ffmpeg failed: ffmpeg ${args_.join(' ')}`);
  }
}

function cut() {
  const marksByTake = new Map();

  const resolve = shot => {
    if (!marksByTake.has(shot.take)) {
      marksByTake.set(
        shot.take,
        JSON.parse(readFileSync(takePath(shot.take, 'json'), 'utf8')),
      );
    }

    const mark = marksByTake
      .get(shot.take)
      .find(entry => entry.label === shot.anchor);

    if (!mark) {
      throw new Error(
        `The ${shot.take} take has no "${shot.anchor}" mark, so the ` +
          `"${shot.name}" shot can't be placed. Re-run --capture.`,
      );
    }

    return Math.max(0, mark.t + shot.offset);
  };

  const parts = [];

  for (const shot of SHOTS) {
    const start = resolve(shot);
    const shotPath = path.join(outDir, `shot-${shot.name}.mp4`);
    console.log(
      `  ${shot.name}: ${shot.take} @ ${start.toFixed(1)}s (${shot.anchor}` +
        `${shot.offset >= 0 ? '+' : ''}${shot.offset})`,
    );
    ffmpeg([
      '-i',
      takePath(shot.take, 'webm'),
      '-vf',
      filterFor({ ...shot, start }),
      '-an',
      '-c:v',
      'libx264',
      '-crf',
      '20',
      '-preset',
      'slow',
      '-pix_fmt',
      'yuv420p',
      shotPath,
    ]);
    parts.push(shotPath);
  }

  const listPath = path.join(outDir, 'shots.txt');
  writeFileSync(listPath, parts.map(part => `file '${part}'`).join('\n'));

  const loopPath = path.join(outDir, 'atomic-loop.mp4');
  ffmpeg([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-preset',
    'slow',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    loopPath,
  ]);
  console.log(`\nLoop: ${loopPath}`);
}

if (doCapture) await capture();

if (doCut) {
  console.log('Cutting …');
  cut();
}
