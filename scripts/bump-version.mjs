#!/usr/bin/env node
/**
 * Bumps the release version across every Rust crate, @tomic/* JS package, and
 * the Flutter `atomic_lib` pubspec in lockstep, per CONTRIBUTING.md's
 * "Releases, Versioning and Tagging".
 *
 * Usage:
 *   node scripts/bump-version.mjs <old-version> <new-version>
 *   node scripts/bump-version.mjs --check <version>
 *
 * `--check` verifies every site already declares <version> and exits non-zero
 * listing the ones that don't. Run it in CI and before tagging: a release
 * where one package.json lagged behind publishes a broken version pair to npm,
 * and nothing else in the pipeline compares these files to each other.
 *
 * Does NOT touch:
 * - Lockfiles (Cargo.lock, pnpm-lock.yaml) — regenerate separately:
 *     cargo update --workspace
 *     cd browser && pnpm install --lockfile-only
 *   NOT `cargo metadata --no-deps`, which CONTRIBUTING.md used to recommend:
 *   it skips dependency resolution and so leaves the workspace members' own
 *   versions stale in Cargo.lock. Verified — it silently no-ops.
 * - CHANGELOG.md files — update those by hand.
 * - `dart/atomic_lib/example/pubspec.yaml` — example app version is independent
 *   (same idea as create-template scaffolds).
 * - Historical version mentions in prose docs (e.g. docs/src/svelte.md,
 *   CONTRIBUTING.md's own examples) — those describe a specific past
 *   release, not a live pin, and bumping them would misstate history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
const checkMode = args[0] === '--check';
const [oldVersion, newVersion] = checkMode ? [null, args[1]] : args;

if (checkMode ? !newVersion : !oldVersion || !newVersion) {
  console.error('Usage: node scripts/bump-version.mjs <old-version> <new-version>');
  console.error('       node scripts/bump-version.mjs --check <version>');
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

// Flutter / Dart pub packages published from this repo.
const DART_PUBSPEC_FILES = ['dart/atomic_lib/pubspec.yaml'];

let changedFiles = 0;

/**
 * Every place a release version is declared, and how to read it back. Kept
 * beside the writers above so a new site cannot be added to one and forgotten
 * in the other -- which is the failure this check exists to catch.
 */
const DECLARED_VERSION_SITES = [
  ...RUST_FILES.map(f => ({ file: f, re: /^version = "([^"]+)"/m })),
  ...JS_PACKAGE_FILES.map(f => ({ file: f, re: /"version":\s*"([^"]+)"/ })),
  ...VERSION_ONLY_JSON_FILES.map(f => ({ file: f, re: /"version":\s*"([^"]+)"/ })),
  ...DART_PUBSPEC_FILES.map(f => ({ file: f, re: /^version:\s*(\S+)/m })),
];

function runCheck(expected) {
  const mismatches = [];

  for (const { file, re } of DECLARED_VERSION_SITES) {
    const found = fs.readFileSync(path.join(ROOT, file), 'utf8').match(re)?.[1];

    if (found !== expected) {
      mismatches.push(`  ${file}: ${found ?? '(no version field)'}`);
    }
  }

  // Templates carry their own app version, so only their @tomic/* constraints
  // are release-coupled.
  for (const file of TEMPLATE_PACKAGE_FILES) {
    const content = fs.readFileSync(path.join(ROOT, file), 'utf8');

    for (const [, dep, ver] of content.matchAll(/"(@tomic\/[a-z-]+)":\s*"\^?([^"]+)"/g)) {
      if (ver !== expected) mismatches.push(`  ${file}: ${dep} -> ${ver}`);
    }
  }

  if (mismatches.length > 0) {
    console.error(`Expected every site to declare ${expected}, but:`);
    console.error(mismatches.join('\n'));
    process.exit(1);
  }

  console.log(`All ${DECLARED_VERSION_SITES.length} version sites agree on ${expected}.`);
  process.exit(0);
}

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

if (checkMode) runCheck(newVersion);

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

console.log(`\nDart / Flutter pubspecs: ${oldVersion} -> ${newVersion}`);
for (const relPath of DART_PUBSPEC_FILES) {
  replaceInFile(relPath, (content) =>
    content.replace(
      new RegExp(`^version:\\s*${escapeRegExp(oldVersion)}\\s*$`, 'm'),
      `version: ${newVersion}`,
    ),
  );
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

console.log(`\n${changedFiles} file(s) updated.`);
console.log('\nNext steps:');
console.log('  cargo metadata --format-version 1 --no-deps');
console.log('  cd browser && pnpm install --lockfile-only');
console.log('  Update CHANGELOG.md, browser/CHANGELOG.md, and dart/atomic_lib/CHANGELOG.md by hand.');
