# AGENTS.md

Guidance for coding agents working in this repo.

## Local Setup

- `http://localhost:5173` — Vite dev server (frontend).
- `http://localhost:9883` — local Atomic Server.

The frontend auto-updates via HMR. If changes don't appear, reload the page. If you edit `@tomic/lib` or `@tomic/react`, those packages may need a rebuild first.

## Quick Dev Setup

Navigate to `http://localhost:5173/app/dev-drive` to instantly create a fresh agent + drive on `localhost:9883` and switch to it. Only works in dev mode.

In E2E tests, most specs use `test.beforeEach(before)` from `test-utils.ts`, which calls `devDrive(page)` and gives every test a fresh agent + drive. For a second browser context signed in as the same user, use `getDevDriveSecret(page)` after `before` has run. Call `devDrive(page)` directly only when a spec does not use the shared `before` hook.

## Charlotte / Browser Automation

- Always operate the app at `localhost:5173`, not `9883` directly.
- Start every session by navigating to `http://localhost:5173/app/dev-drive` to get a clean, authenticated state.
- If the app shows `Unauthorized` or `Something went wrong`, navigate to `/app/dev-drive` to fix it.

## Debugging Checklist

- Is the frontend open on `5173`?
- Is the active drive/server `9883`?
- Is there a signed-in agent?
- Run `devDrive(page)` to reset to a clean state.
