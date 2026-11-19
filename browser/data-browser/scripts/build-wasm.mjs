// Shell-agnostic `build:wasm`: the previous inline script used `export`, `&&`
// chains and `env -u`, which only work under sh/bash and broke under cmd.exe
// (Tauri Windows build), even with a configured script-shell.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(here, '../../../wasm');
const publicWasm = resolve(here, '../public/wasm');

const env = {
  ...process.env,
  CARGO_TARGET_DIR: resolve(wasmDir, '../target/wasm-pack'),
  CARGO_BUILD_BUILD_DIR: resolve(wasmDir, '../target/wasm-pack/build'),
};

const cargoWasmPack = args => {
  const res = spawnSync(
    'cargo',
    ['run', '-q', '--package', 'cargo-bin', '--', 'wasm-pack', ...args],
    { cwd: wasmDir, stdio: 'inherit', env: buildEnv(args) },
  );

  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
};

// wasm-pack build must not inherit the repo's rustflags (the old `env -u`).
function buildEnv(args) {
  if (args[0] !== 'build') {
    return env;
  }

  const { CARGO_ENCODED_RUSTFLAGS, RUSTFLAGS, ...rest } = env;

  return rest;
}

cargoWasmPack(['--version']);
cargoWasmPack(['build', '--target', 'web', '--out-dir', 'pkg']);

mkdirSync(publicWasm, { recursive: true });

for (const file of ['atomic_wasm.js', 'atomic_wasm_bg.wasm']) {
  copyFileSync(join(wasmDir, 'pkg', file), join(publicWasm, file));
}
