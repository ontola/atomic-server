// Shell-agnostic `TAURI=1 vite build`: the inline `VAR=1 cmd` form is not
// valid under cmd.exe (Tauri Windows build).
import { spawnSync } from 'node:child_process';

const res = spawnSync('vite', ['build'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, TAURI: '1' },
});

process.exit(res.status ?? 1);
