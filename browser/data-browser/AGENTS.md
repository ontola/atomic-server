## Editing UI

When working on the data-browser, determine if you need to change or add UI, if so, read `./UI_COMPONENTS.md` for a list of existing reusable components.
Prefer the existing reusable layout, resource view, overlay, button, loading, and accessibility components listed there before building new components from scratch.

## Tech Stack

This project uses Pnpm, Vite, React, TypeScript, Styled Components, and the Atomic Data ecosystem.

### React Compiler

We are using the React Compiler so manual memoization is often not needed. Make sure to follow the rules of React Hooks so the compiler can do its job.
The compiler currently has some trouble compiling components that contain try/catch blocks with complex logic like if statements or async code.
Additionally the use of `finally` is not yet supported inside components.
Those show up as Vite warnings from `oxc-transform-react` and as Oxlint `react/*` compiler rules; the component still runs, just without auto-memoization.
styled-components `displayName` is added by Oxc's built-in plugin on Vite's oxc pass — there is no Babel in this package.

After editing a React component or hook, check its compiler diagnostics with:

```sh
# From the repository root; accepts multiple files or absolute paths.
node browser/data-browser/scripts/check-react-compiler.mjs browser/data-browser/src/chunks/AI/useAtomicTools.ts
# From browser/data-browser:
pnpm check:react-compiler src/chunks/AI/useAtomicTools.ts
```

The check uses the app's installed Oxc compiler and exits nonzero on diagnostics
(including optimization bailouts). It reports whether memoization was emitted
for the file, not whether every function was memoized. A clean transform without
memoization is explicitly reported; check for opt-outs or ineligible functions.
IDE extensions using Babel React Compiler can report different results. Run
`pnpm typecheck` separately for TypeScript errors.

Diagnostics default to `file:line:column — message`; add `--verbose` for code
frames.

### Opt-in: run the check automatically after edits

`scripts/react-compiler-hook.mjs` can run as a personal `PostToolUse` hook. It is
not enabled for the repository: running node and git after every tool call is a
per-person choice. After each Edit, Write or Bash call it checks staged,
unstaged and untracked JS/TS in `browser/data-browser/src` (excluding tests,
declaration files and workers). It is:

- **advisory** — diagnostics come back as `additionalContext` for the agent,
  never as a block decision; if the hook itself fails, it says so the same way.
- **cached** — content hashes are kept per checkout and session in the OS
  temporary directory, so unchanged and clean files produce no output.
- **never blocking** — it always exits 0. Existing issues may show up on the
  first check; fix regressions relevant to the task, not unrelated bailouts.

Claude Code: add this to your git-ignored `.claude/settings.local.json` at the
repository root (merge with what is already there), then check `/hooks`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "^(Edit|Write|Bash)$",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(git rev-parse --show-toplevel)/browser/data-browser/scripts/react-compiler-hook.mjs\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Codex: add this to your personal `~/.codex/hooks.json`. Being user-wide, the
command only runs where the script exists, so other repositories are unaffected.
Review the hook in `/hooks` to trust it; until then, use the manual command.

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "^(Bash|apply_patch|Edit|Write)$",
        "hooks": [
          {
            "type": "command",
            "command": "f=\"$(git rev-parse --show-toplevel 2>/dev/null)/browser/data-browser/scripts/react-compiler-hook.mjs\"; [ -f \"$f\" ] && node \"$f\" || true",
            "timeout": 30,
            "additionalContextLimit": 1500
          }
        ]
      }
    ]
  }
}
```

Hook feedback does not replace `pnpm typecheck` or runtime tests.

## Localization

We are using Wuchale for localization.
It handles text extraction and translation automatically.
Use ignore comments (`/* @wc-ignore */` or `// @wc-ignore-file`) to exclude certain strings or files from being translated (For example agent system prompts).
All strings not in any function or JSX scope are automatically ignored. Strings in functions or element attributes are ignored when they do not start with a capital letter.

## Verify your edits

After your done makeing your changes. Use `pnpm typecheck` to verify there are no type errors.
