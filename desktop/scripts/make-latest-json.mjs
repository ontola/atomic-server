#!/usr/bin/env node
// Writes the `latest.json` the desktop updater reads, from the signed update
// artifacts the release build collected.
//
//   node make-latest-json.mjs <artifacts-dir> <tag> <owner/repo> > latest.json
//
// The updater verifies each file against the signature written here, so a
// platform without a `.sig` next to its artifact is left out rather than
// listed unsigned.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Which updater platforms an artifact (named by its suffix) serves. */
const PLATFORMS = [
  // The macOS bundle is universal: one archive for both architectures.
  { suffix: '.app.tar.gz', keys: ['darwin-aarch64', 'darwin-x86_64'] },
  { suffix: '.AppImage', keys: ['linux-x86_64'] },
  { suffix: '-setup.exe', keys: ['windows-x86_64'] },
];

export function makeLatestJson(files, read, tag, repo, now = new Date()) {
  const platforms = {};

  for (const { suffix, keys } of PLATFORMS) {
    const artifact = files.find(f => f.endsWith(suffix));

    if (!artifact || !files.includes(`${artifact}.sig`)) continue;

    const entry = {
      signature: read(`${artifact}.sig`).trim(),
      url: `https://github.com/${repo}/releases/download/${tag}/${artifact}`,
    };

    for (const key of keys) platforms[key] = entry;
  }

  return {
    version: tag.replace(/^v/, ''),
    notes: `https://github.com/${repo}/releases/tag/${tag}`,
    pub_date: now.toISOString(),
    platforms,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, tag, repo] = process.argv.slice(2);

  if (!dir || !tag || !repo) {
    console.error('usage: make-latest-json.mjs <artifacts-dir> <tag> <owner/repo>');
    process.exit(2);
  }

  const latest = makeLatestJson(
    readdirSync(dir),
    name => readFileSync(join(dir, name), 'utf8'),
    tag,
    repo,
  );

  if (Object.keys(latest.platforms).length === 0) {
    console.error('No signed update artifacts found; not writing latest.json.');
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify(latest, null, 2)}\n`);
}
