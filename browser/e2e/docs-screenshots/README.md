# Docs screenshots

Regenerates the screenshots in `docs/src/assets/app/` from a real app, so they
can be retaken whenever the UI changes.

```sh
cd server && cargo run          # :9883, with the WASM built (pnpm --filter @tomic/data-browser build:wasm)
cd browser && pnpm start        # :6747
cd browser && pnpm docs:screenshots            # all scenes
cd browser && pnpm docs:screenshots -g ai-chat # one scene (a regex: -g 'forms$' skips forms-fill)
```

Scenes, one `.png` each: `ai-chat`, `chat`, `overview`, `drives`, `documents`,
`sharing`, `tables`, `kanban`, `meetings`, `canvas`, `apps`, `forms`,
`forms-fill`.

Each scene (`scenes.ts`) starts from a fresh agent and drive ("Alex Morgan" in
"Acme team"), at 1440x900 @2x, light theme. Add a scene there and list it in
`screenshots.spec.ts`; its `.png` is named after the scene.

- `DOCS_SCREENSHOTS_OUT` changes the output folder, `DOCS_SCREENSHOTS_COPY_TO`
  writes a second copy.
- The AI chat talks to `fake-ollama.ts`, a scripted model on port 11434, so no
  key, model or network is needed. Stop a real Ollama first.
- Group chat messages are sent with the sender's clock set to a scripted time,
  and Alex's clock is frozen before the capture, so "22 minutes ago" is stable.
- Avatar colours come from each agent's random key and differ between runs.
- The `forms` scene builds its form by asking the scripted model for it, so the
  app's own `create_form` tool does the work. `forms-fill` publishes it and
  fills it in as a visitor on the server's `/form/` page, then waits for the
  captcha to say Verified.
- The `apps` scene creates an App from the catalog and replaces its source with
  `team-tasks-app.js` (the Tasks table's subject and estimate column are filled
  in at run time).
- The `canvas` scene draws with the mouse, at fixed positions; the red strokes
  use the pen colour button, which swaps to the previous colour.
- Activity lists say "now" for rows made seconds ago. Scenes that fill the
  sidebar (`sidebarFiller`) only create what the shot needs.
