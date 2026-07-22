#!/usr/bin/env node
/**
 * Records the "Your first day" scripted demo (/app/demo, see
 * planning/demo-experience.md and chunks/Demo/DemoDirector.ts) as a video
 * for use on the marketing website.
 *
 * The demo is entirely client-side (local-only drive, no server needed) but
 * it gates two beats on user interaction:
 *  - `waitForJoin` (25s): the top-bar "Join … — led by Mara" banner has to
 *    be clicked, or the tour never starts.
 *  - `waitForUserChat` (4 minutes!): the "say hi" checklist item only ticks
 *    once we post a message in the meeting chat. Skip it by chatting early —
 *    the director's listener is reactive, so it doesn't matter that we chat
 *    before the script gets around to waiting for it.
 *
 * Usage:
 *   node scripts/record-demo.mjs [--headed] [--out <dir>]
 *
 * Requires the data-browser dev server running at FRONTEND_URL
 * (default http://localhost:6747). The atomic-server backend is NOT
 * required — the demo drive never touches the network.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, renameSync } from 'node:fs';
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

// 1728 isn't just "a bit bigger" for its own sake: useResizable.ts's
// responsiveWidth() gives the right-side panel (meeting chat, comments, AI)
// 480px instead of a cramped 380px once window.innerWidth >= 1728 — that
// exact breakpoint is picked to match a 16" MacBook's logical width. Below
// it, "Onboarding meeting" wraps into an unreadable stack in the panel
// header. 1728x1080 keeps the 8:5 aspect ratio.
const VIEWPORT = { width: 1728, height: 1080 };

async function main() {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: outDir, size: VIEWPORT },
    locale: 'en-GB',
    timezoneId: 'Europe/Amsterdam',
  });
  const page = await context.newPage();
  // Video recording starts the instant this page exists, so this is frame
  // zero of the .webm — the reference point for how much "Setting up your
  // demo…" spinner to trim off the front later.
  const recordingStartedAt = Date.now();

  console.log(`Loading ${FRONTEND_URL}/app/demo …`);
  await page.goto(`${FRONTEND_URL}/app/demo`);

  // DemoRoute shows a spinner while it mints the guest agent + builds the
  // workspace, then navigates to /app/show?subject=<welcomeDoc>. That
  // navigation is the reliable "setup is done" signal (same pattern as the
  // e2e suite's `waitForURL(/\/app\/show/)`).
  console.log('Waiting for the demo workspace to finish setting up …');
  await page.waitForURL(/\/app\/show/, { timeout: 30_000 });
  const setupDoneAt = Date.now();
  const skipSeconds = (setupDoneAt - recordingStartedAt) / 1000;
  console.log(
    `Setup took ${skipSeconds.toFixed(1)}s — will trim that off the front.`,
  );

  // Mara starts the tour meeting only after she's finished typing the
  // welcome doc — give it a wide window.
  const joinBanner = page.getByTitle(/led by/);
  console.log('Waiting for the tour meeting to start …');
  await joinBanner.waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(1_200);
  console.log('Joining the meeting …');
  await joinBanner.click();

  // Say hi in the meeting chat right away so the "say hi" checklist beat
  // completes reactively, instead of the director idling for 4 minutes.
  const chatInput = page.getByLabel('Chat input');
  await chatInput.waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(800);
  console.log('Saying hi in the meeting chat …');
  await chatInput.fill('Hi team! 👋');
  await page.getByRole('button', { name: 'Send' }).click();

  // Ride out the rest of the scripted tour + wind-down. The director's
  // final beat re-types the welcome doc's closing line — use it as the
  // completion signal, with a generous fallback in case the camera isn't
  // on that doc when it happens.
  console.log('Waiting for the tour to finish …');

  try {
    await page
      .getByText('Poke around!', { exact: false })
      .waitFor({ state: 'visible', timeout: 4 * 60_000 });
    console.log('Tour finished — wrapping up.');
    await page.waitForTimeout(2_000);
  } catch {
    console.log('Completion line not seen in time — stopping anyway.');
  }

  // Grab the path while the page handle is still alive — recordVideo names
  // files by an internal hash, not something we control up front.
  const rawVideoPath = await page.video()?.path();

  await context.close();
  await browser.close();

  if (!rawVideoPath) {
    console.log(`Video saved under ${outDir}`);

    return;
  }

  const webmPath = path.join(outDir, 'demo.webm');
  renameSync(rawVideoPath, webmPath);
  console.log(`Raw recording (includes the setup spinner): ${webmPath}`);

  const mp4Path = path.join(outDir, 'demo.mp4');
  const ffmpegArgs = [
    '-y',
    '-ss',
    skipSeconds.toFixed(2),
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
    '-movflags',
    '+faststart',
    '-an',
    mp4Path,
  ];

  const result = spawnSync('ffmpeg', ffmpegArgs, { stdio: 'inherit' });

  if (result.error || result.status !== 0) {
    console.log(
      "Could not run ffmpeg automatically — here's the trim + convert command to run by hand:",
    );
    console.log(
      `  ffmpeg ${ffmpegArgs.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`,
    );

    return;
  }

  console.log(`Trimmed, web-ready MP4: ${mp4Path}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
