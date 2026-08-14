#!/usr/bin/env node
/**
 * Records a short FEATURE COLLAGE for the website: one clip per feature
 * (document, kanban board, canvas, table, chat), cut out of a single
 * continuous run of the scripted demo (`/app/demo`) and concatenated.
 *
 * Why one recording + cuts rather than one recording per feature: the demo
 * drive lives in OPFS, so a fresh browser context means rebuilding the whole
 * workspace. Instead we let the demo's own follow-mode tour act as the camera
 * (Mara walks the user from board → moodboard → team table, working live in
 * each), poll `main[about]` to learn WHICH resource is on screen WHEN, and
 * cut the good stretch out of each.
 *
 * The clips are deliberately stripped down (see `--help` notes):
 *  - sidebar collapsed, so each resource renders full-page;
 *  - meeting chat panel closed (we still join + say hi, because the director
 *    gates its tour on that — see record-demo.mjs — we just don't film it).
 *
 * Anything that would look like UI-fiddling on camera (collapsing the
 * sidebar, joining, typing in chat, navigating via the sidebar) is wrapped in
 * an "exclusion window" and never appears in a clip.
 *
 * Usage:
 *   node scripts/record-features.mjs [--headed] [--out <dir>]
 *
 * Requires the data-browser dev server at FRONTEND_URL (default :6747).
 * No atomic-server backend needed — the demo drive is local-only.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:6747';
const headed = process.argv.includes('--headed');
const outArgIndex = process.argv.indexOf('--out');
const outDir =
  outArgIndex !== -1
    ? path.resolve(process.argv[outArgIndex + 1])
    : path.resolve(__dirname, '../recordings');

mkdirSync(outDir, { recursive: true });

// Matches record-demo.mjs: >=1728 crosses the app's own responsiveWidth
// breakpoint (useResizable.ts), which is also why panels aren't cramped.
const VIEWPORT = { width: 1728, height: 1080 };

/**
 * The collage, in narrative order (NOT the order the tour visits them).
 * `path` indexes into the demo manifest (chunks/Demo/demoWorkspace.ts).
 */
const FEATURES = [
  { label: 'Documents', path: 'welcomeDoc', seconds: 7 },
  { label: 'Kanban board', path: 'checklist.table', seconds: 8 },
  { label: 'Canvas', path: 'moodboard', seconds: 8 },
  { label: 'Tables', path: 'team.table', seconds: 7 },
  { label: 'Chat', path: 'teamChat', seconds: 6 },
];

/** Skip this much of a segment's head — navigation/render settling. */
const SETTLE_SECONDS = 1.2;

function pick(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => acc?.[key], obj);
}

