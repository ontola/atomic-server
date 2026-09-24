# Creating Plugins

Plugins can be made in any programming language that compiles to a Wasm component.
To be specific, they should be compiled to WASM + WASI Preview 2 (aka wasip2).

If you are using Rust, you can use the `atomic-plugin` crate to help with some of the Wasm boilerplate.

## Class Extenders

Plugins take the form of a class extender.
A class extender exports a few functions that get called at specific moments by the server.

- `class-url`: Returns a list of class URLs that the plugin extends.
- `on-resource-get`: Called when a resource is fetched from the server. You can modify the resource in place.
- `before-commit`: Called before a commit is applied to the server. If you return an error, the commit will be rejected.
- `after-commit`: Called after a commit is applied to the server. Returning an error will not cancel the commit.

They can also access a few functions provided by the server:

- `get-resource`: Returns a resource by subject.
- `query`: Returns a list of resources that match the query.
- `get-config`: Returns the JSON config of the plugin.
- `commit`: Creates and applies a commit signed by the plugin's agent.

<!-- TODO: Update this link to point to develop when the PR is merged -->
These functions are documented and typed in the [class-extender.wit](https://github.com/ontola/atomic-server/blob/c2a1aaf814e73381e597fc6472bf0dca9689084c/server/wit/class-extender.wit) file.
You can use this file to generate bindings for your programming language of choice.

## Namespaces

A plugin is identified by a namespace and a name.
The namespace is used to group plugins together and the name is used to identify the plugin within its namespace.
Plugins with the same namespace will share the same assets folder.

## Capabilities

Plugins declare capabilities to enable certain features.
They are listed in the manifest (`capabilities` in manifest v2, `permissions` in a legacy `plugin.json`), each with a reason so the person installing understands why the plugin needs it.
The Installation review shows every capability with its reason, and the server only activates an Installation whose `grants` are exactly the declared set.

The following capabilities are available:

- `storage`: Allows the plugin to read and write to the assets folder.
- `full-drive-access`: Allows the plugin access to all resources on the drive.
- `extended-fuel`: Allows the plugin to use extended fuel.
- `extended-memory`: Allows the plugin to use extended memory.
- `custom-view`: Allows the plugin to display a custom view in the Data Browser.

Network access is not a capability: declare the exact origins the plugin may reach in `network.origins` (a legacy `network` permission translates into that, and is refused without any origin).
A class extender that declares at least one origin gets `wasi-http` and the host `fetch`, limited to those origins.

> [!NOTE]
> If your Wasm component imports the `wasi-http` feature without declaring any `network.origins`, the plugin fails to instantiate.

## Access Rights

Each Installation gets its own [agent](../agents.md) that the plugin uses to fetch resources and sign commits.
By default that agent does not have access to any resources.
The user can grant access to specific resources on the Installation page.

Alternatively you can declare the `full-drive-access` capability in the manifest to give the agent full access to the drive.

## The plugin package

A WASM plugin is packaged as a zip file containing the following files:

- `plugin.wasm`: The compiled Wasm binary of the plugin.
- `plugin.json`: The plugin manifest.
- `assets/`: (Optional) A folder that will be included in the plugins zip file. The plugin will have access to this folder at runtime.
- `ui.js`: (Optional) A javascript file used for displaying a custom view in the Data Browser.
- `ui.css`: (Optional) A CSS file used for styling the custom view in the Data Browser.

You can use `atomic-plugin` to help with automating this process, even if you are not using Rust.

First install it using cargo:
<!-- TODO: We should probably also release some binaries so users don't need to install cargo -->
```bash
cargo install atomic-plugin
```

Next run it and point it to your files:

```bash
atomic-plugin --wasm <path-to-wasm-file> --assets <path-to-assets-folder> --out <output-path>
```

## Publishing and installing

A package becomes installable by being published as a **Release**.
Every way of publishing ends in the same record and the same install:

- **Upload the zip** in the Data Browser. The server publishes it as a private Release on that server and opens the Installation review.
- **`POST /plugin-release-package?drive=<drive>[&public=true][&world=<world>]`** with the zip as the body, signed by an agent that may write to `drive`. The response carries the `releaseId`, the Release URL (`<server>/releases/<id>`) and, with `public=true`, the Listing URL (`<server>/listings/<id>`) that puts it in the server's Store. Passing `world` is a check, not a choice: the world is read from the component, and a mismatch is refused.
- **JS plugins** are drafts (`plugin-script` resources) until published with `POST /plugin-release` (public, creates a Listing) or `POST /plugin-release-pin` (private).

The Release's manifest is what the installer reviews; for a zip it is the `plugin.json` translated to manifest v2, with `world` and the extended classes read from the component itself.
A package that extends classes is a `server-extension`; through an Installation it runs drive-scoped, seeing only the drive it was installed on.

Committing an **Installation** with `installationStatus: active`, a `release` (the Release URL or its id), the pinned `releaseId` and `grants` equal to the manifest's capabilities installs the plugin. Publishing the same bytes again yields the same id, so re-publishing is idempotent.

## Manifest v2

There is one manifest for every plugin, whatever language it is written in.
A JS plugin exports it as `export const manifest = {...}`; a WASM package ships it as `plugin.json`, which the server translates into the same shape at import (see [the legacy form](#the-plugin-manifest-legacy-pluginjson) below).
Every field except `schemaVersion` is optional; unknown fields and malformed declarations are rejected.

```json
{
  "schemaVersion": 2,
  "runtime": "atomic-js/1",
  "world": "extension",
  "entrypoints": { "run": true, "view": "ui.js", "classExtender": ["https://atomicdata.dev/classes/Folder"] },
  "capabilities": ["storage", { "name": "extended-fuel", "reason": "Syncs whole calendars" }],
  "secrets": [{ "name": "google", "origin": "https://www.googleapis.com" }],
  "operations": [{ "id": "events", "method": "GET", "url": "https://www.googleapis.com/calendar/v3/calendars/primary/events", "effect": "read" }],
  "actions": [],
  "network": { "origins": ["https://www.googleapis.com"], "reason": "Reads calendars" },
  "configSchema": {}, "defaultConfig": {},
  "name": "google-calendar", "namespace": "atomic", "version": "1.0.0", "description": "...", "author": "..."
}
```

- `runtime`: `atomic-js/1` (default) or `wasip2/1`. The language of the guest; it says nothing about trust.
- `world`: the trust boundary. `extension` (default) exports `run`, proposes effects and is user-installable. `server-extension` exports the class-extender hooks, may write, and is operator-installed. A `server-extension` must either run on `wasip2/1` (the component's `class-url` export names its classes) or list its classes in `entrypoints.classExtender`; an `extension` may not declare `classExtender`.
- `entrypoints`: `run` (default `true` when `entrypoints` is absent, `false` when it is present without `run`), `view` (a package-relative path, requires the `custom-view` capability) and `classExtender` (class URLs, `server-extension` only).
- `capabilities`: `storage`, `full-drive-access`, `extended-fuel`, `extended-memory`, `custom-view`, each either as a name or as `{name, reason}`. The reason is shown at review. Network access is not a capability: declare destinations instead.
- `secrets`, `operations`, `actions`: as in schema version 1. Secrets name an exact origin a credential may be sent to; operations are exact endpoints with an `effect` of `read` or `write`; actions reference operations.
- `network.origins`: exact origins (no wildcards, paths or ports beyond the origin) for packages that call the host `fetch` without an operation id. It never widens what `operations` grant.
- `configSchema`, `defaultConfig`: objects, as in `plugin.json`.
- `name`, `namespace`, `version`, `description`, `author`: metadata. `name` and `namespace` must be safe path segments.

A schema version 1 manifest is still accepted and is read as version 2 with `runtime: atomic-js/1`, `world: extension` and `entrypoints: { run: true }`.
Its stored form does not change.
The server-side validator is `server/src/plugins/manifest.rs`, the browser mirror is `@tomic/lib`'s `validateManifest`, and both are checked against the fixtures in `testdata/plugin-manifest/`.

## Manifest v3: public endpoints

Version 3 is version 2 plus an optional `http` block: endpoints the plugin asks the server to open to the internet.
A v3 manifest without `http` is accepted everywhere v3 is understood; an `http` block in a v2 manifest is rejected.

```json
{
  "schemaVersion": 3,
  "http": {
    "mount": "installation-origin",
    "routes": [
      { "id": "actor", "path": "/users/{name}", "methods": ["GET", "HEAD"] },
      { "id": "inbox", "path": "/users/{name}/inbox", "methods": ["POST"], "auth": "http-signature",
        "body": "json", "writes": ["inbox-items"], "enqueues": ["deliver"] }
    ],
    "wellKnown": [{ "name": "webfinger", "kind": "shared", "match": { "resourcePrefix": "acct:" }, "route": "actor" }],
    "writeTargets": [{ "id": "inbox-items", "parent": "config:inboxTable", "classes": ["https://example.com/classes/Activity"] }],
    "keys": [{ "name": "actor-key", "alg": "rsa-sha256", "reason": "Signs deliveries" }],
    "tokens": [{ "name": "storage" }],
    "reason": "Lets other fediverse servers follow this drive's actor."
  },
  "operations": [{ "id": "deliver", "method": "POST", "url": "https://*/inbox", "effect": "write" }]
}
```

- `mount`: `installation-origin` (default), `drive-host` or `drive-prefix`.
- `routes`: at most 32. `path` is literal segments, whole-segment `{param}`s and a trailing `{*rest}` (one or more segments); no regex. Routes that share a method may not overlap. `methods` from `GET HEAD POST PUT PATCH DELETE`. `principal` is `anonymous` (default), `installation` or `caller`; `caller` needs `auth: atomic`, and on `drive-prefix` only `anonymous` is allowed unless `auth` is `atomic`. `auth` is `none` (default), `atomic`, `http-signature`, `bearer` (needs `tokens`) or `dpop`. `writes` name `writeTargets`, `enqueues` name declared write operations. `maxBodyBytes` is at most 1 MiB for inline bodies, `timeoutMs` at most 30000.
- `wellKnown`: `webfinger` is shared and needs `match.resourcePrefix`; `nodeinfo`, `ocm`, `atproto-did`, `solid`, `oauth-authorization-server`, `oauth-protected-resource`, `openid-configuration` and `did.json` are exclusive. Nothing else can be claimed.
- `listeners` (`world: server-extension` only) and `sidecars` name what the operator configures in `ATOMIC_PLUGIN_LISTENERS` and `ATOMIC_PLUGIN_SIDECARS`.
- An operation with a wildcard host (`https://*/...`) must be listed in some route's `enqueues`.

The server derives what a release needs from these declarations; the author never writes it.
Anonymous `GET`/`HEAD` routes and well-known claims need `--plugin-routes read-only`; any other route, write target, key, token, delivery, listener or sidecar needs `read-write`.
`GET /plugin-catalog` gives each entry a derived `requires` list, such as `["persistent-host", "plugin-routes:read-only", "public-origin", "wasm-sandbox"]`.
Installing, upgrading or pinning a release that needs more than the server allows is refused with a message that names the endpoints and the switch to turn on (`/plugin-release-pin` answers `409` with the typed `host-feature-unavailable` problem) (see [Plugin public endpoints](../atomicserver/installation.md#plugin-public-endpoints-opt-in)). A refused upgrade leaves the old release running.

## The Plugin Manifest (legacy `plugin.json`)

`plugin.json` is the legacy form for WASM packages.
It keeps working: at import the server translates it into a version 2 manifest with `runtime: wasip2/1`, `permissions` mapped to `capabilities` (reasons kept), `network.origins` copied over, and `configSchema`/`defaultConfig`/metadata carried across.
A package whose component extends one or more classes becomes a `server-extension` with those classes in `entrypoints.classExtender`; a package extending none becomes an `extension` exporting `run`.
Declaring the `network` permission without any `network.origins` is rejected, since a destination nobody named cannot be reviewed.

A plugin manifest is a JSON file that describes the plugin.
It is located in the root of the plugin directory and is named `plugin.json`.
It contains the following properties:

### name

``string``
The name of the plugin.

### namespace

``string``
The namespace of the plugin.

### description

``sting``
The markdown description of the plugin. This is shown to the user when the plugin is installed.

### author

``string``
The author of the plugin.

### version

``string``
The version of the plugin.

### permissions

```ts
Array<{
  permission: "network" | "storage" | "full-drive-access" | "extended-fuel" | "extended-memory" | "custom-view";
  reason: string;
}>
```

A list of permissions the plugin requires, translated to `capabilities` (and, for `network`, to `network.origins`) at publish.
You also need to specify a reason for each permission so the user can understand why the plugin needs it.

### defaultConfig

```ts
Record<string, any>;
```

The default configuration of the plugin. The user can edit the config once the plugin is installed.

### configSchema

```ts
JSONSchema7;
```

The [JSON Schema](https://json-schema.org/) of the plugin's config. This helps the user understand the config and gives them feedback when the config is invalid.
