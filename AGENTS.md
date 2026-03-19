# AGENTS.md

Guidance for coding agents working in this repo.

## Read First

Before assuming the browser or local dev setup is broken, check:

- [`README.md`](/Users/joep/dev/github/atomicdata-dev/atomic-server/README.md)
- [`CONTRIBUTING.md`](/Users/joep/dev/github/atomicdata-dev/atomic-server/CONTRIBUTING.md)
- [`browser/CONTRIBUTING.md`](/Users/joep/dev/github/atomicdata-dev/atomic-server/browser/CONTRIBUTING.md)
- [`browser/e2e/tests/e2e.spec.ts`](/Users/joep/dev/github/atomicdata-dev/atomic-server/browser/e2e/tests/e2e.spec.ts)
- [`browser/e2e/tests/test-utils.ts`](/Users/joep/dev/github/atomicdata-dev/atomic-server/browser/e2e/tests/test-utils.ts)

The Playwright E2E helpers are the best source of truth for expected local browser flows.

## Local Browser Mental Model

- `http://localhost:5173` is the frontend app origin.
- `http://localhost:9883` is the local Atomic Server origin.
- The frontend on `5173` should auto-update during normal local development.
- If you patch browser code and do not see the change, reload the page first.
- If the UI still looks stale, check whether the changed package needs a rebuild.

From [`browser/CONTRIBUTING.md`](/Users/joep/dev/github/atomicdata-dev/atomic-server/browser/CONTRIBUTING.md):

- Vite provides HMR for the data browser.
- If you edit `@tomic/lib` or `@tomic/react`, the browser may still depend on built `.js` output, so those packages may need rebuilding or watch mode.

## Charlotte / Browser Automation

When using Charlotte or any browser automation:

- Keep the main automation anchored in the frontend app at `5173`.
- Do not treat direct navigation to `9883` as equivalent to the app state on `5173`.
- Use the top-left `Open Drive Settings` control as the main entry point for drive/server changes.

If the app is pointed at `5173` as its active drive/server, the UI can look broken:

- opening `http://localhost:5173/` as a resource returns `404`
- websocket attempts go to `ws://localhost:5173/ws` and fail
- you may see `Unauthorized`, `Resource not found`, or `Something went wrong`

This usually means the drive/server configuration is wrong, not that the app is dead.

## Known Good UI Flow

### Sign in or create a local identity

1. Open `Login / New User`.
2. Click `Create new identity`.
3. Copy the generated secret.
4. Click `Yes, I've stored it safely`.

After that, the sidebar entry becomes `User Settings`.

Known oddity:

- During identity creation you may see an error like `Could not fetch url 'did:ad:agent:...', must start with http.`
- Treat that as noise unless it blocks the flow.

### Switch to the local server

1. Click `Open Drive Settings`.
2. Go to the drive configuration UI.
3. Set the custom drive URL to `http://localhost:9883`.
4. Save it.

See the `changeDrive()` helper in [`browser/e2e/tests/test-utils.ts`](/Users/joep/dev/github/atomicdata-dev/atomic-server/browser/e2e/tests/test-utils.ts).

### Create a fresh drive

Once an agent exists:

1. Click `Open Drive Settings`.
2. Click `New Drive`.
3. Fill `Name` and `Subdomain`.
4. Click `Create`.
5. Wait for the app to navigate to a `did:ad:` subject.
6. Confirm the sidebar drive title updates.

See the `newDrive()` helper in [`browser/e2e/tests/test-utils.ts`](/Users/joep/dev/github/atomicdata-dev/atomic-server/browser/e2e/tests/test-utils.ts).

## Practical Debugging Checklist

- Is the frontend open on `5173`?
- Is the active drive/server actually `9883`?
- Is there a signed-in agent?
- If browser flows need isolation, create a fresh drive first.
- For browser behavior, compare against the E2E helpers before inventing a new interaction path.
