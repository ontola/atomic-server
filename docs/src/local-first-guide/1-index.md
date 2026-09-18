{{#title Build a local-first app with @tomic/lib}}
# Build a local-first app with `@tomic/lib`

This guide walks through an app that works with no server at all, and then grows: first it persists across reloads, then it syncs to an always-on device, then it reaches a phone.
Every step is a small change to the same code.
It uses `@tomic/lib` directly, so what you learn applies to React, Svelte, Astro or plain TypeScript.

The app is a reading list: a Drive that holds Book resources with a title and a note.
It is deliberately tiny; the interesting part is where the data lives.

## What you will end up with

1. An identity that is a keypair, minted in the browser, with nothing registered anywhere.
2. A Drive and some Books, created and edited offline and signed by that identity.
3. Persistence across reloads, using the encrypted local database.
4. Sync to an always-on AtomicServer, so a second browser and a colleague can see the list.
5. The same Drive on a phone, paired directly.

## Prerequisites

- Node 20 or later and a package manager.
- A bundler that serves static files, such as Vite. The examples assume it.
- For step 4, an AtomicServer you can reach: `atomic-server` [installed locally](../atomicserver/installation.md) is enough.
- For step 5, the [Flutter reference app](../flutter.md) on a phone.

Install the library:

```sh
npm install @tomic/lib
```

## How this differs from the Astro guide

The [Astro guide](../astro-guide/1-index.md) starts from a server: you set one up, model data in its web app, and the site reads from it over HTTP.
That is still the right shape for a public website built at deploy time.
This guide starts from the device and treats the server as something you add later, which is the right shape for an app a person uses.

Next: [minting an identity](2-identity.md).
