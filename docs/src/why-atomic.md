{{#title Overview: control over your data}}
# Overview

The web was meant to be a decentralized network that helps people share information, but today a handful of companies control where our data lives.
Their services are often free and work well together, but they are built to _lock you in_, and their revenue models (like selling your attention to advertisers) don't line up with what you want.
Atomic exists to give you control over your data again: it lives on your devices, it is yours to take elsewhere, and nobody needs to be trusted to hold it.
Read the full argument in the [motivation](motivation.md).

The pieces are layered.
Each layer works on the one below it, and you can swap what sits on top.

<div class="atomic-diagram">
<svg viewBox="0 0 360 340" width="100%" style="max-width:480px;height:auto;display:block;margin:1.5em auto" font-family="inherit" font-size="15" fill="currentColor" role="img" aria-labelledby="stack-t stack-d">
  <title id="stack-t">The Atomic stack</title>
  <desc id="stack-d">Three layers. At the bottom, Atomic Data, the open format. In the middle, Atomic Sync, with identity, permissions, CRDT merge and transports. On top, Atomic Apps, such as atomic.place and your own app.</desc>
  <g text-anchor="middle" stroke="none">
    <rect x="5" y="5" width="350" height="100" rx="12" fill="#BD99C0" fill-opacity=".45"/>
    <rect x="5" y="115" width="350" height="145" rx="12" fill="#99C0B7" fill-opacity=".5"/>
    <rect x="5" y="270" width="350" height="65" rx="12" fill="#B3B4E2" fill-opacity=".55"/>
    <text x="180" y="30" font-weight="600">Atomic Apps</text>
    <text x="180" y="145" font-weight="600">Atomic Sync</text>
    <text x="180" y="297" font-weight="600">Atomic Data</text>
    <text x="180" y="318" font-size="14" opacity=".85">the open format</text>
  </g>
  <g text-anchor="middle" font-size="14" stroke="currentColor" stroke-width="1.2" fill-opacity=".0">
    <rect x="25" y="48" width="150" height="40" rx="10" fill="none"/>
    <rect x="185" y="48" width="150" height="40" rx="10" fill="none"/>
    <rect x="25" y="162" width="150" height="40" rx="10" fill="none"/>
    <rect x="185" y="162" width="150" height="40" rx="10" fill="none"/>
    <rect x="25" y="210" width="150" height="40" rx="10" fill="none"/>
    <rect x="185" y="210" width="150" height="40" rx="10" fill="none"/>
  </g>
  <g text-anchor="middle" font-size="14" stroke="none">
    <text x="100" y="73">atomic.place</text><text x="260" y="73">Your app</text>
    <text x="100" y="187">Identity</text><text x="260" y="187">Permissions</text>
    <text x="100" y="235">CRDT merge</text><text x="260" y="235">Transports</text>
  </g>
</svg>
</div>

## Atomic Data: the open format

Atomic Data is how information is written down: resources, links between them, schemas, and signed commits.
It is the reason you can leave.
Every app and every node speaks the same data, so your data is not stuck in one product.
Read more in the [Atomic Data core](core/concepts.md) and the [Atomic Data overview](atomic-data-overview.md).

## Atomic Sync: your personal data store, synced

Atomic Sync keeps a copy of your data on each of your devices and keeps those copies in agreement.
Its strength is that it is _one package_: an identity that is a key you hold, permissions checked on every node, edits that merge without a coordinator (a Loro CRDT), and transports to move them (Iroh, WebRTC, WebSocket and HTTP).
It runs in `atomic_lib` (Rust, also behind Flutter) and in `@tomic/lib` (the browser, through WASM).
[AtomicServer](atomic-server.md) is one always-on node you can host yourself. It holds a copy and makes your data reachable, but it is not the centre and it owns nothing.
[Read more](atomic-sync/overview.md).

## Atomic Apps: apps on top

Atomic Apps are apps built on Atomic Sync.
[atomic.place](atomicserver/gui.md) is the example, and the app these docs describe: documents, tables, chat and an [all-in-one workspace](all-in-one-workspace.md) for your team.
You can build your own in JavaScript, Rust or Flutter, and it shares Drives with atomic.place.
[Read more](atomicserver/gui.md), or [start building](local-first-guide/1-index.md).

## Where to start

- **I want to use the app:** go to [atomic.place](https://atomic.place) and read [using the app](atomicserver/gui.md).
- **I want to build an app:** follow the [local-first guide](local-first-guide/1-index.md), then see [building on the sync engine](atomic-sync/building-on-the-sync-engine.md) and the [clients and SDKs](tooling.md).
- **I want to self-host:** [install AtomicServer](atomicserver/installation.md).
- **I want to implement the spec:** start with the [Atomic Data overview](atomic-data-overview.md) and the [core concepts](core/concepts.md).

## Go deeper

- Why this matters: [motivation](motivation.md) and [local-first and data ownership](local-first.md).
- How it works: [how sync works](sync.md), [commits](commits/intro.md), [agents](agents.md) and [URLs and identifiers](urls.md).
- Whether it fits: [when (not) to use it](when-to-use.md) and the [roadmap](roadmap.md).
- It is open: the code is MIT licensed.
