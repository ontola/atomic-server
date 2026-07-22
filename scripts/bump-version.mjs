#!/usr/bin/env node
/**
 * Bumps the release version across every Rust crate and @tomic/* JS package
 * in lockstep, per CONTRIBUTING.md's "Releases, Versioning and Tagging".
 *
 * Usage:
 *   node scripts/bump-version.mjs <old-version> <new-version>
 *
 * Does NOT touch:
 * - Lockfiles (Cargo.lock, pnpm-lock.yaml) — regenerate separately:
 *     cargo metadata --format-version 1 --no-deps
 *     cd browser && pnpm install --lockfile-only
 * - CHANGELOG.md files — update those by hand.
 * - Historical version mentions in prose docs (e.g. docs/src/svelte.md,
 *   CONTRIBUTING.md's own examples) — those describe a specific past
 *   release, not a live pin, and bumping them would misstate history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const [oldVersion, newVersion] = process.argv.slice(2);

if (!oldVersion || !newVersion) {
  console.error('Usage: node scripts/bump-version.mjs <old-version> <new-version>');
  process.exit(1);
}

// Rust crates: package version + any `atomic_lib` dependency version
// constraint, both written as the literal string `version = "<ver>"`.
const RUST_FILES = ['lib/Cargo.toml', 'cli/Cargo.toml', 'server/Cargo.toml', 'desktop/Cargo.toml'];

// JS packages: bump "version", and any "@tomic/*" dependency pinned to the
// old version (workspace:* deps are left alone, they don't carry a version).
const JS_PACKAGE_FILES = [
  'browser/package.json',
  'browser/lib/package.json',
  'browser/react/package.json',
  'browser/svelte/package.json',
  'browser/plugin/package.json',
  'browser/cli/package.json',
  'browser/create-template/package.json',
  'browser/data-browser/package.json',
  'browser/edit-mode/package.json',
  'browser/e2e/package.json',
];

// Scaffolded end-user app templates: these carry their OWN app version
// (unrelated to the atomic-server release), so only their "@tomic/*"
// dependency constraints get bumped — never the "version" field itself.
const TEMPLATE_PACKAGE_FILES = [
  'browser/create-template/templates/nextjs-site/package.json',
  'browser/create-template/templates/sveltekit-site/package.json',
];

// Plain "version" field, JSON, not an npm package.
const VERSION_ONLY_JSON_FILES = ['desktop/tauri.conf.json'];

let changedFiles = 0;

function replaceInFile(relPath, transform) {
  const absPath = path.join(ROOT, relPath);
  const before = fs.readFileSync(absPath, 'utf8');
  const after = transform(before);

  if (after === before) {
    console.warn(`  ! no change: ${relPath} (old version string not found?)`);
    return;
  }

  fs.writeFileSync(absPath, after);
  changedFiles += 1;
  console.log(`  ${relPath}`);
}

console.log(`Rust crates: ${oldVersion} -> ${newVersion}`);
for (const relPath of RUST_FILES) {
  replaceInFile(relPath, (content) =>
    content.replaceAll(`version = "${oldVersion}"`, `version = "${newVersion}"`),
  );
}

console.log(`\nJS package versions + @tomic/* deps: ${oldVersion} -> ${newVersion}`);
for (const relPath of JS_PACKAGE_FILES) {
  replaceInFile(relPath, (content) => {
    let next = content.replace(
      /"version":\s*"[^"]*"/,
      `"version": "${newVersion}"`,
    );
    next = next.replace(
      new RegExp(`("@tomic/[a-z-]+":\\s*")\\^?${escapeRegExp(oldVersion)}(")`, 'g'),
      (_match, prefix, suffix) => `${prefix}^${newVersion}${suffix}`,
    );
    return next;
  });
}

console.log(`\nTemplate @tomic/* deps only (own app version untouched): ${oldVersion} -> ${newVersion}`);
for (const relPath of TEMPLATE_PACKAGE_FILES) {
  replaceInFile(relPath, (content) =>
    content.replace(
      new RegExp(`("@tomic/[a-z-]+":\\s*")\\^?${escapeRegExp(oldVersion)}(")`, 'g'),
      (_match, prefix, suffix) => `${prefix}^${newVersion}${suffix}`,
    ),
  );
}

console.log(`\nOther version fields: ${oldVersion} -> ${newVersion}`);
for (const relPath of VERSION_ONLY_JSON_FILES) {
  replaceInFile(relPath, (content) =>
    content.replace(`"version": "${oldVersion}"`, `"version": "${newVersion}"`),
  );
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

console.log(`\n${changedFiles} file(s) updated.`);
console.log('\nNext steps:');
console.log('  cargo metadata --format-version 1 --no-deps');
console.log('  cd browser && pnpm install --lockfile-only');
console.log('  Update CHANGELOG.md and browser/CHANGELOG.md by hand.');