async function main() {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: outDir, size: VIEWPORT },
    locale: 'en-GB',
    timezoneId: 'Europe/Amsterdam',
  });
  const page = await context.newPage();
  // Frame zero of the .webm — every timestamp below is relative to this.
  const t0 = Date.now();
  const now = () => (Date.now() - t0) / 1000;

  /** [{subject, start, end}] — which resource filled the screen, when. */
  const segments = [];
  /** [{start, end}] — ranges containing us driving the UI; never filmed. */
  const exclusions = [];
  let polling = true;

  /** Wrap on-camera UI fiddling so it can't land in a clip. */
  async function offCamera(fn) {
    const start = now();

    try {
      return await fn();
    } finally {
      // Pad the tail: React transitions/animations outlive the last click.
      exclusions.push({ start: start - 0.3, end: now() + 0.7 });
    }
  }

  const poll = (async () => {
    while (polling) {
      try {
        const subject = await page.evaluate(
          () =>
            document.querySelector('main[about]')?.getAttribute('about') ??
            null,
        );
        const at = now();
        const last = segments[segments.length - 1];

        if (subject && last?.subject === subject) {
          last.end = at;
        } else if (subject) {
          segments.push({ subject, start: at, end: at });
        }
      } catch {
        // Navigation tore down the execution context mid-evaluate; ignore.
      }

      await new Promise(r => setTimeout(r, 200));
    }
  })();

  console.log(`Loading ${FRONTEND_URL}/app/demo …`);
  await page.goto(`${FRONTEND_URL}/app/demo`);
  await page.waitForURL(/\/app\/show/, { timeout: 30_000 });

  const manifest = await page.evaluate(() => {
    const raw = localStorage.getItem('atomic.demoWorkspace');

    return raw ? JSON.parse(raw) : undefined;
  });

  if (!manifest) throw new Error('No demo manifest in localStorage.');

  // Collapse the sidebar so every resource renders full-page. The sidebar
  // ALSO reveals on hover near the left edge (SideBar/index.tsx:
  // `sideBarLocked || hoveringOverSideBar`), so park the pointer centre-screen
  // afterwards or it slides back out over the footage.
  await offCamera(async () => {
    await page.click('[data-test="sidebar-toggle"]');
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
    await page.waitForTimeout(600);
  });

  // ── Clip 1 is free: Mara is already typing into the welcome doc ──
  console.log('Filming the welcome doc while Mara types …');
  await page.waitForTimeout(9_000);

  // ── Chat: the tour never visits it, so go there ourselves (off camera) ──
  console.log('Filming the team chat …');
  await offCamera(async () => {
    await page.click('[data-test="sidebar-toggle"]');
    await page.getByTestId('sidebar').getByText('Team chat').first().click();
    await page.waitForTimeout(500);
    await page.click('[data-test="sidebar-toggle"]');
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
    await page.waitForTimeout(600);
  });
  await page.waitForTimeout(7_000);

  // ── Join the meeting: the director gates its whole tour on this ──
  // We film the RESULT (Mara touring us through each feature), never the
  // meeting chat itself — the panel goes straight back shut.
  const joinBanner = page.getByTitle(/led by/);
  console.log('Waiting for the tour meeting …');
  await joinBanner.waitFor({ state: 'visible', timeout: 60_000 });

  await offCamera(async () => {
    await joinBanner.click();

    // Say hi immediately: `waitForUserChat` otherwise idles up to 4 minutes
    // before the tour winds down (see record-demo.mjs).
    const chatInput = page.getByLabel('Chat input');
    await chatInput.waitFor({ state: 'visible', timeout: 15_000 });
    await chatInput.fill('Hi team! 👋');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.waitForTimeout(800);

    // Clicking the banner again toggles the panel shut WITHOUT unfollowing
    // (MeetingBanner.handleClick) — so the tour still drives our camera.
    await joinBanner.click();
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
    await page.waitForTimeout(600);
  });

  // ── Ride the tour: board → moodboard → team table ──
  console.log('Following the tour …');
  const teamTable = pick(manifest, 'team.table');
  const deadline = Date.now() + 3 * 60_000;

  while (Date.now() < deadline) {
    const onTeamTable = segments.some(
      s =>
        s.subject === teamTable &&
        s.end - s.start > FEATURES[3].seconds + SETTLE_SECONDS,
    );

    if (onTeamTable) break;
    await page.waitForTimeout(1_000);
  }

  console.log('Captured the tour — stopping.');
  polling = false;
  await poll;

  const rawVideoPath = await page.video()?.path();
  await context.close();
  await browser.close();

  if (!rawVideoPath) throw new Error('No video was recorded.');

  const webmPath = path.join(outDir, 'features-raw.webm');
  renameSync(rawVideoPath, webmPath);

  // ── Cut ──────────────────────────────────────────────────────────
  const clipPaths = [];

  for (const [index, feature] of FEATURES.entries()) {
    const subject = pick(manifest, feature.path);

    if (!subject) {
      console.log(`! ${feature.label}: not in the manifest — skipped.`);
      continue;
    }

    const window = bestWindow(segments, exclusions, subject, feature.seconds);

    if (!window) {
      console.log(`! ${feature.label}: no clean stretch on camera — skipped.`);
      continue;
    }

    const clipPath = path.join(
      outDir,
      `clip-${index}-${slug(feature.label)}.mp4`,
    );
    const args = [
      '-y',
      '-ss',
      window.start.toFixed(2),
      '-t',
      window.duration.toFixed(2),
      '-i',
      webmPath,
      '-c:v',
      'libx264',
      '-crf',
      '21',
      '-preset',
      'slow',
      '-pix_fmt',
      'yuv420p',
      // Uniform timebase + keyframe at the head, so the concat below can
      // stream-copy the clips instead of re-encoding them a second time.
      '-video_track_timescale',
      '90000',
      '-an',
      clipPath,
    ];
    const result = spawnSync('ffmpeg', args, { stdio: 'ignore' });

    if (result.error || result.status !== 0) {
      console.log(`! ${feature.label}: ffmpeg failed — skipped.`);
      continue;
    }

    clipPaths.push(clipPath);
    console.log(
      `✓ ${feature.label}: ${window.duration.toFixed(1)}s @ ${window.start.toFixed(1)}s`,
    );
  }

  if (clipPaths.length === 0) throw new Error('No clips were produced.');

  const listPath = path.join(outDir, 'concat.txt');
  writeFileSync(listPath, clipPaths.map(p => `file '${p}'`).join('\n'));

  const collagePath = path.join(outDir, 'features.mp4');
  const concat = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      collagePath,
    ],
    { stdio: 'ignore' },
  );

  if (concat.error || concat.status !== 0) {
    console.log(
      'Could not concatenate; the individual clips are still in',
      outDir,
    );

    return;
  }

  rmSync(listPath, { force: true });
  for (const clip of clipPaths) rmSync(clip, { force: true });
  rmSync(webmPath, { force: true });

  console.log(`\nFeature collage: ${collagePath}`);
}

/**
 * The longest stretch where `subject` was on screen and we weren't touching
 * the UI, trimmed to `seconds`. Returns undefined if nothing usable is left.
 */
function bestWindow(segments, exclusions, subject, seconds) {
  const candidates = [];

  for (const segment of segments.filter(s => s.subject === subject)) {
    // Subtract every exclusion from this segment, leaving clean sub-ranges.
    let ranges = [{ start: segment.start + SETTLE_SECONDS, end: segment.end }];

    for (const excluded of exclusions) {
      const next = [];

      for (const range of ranges) {
        if (excluded.end <= range.start || excluded.start >= range.end) {
          next.push(range);
          continue;
        }

        if (excluded.start > range.start)
          next.push({ start: range.start, end: excluded.start });
        if (excluded.end < range.end)
          next.push({ start: excluded.end, end: range.end });
      }

      ranges = next;
    }

    candidates.push(...ranges);
  }

  const best = candidates.sort(
    (a, b) => b.end - b.start - (a.end - a.start),
  )[0];

  if (!best) return undefined;

  const available = best.end - best.start;

  // A sliver isn't worth a cut; anything shorter reads as a glitch.
  if (available < 2) return undefined;

  return { start: best.start, duration: Math.min(seconds, available) };
}

function slug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
