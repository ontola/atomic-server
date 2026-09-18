#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const git = (args, options = {}) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options });
const changed = git(['diff', '--cached', '--name-only', '-z'])
  .split('\0')
  .filter(Boolean);
const browser = changed.some(file => file.startsWith('browser/'));
// Match CI's main Rust workspace; Flutter and desktop have separate toolchains.
const rust = changed.some(
  file =>
    !file.startsWith('flutter/') &&
    !file.startsWith('desktop/') &&
    (/\.rs$/.test(file) ||
      /(^|\/)Cargo\.(toml|lock)$/.test(file) ||
      file.startsWith('.cargo/') ||
      /^rust-toolchain(\.toml)?$/.test(file)),
);

if (!browser && !rust) process.exit(0);

// Git exports these during a commit. They must not make subprocesses inspect
// the original checkout instead of the staged snapshot.
const env = { ...process.env };
for (const key of git(['rev-parse', '--local-env-vars']).trim().split('\n'))
  delete env[key];

const targetDir = resolve(root, env.CARGO_TARGET_DIR || 'target');
// The snapshot of the index lives at a FIXED path and persists between
// commits. Cargo keys its fingerprints on the package path and decides
// staleness by source mtimes, so a fresh temp dir per commit meant every
// workspace crate was rebuilt from scratch, every time. Keeping the path and
// touching only the files that changed since the last sync makes the Clippy
// run as incremental as a normal `cargo clippy` in the checkout.
// Reset with `rm -rf target/pre-commit` if the snapshot ever looks wrong.
const snapshot = join(targetDir, 'pre-commit', 'snapshot');
// The index tree the snapshot currently holds (`git write-tree` OID).
const stamp = join(targetDir, 'pre-commit', 'tree');

// Check exactly what Git will commit, including partially staged files.
// No stash/reset: the user's index and working tree are never modified.
function syncSnapshot() {
  const tree = git(['write-tree']).trim();
  const previous =
    existsSync(stamp) && existsSync(snapshot)
      ? readFileSync(stamp, 'utf8').trim()
      : null;

  if (previous === tree) return;

  if (!previous) {
    rmSync(snapshot, { recursive: true, force: true });
    mkdirSync(snapshot, { recursive: true });
    git(['checkout-index', '--all', `--prefix=${snapshot}${sep}`], {
      stdio: 'inherit',
    });
  } else {
    const records = git([
      'diff-tree',
      '-r',
      '-z',
      '--no-renames',
      '--name-status',
      previous,
      tree,
    ]).split('\0');
    const stale = [];

    for (let i = 0; i + 1 < records.length; i += 2) {
      const [status, file] = [records[i], records[i + 1]];

      if (status === 'D') {
        rmSync(join(snapshot, file), { recursive: true, force: true });
        // Leave no empty directories behind.
        for (
          let dir = dirname(join(snapshot, file));
          dir !== snapshot && readdirSync(dir).length === 0;
          dir = dirname(dir)
        )
          rmdirSync(dir);
      } else {
        stale.push(file);
      }
    }

    if (stale.length > 0) {
      // `-f` also replaces a file with a directory and vice versa.
      git(
        ['checkout-index', '-f', '-z', '--stdin', `--prefix=${snapshot}${sep}`],
        {
          input: stale.join('\0') + '\0',
          stdio: ['pipe', 'inherit', 'inherit'],
        },
      );
    }
  }

  writeFileSync(stamp, `${tree}\n`);
}

try {
  syncSnapshot();

  if (browser) {
    const browserRoot = join(root, 'browser');

    if (!existsSync(join(browserRoot, 'node_modules'))) {
      throw new Error(
        'Browser dependencies missing. Run: cd browser && pnpm install',
      );
    }

    // Reuse installed dependencies, but lint only staged source/configuration.
    const directories = [
      '',
      ...readdirSync(join(snapshot, 'browser'), {
        withFileTypes: true,
      })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name),
    ];

    for (const directory of directories) {
      const modules = join(browserRoot, directory, 'node_modules');
      const link = join(snapshot, 'browser', directory, 'node_modules');

      if (existsSync(modules) && !existsSync(link)) {
        symlinkSync(modules, link, 'dir');
      }
    }

    console.log('pre-commit: linting staged browser snapshot');
    execFileSync('pnpm', ['run', 'lint'], {
      cwd: join(snapshot, 'browser'),
      env: {
        ...env,
        // This snapshot borrows node_modules through symlinks. Never let pnpm
        // repair/install them. Export both names for nested `pnpm run` calls:
        // pnpm 11 reads pnpm_config_*; older versions use npm_config_*.
        pnpm_config_verify_deps_before_run: 'false',
        npm_config_verify_deps_before_run: 'false',
      },
      stdio: 'inherit',
    });
  }

  if (rust) {
    // Clippy does not need the embedded frontend or plugin runtime, but
    // server/build.rs builds both unless told otherwise: without these the
    // snapshot (no `dist`, no `assets_tmp`) ran `pnpm install`, vite AND
    // wasm-pack on every commit. Same stub as CI's rustChecksContainer.
    const assets = join(snapshot, 'server', 'assets_tmp');

    if (!existsSync(assets)) {
      mkdirSync(assets, { recursive: true });
      writeFileSync(
        join(assets, 'index.html'),
        '<html><body>pre-commit stub</body></html>\n',
      );
    }

    console.log('pre-commit: checking staged Rust snapshot with Clippy');
    execFileSync(
      'cargo',
      [
        'clippy',
        '--workspace',
        '--exclude',
        'atomic-server-tauri',
        '--no-deps',
        '--all-targets',
        '--no-default-features',
        '--features',
        'light,wasm-plugins',
        '--',
        '-D',
        'warnings',
      ],
      {
        cwd: snapshot,
        env: {
          ...env,
          CARGO_TARGET_DIR: targetDir,
          ATOMICSERVER_SKIP_JS_BUILD: 'true',
          ATOMICSERVER_SKIP_PLUGIN_RUNTIME: 'true',
        },
        stdio: 'inherit',
      },
    );
  }
} catch (error) {
  console.error(`pre-commit: commit blocked. ${error.message}`);
  process.exitCode = 1;
}
