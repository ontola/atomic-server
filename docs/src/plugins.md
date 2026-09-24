# Atomic Plugins

Atomic Plugins are applications that can run inside of an Atomic Server.
They enhance the functionality of an Atomic Server by extending one or more classes.

For example they can be used to create more restrictive requirements for classes, like requiring names to start with an uppercase letter.
They can also add dynamic properties to classes that get populated each time the resource is fetched.

Plugins can be created in any programming language that compiles to Wasm, or written in JavaScript in the browser.
For more information on how to create a plugin, see [Creating Plugins](plugins/creating-plugins.md).

## Releases, Listings and Installations

Three classes describe a plugin's life on a server:

- A **Release** is an immutable, content-addressed package: JS source (`atomic-js/1`) or a WASM zip (`wasip2/1`), its manifest, and a `releaseId` (`blake3:…` over every field). It lives at `<server>/releases/<id>` on the server it was published to, and can be fetched from any other server.
- A **Listing** is a marketplace entry pointing at a Release: name, emoji, description, domains, standards. Every Listing the public can read on a server is part of that server's Store; `GET /plugin-catalog` returns them as `{ "entries": [...], "hostFeatures": {...} }`, where `hostFeatures.pluginRoutes` says whether this server lets plugins open public endpoints (see [Plugin public endpoints](atomicserver/installation.md#plugin-public-endpoints-opt-in)). Any drive of Listings is a marketplace.
- An **Installation** is one installed Release on one Drive. It pins the `release` URL and its `releaseId`, holds the `grants` you approved, your `config`, and an `installationStatus` (`draft`, `active`, `paused`, `revoked`). Committing it as `active` is the single install trigger for both runtimes; `paused` stops the plugin without uninstalling it, keeping its files, its config and the agent it signs as; `revoked` or destroying the resource uninstalls it and retires that agent. Updating a plugin means pointing the same Installation at a newer Release, which keeps everything the plugin already owns.

## Installing a plugin

You need write access to the drive the plugin will be installed on. Two ways in, one review:

- **From the Store**: open the Store, pick a Listing and click 'Install'.
- **From a zip**: on the drive, choose 'Upload plugin' and select the zip. The server publishes it as a private Release on this server first.

Both end in the Installation review: the release's manifest, every capability it declares with the reason its author gave, the origins it may reach, and a config field. The server only activates an Installation whose `grants` equal exactly the set of capabilities the manifest declares, so nothing is approved by omission. You can change the config at any time once the plugin is installed; changing it does not reinstall anything.

Pausing an Installation keeps its files and identity; resuming the same release does not extract or compile it again. Revoking or deleting it removes the plugin's files, its class extender and its agent.

Servers that still have plugins installed the old way (a `Plugin` resource with a `pluginFile`) migrate them on startup: the zip becomes a Release, and the same resource becomes an active Installation pinned to it, without touching what is on disk.

## Giving your plugin access to resources

By default plugins do not have access to any resources unless they have the `full-drive-access` capability.
To add access to specific resources (and their children) navigate to the Installation page and add the resource in the 'Assign Rights' section.

<!-- ## Hooks

### BeforeCommit

Is run before a Commit is applied.
Useful for performing authorization or data shape checks.

## Wasm class extenders

Atomic Server can load class extenders that are compiled to WASM + WASI Preview 2 (aka wasip2).
Every extender implements the [`class-extender.wit`](../../lib/wit/class-extender.wit) world and exports:

- `class-url` – the Subject URL of the class to extend
- `on-resource-get`
- `before-commit`
- `after-commit`

Handlers receive JSON-AD payloads that describe the Resource or Commit they should work with and can return an updated JSON-AD document. See the WIT file for the exact record layouts.

### Installing a WASM class extender

1. Build a component that targets `wasm32-wasip2`. Use `wit-bindgen` or `cargo component` to satisfy the interface defined in `lib/wit/class-extender.wit`.
2. Copy the resulting `.wasm` file into the `wasm-class-extenders/` directory inside your Atomic data directory (next to the sled store).
3. Restart `atomic-server` (or recreate the `Db`) so it scans the folder and instantiates your component.

All `.wasm` files in that folder are loaded on startup. Errors are logged but do not prevent the server from running, making it safe to iterate on plugins.

### Sample Wasm extender

See `wasm-plugins/examples/random-folder-extender` for a minimal Rust project that implements the `class-extender` WIT interface. It appends a random suffix to the `name` property of every `https://atomicdata.dev/classes/Folder` resource whenever it is fetched. Build it with `cargo component build --release -p random-folder-extender --target wasm32-wasip2` and copy the resulting `.wasm` into your `wasm-class-extenders/` directory to try it out. -->



## Integration discovery preferences

Open **Settings → Integration** to choose which plugins appear on the
**Integrations** page:

- **Show experimental plugins** displays the catalog's experimental entries and
  unverified community plugins.

Which plugins exist, and which category each belongs to, comes from the remote
plugin catalog. The default is
`https://ontola.github.io/atomic-plugins/integrations/catalog.json`, published
from [atomic-plugins](https://github.com/ontola/atomic-plugins); you can change
it in **Settings → Integration**. Proxy-backed
experimental plugins require both options to be enabled. Other experimental
plugins only require **Show experimental plugins**.

Both options are unchecked by default. When a category
is hidden, the Integrations page links to Settings so you can consider enabling
it. Hidden catalogs are not fetched.

These preferences are saved as boolean properties on your private Atomic drive,
using its ontology, and follow that drive through normal Atomic sync. They are
personal preferences, not settings on the currently open shared workspace.
Turning them off hides discovery listings; it does not remove existing
connections or stop their automations. Enabling a category does not certify its
plugins or grant permission to run them.
