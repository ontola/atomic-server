{{#title Atomic Sync overview: every device holds a full copy}}
# Atomic Sync overview

Sync exists so that your data lives on _your_ devices, and you stay in control of it.
Most apps keep your data on one company's server, and the app on your phone is just a window onto it.
That makes it hard to leave, and it gives the company a reason to keep it that way: a business model built on holding your data hostage, or on selling your attention.
We argue in the [motivation](../motivation.md) that this is what vendor lock-in does, and [local-first](../local-first.md) is how we get out of it.

With Atomic Sync, every device that uses a [Drive](../identifiers.md#drive-identity) keeps a full local copy and reads and writes it directly.
You're not tied to one vendor's cloud, because a server is just one more device that holds a copy.
Sync runs in the background and passes changes between those copies, so they stay in agreement.

## The idea in five points

1. **Every device has a full local copy.** The app reads and writes the local store, so it keeps working offline. See [local-first](../local-first.md).
2. **Edits are signed commits.** A change becomes a [Commit](../commits/intro.md): a [Loro](https://loro.dev) CRDT update plus an Ed25519 signature from the [Agent](../agents.md) that made it. Anyone can check who changed what.
3. **Copies merge automatically.** Each Resource is a Loro document, so edits made at the same time on different devices merge without a coordinator. Merging does _not_ check your business rules, though. Your application decides when a merged result needs review.
4. **Every receiving node checks permissions.** A node verifies the signature and the signer's write right before it applies a change, and it only sends a peer what that peer's Agent may read. See [permissions and identity](permissions-and-identity.md).
5. **A server is just another peer.** An [AtomicServer](../atomic-server.md) runs the same sync engine as a phone or a browser tab. It's usually the one that stays online, but it doesn't own anything. See [remote peers](remote-peers.md).

## What happens to an edit

You change a Resource on your device, and the change lands in the local store at once.
It is signed, and put in an outbox.
When a peer is reachable, the device first compares what each side has, using [version vectors](drive-reconciliation.md), and then exchanges only what differs.
While the link stays open, later edits are pushed as they happen.
If you're offline, the outbox keeps your edits, even across a restart, and sends them when a peer comes back.

<div class="atomic-diagram">
<svg viewBox="0 0 360 300" width="100%" style="max-width:480px;height:auto;display:block;margin:1.5em auto" font-family="inherit" font-size="15" fill="currentColor" role="img" aria-labelledby="journey-t journey-d">
  <title id="journey-t">An edit's journey</title>
  <desc id="journey-d">On a phone, the edit "Rename task" is written to the local store, signed as a commit and queued in the outbox. The outbox sends it to a desktop app and to an always-on node, which each verify and merge it.</desc>
  <defs>
    <marker id="jarr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0L10 5L0 10z" fill="currentColor"/>
    </marker>
  </defs>
  <g text-anchor="middle" stroke="currentColor" stroke-width="1.5">
    <text x="10" y="20" text-anchor="start" stroke="none" font-weight="600">Phone: edit "Rename task"</text>
    <g stroke="none">
      <rect x="10" y="34" width="150" height="54" rx="12" fill="#B3B4E2" fill-opacity=".55"/>
      <rect x="10" y="114" width="150" height="54" rx="12" fill="#99C0B7" fill-opacity=".55"/>
      <rect x="10" y="194" width="150" height="54" rx="12" fill="#BD99C0" fill-opacity=".55"/>
      <rect x="210" y="150" width="140" height="64" rx="12" fill="#6B94A6" fill-opacity=".45"/>
      <rect x="210" y="226" width="140" height="64" rx="12" fill="#906CAF" fill-opacity=".4"/>
      <text x="85" y="57">1 Local store</text><text x="85" y="77" font-size="14" opacity=".8">saved at once</text>
      <text x="85" y="137">2 Signed commit</text><text x="85" y="157" font-size="14" opacity=".8">Ed25519 + Loro</text>
      <text x="85" y="217">3 Outbox</text><text x="85" y="237" font-size="14" opacity=".8">kept if offline</text>
      <text x="280" y="177">Desktop app</text><text x="280" y="197" font-size="14" opacity=".8">verified, merged</text>
      <text x="280" y="253">Always-on node</text><text x="280" y="273" font-size="14" opacity=".8">verified, merged</text>
    </g>
    <g fill="none" marker-end="url(#jarr)">
      <path d="M85 90V110"/><path d="M85 170V190"/>
      <path d="M162 214L206 190"/><path d="M162 228L206 256"/>
    </g>
  </g>
</svg>
</div>

[Atomic Sync](../sync.md) walks through this in more detail.

## Over any transport

Every app that runs the engine is a node, in the browser or native.
Nodes reach each other over WebSocket, HTTP, Iroh or WebRTC, whichever fits where they are.
The transport only decides how two devices find each other: the commits and the checks are the same on every link.

<div class="atomic-diagram">
<svg viewBox="0 0 420 380" width="100%" style="max-width:520px;height:auto;display:block;margin:1.5em auto" font-family="inherit" font-size="15" fill="currentColor" role="img" aria-labelledby="tr-t tr-d">
  <title id="tr-t">One protocol, four transports</title>
  <desc id="tr-d">Every app is a node running the same sync engine. An AtomicServer is reached by a web app over WebSocket and by a script over HTTP. A desktop app reaches it over Iroh and a phone app reaches the desktop app over Iroh. Two web apps connect over WebRTC.</desc>
  <g text-anchor="middle" stroke="currentColor" stroke-width="1.5">
    <g fill="none">
      <path d="M355 140V38H122"/><path d="M65 66V140"/>
      <path d="M200 140L100 66"/><path d="M210 190V270"/><path d="M65 190V270"/>
    </g>
    <g stroke="none">
      <rect x="10" y="10" width="110" height="56" rx="12" fill="#906CAF" fill-opacity=".4"/>
      <rect x="10" y="140" width="110" height="50" rx="12" fill="#B3B4E2" fill-opacity=".55"/>
      <rect x="10" y="270" width="110" height="50" rx="12" fill="#B3B4E2" fill-opacity=".55"/>
      <rect x="155" y="140" width="110" height="50" rx="12" fill="#99C0B7" fill-opacity=".55"/>
      <rect x="155" y="270" width="110" height="50" rx="12" fill="#BD99C0" fill-opacity=".55"/>
      <rect x="300" y="140" width="110" height="50" rx="12" fill="#6B94A6" fill-opacity=".45"/>
      <text x="65" y="34">AtomicServer</text><text x="65" y="54" font-size="14" opacity=".8">always on</text>
      <text x="65" y="170">Web app</text><text x="65" y="300">Web app</text>
      <text x="210" y="170">Desktop app</text><text x="210" y="300">Phone app</text>
      <text x="355" y="170">Script</text>
      <g font-weight="600" font-size="14">
        <text x="240" y="30">HTTP</text>
        <text x="73" y="122" text-anchor="start">WebSocket</text>
        <text x="160" y="95" text-anchor="start">Iroh</text>
        <text x="75" y="235" text-anchor="start">WebRTC</text>
        <text x="220" y="235" text-anchor="start">Iroh</text>
      </g>
      <text x="210" y="362" opacity=".8" font-size="14" font-style="italic">same engine, same commits, on every link</text>
    </g>
  </g>
</svg>
</div>

[Transports](transports.md) explains each one and when to use it.

## Where to read next

| If you want to | Read |
| --- | --- |
| Choose how devices connect | [Transports](transports.md) |
| Understand what two devices exchange | [Drive reconciliation](drive-reconciliation.md) |
| Know who may read and write during sync | [Permissions and identity](permissions-and-identity.md) |
| Keep a Drive available while your devices are off | [Remote peers](remote-peers.md) |
| Build an app on the engine | [Building on the sync engine](building-on-the-sync-engine.md) |
| Implement a client or peer | [Wire protocol](../websockets.md) |

The product-level pitch, and what you do not have to build yourself, is on [Local-first Sync Engine](../sync-engine.md).
