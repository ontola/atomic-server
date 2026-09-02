# Custom Views

Along with a Wasm class extender, plugins can also include a JavaScript bundle to add custom views to the AtomicServer Data Browser.

To enable a custom view, include the `custom-view` permission in your plugin manifest.

## How Custom Views Are Loaded

When a user navigates to a resource whose class is handled by your plugin, the Data Browser renders the custom view inside a **sandboxed, null-origin `<iframe>`**. This means your plugin UI runs in complete isolation from the parent page — it cannot access the parent's DOM, storage, or JavaScript context.

The iframe receives a generated HTML document that:

1. Loads a reset stylesheet.
2. Optionally loads your `ui.css` file.
3. Injects the current theme as CSS custom properties via a `<style>` block.
4. Loads your `ui.js` as a `<script type="module">`.

A strict Content Security Policy is applied: only scripts and styles with the correct nonce are allowed to run. External scripts or inline scripts without the nonce will be blocked.

## Bundle Requirements

Because the view is loaded as a single HTML document inside an iframe, **code splitting is not supported**. Your build must produce:

- `ui.js` — a single JavaScript file (no chunks). This file is required.
- `ui.css` — an optional single CSS file.

> [!IMPORTANT]
> It is currently not possible to include external assets (images, fonts, etc.) in your plugin UI. Any assets must be inlined into `ui.js` or `ui.css` (e.g. base64-encoded data URIs).

Configure your bundler to disable code splitting. For example, with Vite + Rolldown:

```ts
// vite.config.ts
export default {
  build: {
    assetsDir: '',
    rolldownOptions: {
      output: {
        codeSplitting: false,
        assetFileNames: 'ui.[ext]',
        entryFileNames: 'ui.js',
      },
    },
  },
};
```

When configured like this, you can still make as many js and css files as you want and they will then be bundled into a single js and css file.

## Choosing a UI Framework

Because the plugin JS bundle must be self-contained and small, **prefer a lightweight framework like [SolidJS](https://www.solidjs.com/)** over React. React (and ReactDOM) add ~130 kB to your bundle, whereas SolidJS compiles away to vanilla DOM operations and adds only a few kilobytes.

The test plugin uses SolidJS with the `vite-plugin-solid` plugin as a reference implementation.

## Communicating with the Data Browser

Since the plugin runs in a sandboxed iframe, it cannot directly call the Atomic Store or make authenticated requests. All communication with the host Data Browser is handled via `postMessage`, abstracted by the `RPCClient` from the `@tomic/plugin` package.

### Setting Up

Install the package:

```bash
npm install @tomic/plugin
```

Create an `RPCClient` instance once when your app starts:

```ts
import { RPCClient } from '@tomic/plugin';

const rpc = new RPCClient();
```

### RPCClient API

#### `getPageContext(): Promise<PageContext>`

Returns the current page context, including the resource being viewed and the current user's agent subject.

```ts
const { resource, agent } = await rpc.getPageContext();
console.log(resource.subject); // the URL of the current resource
```

```ts
interface PageContext {
  resource: Resource;
  agent?: string; // Subject of the user's agent
}
```

#### `getResource(subject: string): Promise<Resource>`

Fetches a resource from the host store by its subject URL.

```ts
const resource = await rpc.getResource('https://example.com/my-resource');
```

**`Resource`:**

```ts
interface Resource {
  subject: string;
  title: string;
  loading: boolean;
  props: Record<string, JSONValue>;
}
```

**Access control:** The plugin can read a resource without any user interaction if any of the following conditions are true:

- The resource is the current page resource (the one the plugin view is rendering).
- The resource's parent is the current page resource.
- Any ancestor of the resource satisfies either of the above.
- The plugin's agent is listed in the resource's (or any ancestor's) `read` or `write` rights.

If none of these conditions are met, the user is shown a **Read Request** dialog asking them to allow or deny access to that specific resource. The user can also check "Allow all reads done by this plugin" to permanently grant the plugin blanket read access. Previously granted permissions are persisted, so the dialog will not appear again for the same resource. If the user denies the request, the promise rejects with an error.

#### `commit(commit: Commit): Promise<{ success: true }>`

Applies a commit to a resource. The commit is signed by the user's agent.

```ts
await rpc.commit({
  subject: 'https://example.com/my-resource',
  set: {
    'https://atomicdata.dev/properties/name': 'New name',
  },
});
```

```ts
interface Commit {
  subject: string;
  set?: Record<string, JSONValue>;
  push?: Record<string, unknown[]>;
  remove?: string[];
  destroy?: boolean;
}
```

**Access control:** The same scope rules as `getResource` apply, but for write access. The plugin can write without a prompt if:

- The target resource is the current page resource.
- The target resource's parent is the current page resource.
- Any ancestor of the resource satisfies either of the above.
- The plugin's agent is listed in the resource's (or any ancestor's) `write` rights.

If none of these conditions are met, the user is shown a **Write Request** dialog. As with read access, the user can permanently grant blanket write permission, and previously granted permissions are persisted. If the user denies, the promise rejects with an error.

> [!NOTE]
> Commits that target plugin resources are always blocked, regardless of permissions. A plugin cannot modify itself or any other plugin resource.

#### `subscribe(subject: string, callback: (resource: Resource) => void): () => void`

Subscribes to live updates for a resource. Returns an unsubscribe function.

```ts
const unsubscribe = rpc.subscribe('https://example.com/my-resource', (resource) => {
  console.log('Resource updated:', resource);
});

// Later, to stop listening:
unsubscribe();
```

#### `navigate(subject: string): Promise<boolean>`

Navigates the Data Browser to a different resource.

```ts
await rpc.navigate('https://example.com/other-resource');
```

#### `pickResource(options?): Promise<Resource | undefined>`

Opens a resource picker dialog in the Data Browser. Resolves with the selected resource, or `undefined` if the user cancels.

```ts
const picked = await rpc.pickResource({
  title: 'Select a document',
  message: 'Pick the document you want to link.',
  isA: 'https://atomicdata.dev/classes/Document', // optional: filter by class
  scope: 'https://example.com/my-drive',          // optional: limit search scope
});
```

#### `pickFile(options?): Promise<Resource | undefined>`

Opens a file picker dialog. The user can select an existing file on AtomicServer or upload a new one. Resolves with the file resource, or `undefined` if cancelled.

```ts
const file = await rpc.pickFile({
  allowedMimes: ['image/png', 'image/jpeg'],
});
```
