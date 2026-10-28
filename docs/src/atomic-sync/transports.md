{{#title Atomic Sync transports: WebSocket, Iroh and WebRTC}}
# Transports

Every app is a node: the same sync engine runs in the browser (`@tomic/lib` with WASM) and in native apps (`atomic_lib`, also behind the Flutter app), and any app built on it can sync.
Your devices live in very different places.
A browser tab can't accept connections, a phone moves between networks, and a server sits at a fixed address.
No single way of connecting works for all of them, so Atomic Sync is one protocol that runs over several transports.
The transport only decides how two devices reach each other. The frames, the signature checks and the permission checks are the same on all of them.

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

| Transport | Connects | Address you need |
| --- | --- | --- |
| WebSocket | A client (browser, CLI, app) to an AtomicServer, which accepts these connections | The server's URL |
| Iroh (QUIC) | Two native nodes running `atomic_lib`, for example a phone and a laptop, or a phone and an AtomicServer | The other node's id, usually from a QR code |
| WebRTC | Browser tabs, up to eight (an implementation limit) | A peer link made on the Sync page |
| HTTP `POST /commit` | Any client to an AtomicServer | The server's URL |

## WebSocket

This is what the web app uses by default.
The client opens `/ws` on an AtomicServer. In this repository that is AtomicServer: `atomic_lib` and `@tomic/lib` include the WebSocket client, but only the server accepts WebSocket and HTTP connections. Iroh and WebRTC come with the engine, so any app on it can use them.
The client proves its Agent with an `AUTH` frame, reconciles each Drive and then subscribes to live updates.
It needs a node that stays reachable, but that node can be small and self-hosted. See [remote peers](remote-peers.md).
Details: [Wire protocol](../websockets.md#overview-and-transports).

## Iroh peer to peer

If you have two native devices, you shouldn't need a server to sync them.
[Iroh](https://iroh.computer) opens QUIC connections between devices, directly when it can and through a relay when it can't.
Every node has a persistent node id, written `atomic:node:<id>`. The older spelling `did:ad:node:<id>` is still accepted.
To pair two devices, one shows its node id as a QR code and the other scans it, then asks its own node to sync a Drive with that id.
An AtomicServer starts Iroh on boot and logs its node id (`Iroh transport ready ... Connect with: atomic:node:...`).
A person with write rights on a Drive can also make a server dial a node with `POST /iroh-sync`, with the body `{"nodeId": "...", "drive": "..."}`.

A node id says _where_ to connect. It does not grant any access. See [permissions and identity](permissions-and-identity.md).
A browser tab can't accept incoming connections, so it can't be dialed over Iroh.

Servers can also announce which Drives they hold through the pkarr relay network, so a client that only knows a Drive's identifier can find a node to dial. See [resolution](../identifiers.md#resolution).

## WebRTC between browsers

Two browser tabs on two machines can't reach each other on their own.
With WebRTC they can sync through an encrypted data channel, with no server holding the data.
A small signaling service introduces the tabs and never sees Drive data.
Some networks also need a TURN relay, and everyone must have the app open to exchange changes. See [browser peer sync](../browser-peer-sync.md).

A mesh transport over [Reticulum](https://reticulum.network/) is planned but not built.

## HTTP commits

A client can send a signed commit with `POST /commit`.
This is the fallback when no socket is open, and a simple way for scripts to write. It gives no live updates.

## Which one to use

| Situation | Use |
| --- | --- |
| A web app with a server you run | WebSocket, with local persistence in the browser |
| Phones or desktops that should sync without a server | Iroh, paired with a QR code |
| A mix of browsers and native apps | An always-on node such as AtomicServer that browsers reach over WebSocket. Browsers cannot speak Iroh. |
| Browsers sharing without any server, while all are open | WebRTC |
| A script or integration that writes data | HTTP `POST /commit` |

Most setups combine them: WebSocket to a server for reach and availability, Iroh for direct device-to-device sync.
Be honest with yourself about one limit, though.
None of the peer-to-peer transports keeps data available when every device that holds it is off. For that you need an always-on node.
The [design decisions page](../local-first-guide/7-design-decisions.md) covers these choices in more depth.
