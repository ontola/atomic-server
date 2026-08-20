# Ecosystem Integrations

**Status:** Exploration (2026-08-20). Nothing built. Companion to
[`importers.md`](./importers.md) (pull),
[`personal-information-suite.md`](./personal-information-suite.md) (connectors),
[`virtual-drive.md`](./virtual-drive.md) (filesystem surface),
[`actions.md`](./actions.md) / [`SDK-API-design.md`](./SDK-API-design.md) (MCP / DX),
[`nextgraph-interop.md`](./nextgraph-interop.md) (peer graph),
[`atomic-lib-runtime.md`](./atomic-lib-runtime.md) (where the event bus lives).

GitHub: inbound webhooks
[#976](https://github.com/ontola/atomic-server/issues/976);
outbound notifications
[#77](https://github.com/ontola/atomic-server/issues/77).

## Goal

Pick *where* Atomic should meet other software, *what shape* those meetings
take, and *which primitives we don't have yet*. The instinct (IFTTT, n8n,
Notion, Obsidian) is real, but those four names hide four different jobs.
Building a Notion two-way sync and an n8n node as separate products is how
this turns into an infinite connector graveyard.

The claim: **one JSON event + two HTTP adapters unblocks most of the list.**
Webhooks are that adapter. The event is the thing we are actually missing.

## Four jobs, not four apps

Every "should we integrate with X?" question is one of:

| Job | Direction | What the other system does | Atomic primitive |
| --- | --- | --- | --- |
| **Ingress** | in | Creates or updates our resources | Inbound webhook, `/import`, MCP tool, importer |
| **Egress** | out | Learns that something changed here | Outbound webhook, SSE, JSON feed, MCP notification |
| **Mirror** | both | Stays in sync with identity mapping | Connector (cursors, `externalId`, conflict policy) |
| **Surface** | sideways | Shows our data in *their* UI, or theirs in ours | VFS, custom view, MCP resources, content-negotiated GET |

IFTTT / n8n are ingress+egress. Notion-the-export is ingress. Notion-live is
a mirror, and a bad one. Obsidian is a surface (files). Mixing these up is
why "integrate with Notion" can mean a weekend or a year.

Do **not** build a workflow engine. n8n / Make / Zapier already are that
engine. Atomic should be a first-class *node* in those graphs: accept a POST,
emit a POST. Our differentiator is the resource graph, signed history, and
local-first sync — not another if-this-then-that.

## What we already have

Enough to be a destination for *developers*, not for *other apps*:

- Content-negotiated HTTP GET (JSON, JSON-AD, JSON-LD, Turtle). Headless CMS
  and static-site consumers already work this way.
- Signed Commits + binary WebSocket v2 (`docs/src/websockets.md`). Right
  protocol for Atomic clients (browser, Flutter, Iroh). Wrong protocol for
  Zapier: the `UPDATE` payload is Loro bytes.
- `POST /import` of JSON-AD. Needs an authenticated Agent. n8n cannot sign a
  Loro commit.
- Plugin `after-commit` + the example Discord POST in
  `plugin-examples/random-folder-extender`. Proves the hook point; does not
  give retries, signatures, filters, or a UI.
- Desktop virtual drive (`planning/virtual-drive.md`). Finder/Explorer is
  already an integration surface.
- Atomic Assistant as an **MCP client** (it *calls* other servers). There is
  no Atomic **MCP server** yet (`planning/actions.md`).
- Query subscriptions (`SUBSCRIBE_QUERY`) that fan out the same Loro
  `UPDATE` / `DESTROY` frames. The *filter* is reusable; the *payload* is not.

The Endpoint POST machinery (`lib/src/endpoints.rs`, `Db::post_resource`)
already exists. Search/vector handlers even error with "not through
webhooks" — a fossil of this idea. `/import` is the closest shipped cousin
of #976, minus the "no Agent" part.

## The missing abstractions

WebSockets are not the gap. We have a very good WebSocket. What we do not
have is a **JSON change event** that anything besides an Atomic client can
consume, and a **write path that does not require Ed25519 + Loro**.

### 1. Resource Event (the actual missing type)

A JSON description of "this resource changed", independent of transport:

```json
{
  "type": "created",
  "subject": "did:ad:…",
  "class": "https://atomicdata.dev/classes/Article",
  "parent": "did:ad:…",
  "drive": "did:ad:…",
  "commit": "did:ad:commit:…",
  "createdAt": 1775504552928,
  "changed": ["https://atomicdata.dev/properties/name"],
  "resource": { "@id": "did:ad:…", "@class": "article", "name": "Hello" }
}
```

`type` is `created` | `updated` | `destroyed`. `resource` is compact JSON-AD
([`json-ad-compact.md`](./json-ad-compact.md)) by default; full JSON-AD is
an `Accept` / config escape hatch. Never Loro bytes, never a commit
signature. This is a *notification*, not a write certificate. The commit
subject is included so a first-party client can fetch proof if it cares.

Every egress channel serializes this same object:

- outbound webhook body
- SSE `data:` line
- JSON WebSocket `/events` frame (optional, see below)
- MCP `notifications/resources/updated`
- plugin `after-commit` context (today: raw commit JSON-AD + snapshot)
- later: MQTT topic, ActivityPub Create, etc.

Until this type exists, every integration reinvents a worse one.

### 2. Filter triggers, not a second query language

"When a Task in this folder becomes `Done`" is `SUBSCRIBE_QUERY` with a
property/value/drive (and, soon, parent/class). Outbound webhooks should
register the same `QueryFilter` CommitMonitor already understands
([`unify-subscription-primitives.md`](./unify-subscription-primitives.md)).
Do not invent Zapier-style "watch this URL" as a parallel system.

### 3. Integration write path (ingress without a user Agent)

#976 is exactly this: `POST` JSON at a scoped URL, get a resource under a
parent, no Ed25519 in the caller. Internally the node still creates a signed
Commit — the webhook has an **integration agent** (same shape as a plugin
agent) whose write rights were copied from the creator onto that parent at
inbox-creation time.

This is also the write path for:

- MCP `create_resource` from Claude Desktop
- a future `POST /resources` with a paste-a-token
- Apple Shortcuts, GitHub Actions, Stripe

One primitive, several facades. `/import` stays for bulk JSON-AD from an
already-authenticated Agent.

### 4. Delivery / jobs

Outbound HTTP needs: enqueue on commit, HMAC sign, retry with backoff,
dead-letter, delivery log. We have a client outbox for *our* commits, not a
node-side job queue for *foreign* HTTP. The same runner is what
[`personal-information-suite.md`](./personal-information-suite.md) needs for
Gmail/Calendar polling. Webhooks are the forcing function to put jobs in
`atomic_lib` ([`atomic-lib-runtime.md`](./atomic-lib-runtime.md)), not under
an Actix handler.

### 5. External identity

`externalId` + `externalSource` on imported/ingressed resources, as already
specified in [`importers.md`](./importers.md). Without this, every Stripe
event and every Notion re-export duplicates. Promote it to a core property,
not an importer-only convention. Ingress webhooks that receive a stable
foreign id (Airtable record id, Stripe `evt_…` is the *event* — use the
object id) must be idempotent on `(inbox, externalId)`.

### 6. Mapping, as a pure function

Foreign JSON is not JSON-AD. Typeform field ids, Slack block kits, and
GitHub issue payloads all need a transform. Same split as importers:
**host owns HTTP and secrets; a pure function maps records → compact
JSON-AD** (inbound) or Resource Event → foreign body (outbound templates).

v1 can be dumb and still useful:

- inbound: body *is* compact JSON-AD, or a JSON object whose keys match the
  target class shortnames
- outbound: default Resource Event body, plus a handful of first-party
  templates (`discord`, `slack`, `netlify-build-hook` which is an empty POST)

Custom JS mapping is the importer runtime, later.

### 7. Always-on HTTP node

Ingress webhooks require a **reachable URL**. Browser OPFS cannot receive
Stripe. A sleeping laptop cannot receive Calendly. This is a product
boundary, not a bug:

| Runtime | Ingress webhook | Egress webhook |
| --- | --- | --- |
| Hosted / self-hosted `atomic-server` | yes | yes |
| Desktop Tauri with the node running | only with a tunnel / port-forward | yes, while awake |
| Browser / WASM only | no | maybe (`fetch`), flaky |

Integrations are a **server/node** feature. Local-first sync still applies
to the data; the HTTP adapter is what other ecosystems speak. Do not design
IFTTT support that only works in a service worker.

### 8. MCP server (different ecosystem, same primitives)

Claude Desktop, Cursor, ChatGPT Apps, Continue.dev want tools and resources,
not webhooks. The tools should be projections of the actions registry
([`actions.md`](./actions.md)) plus compact create/update/query. That is
egress+ingress in MCP clothing. It is **not** a substitute for webhooks —
n8n will not speak MCP for years, and Stripe never will.

### 9. Content-type adapters at the edge

GET already negotiates JSON vs Turtle. The missing half is **PUT/GET of
domain formats** on a collection:

- `text/markdown` ↔ Document
- `text/calendar` ↔ CalendarEvent list (an `.ics` URL is 80% of "calendar
  interop" without implementing CalDAV)
- `text/vcard` ↔ Person
- `text/csv` ↔ Table

Obsidian, Apple Calendar, and "export this table" all fall out of this.
The virtual drive is the same adapter for `application/octet-stream`.

### WebSockets, specifically

Keep `atomicdata-ws.v2` for Atomic clients. Do not teach n8n Loro, AUTH
JSON-AD, or binary frames.

If we add a live channel for *other* software, it should be a **JSON event
stream of Resource Events**, not a third sync protocol:

1. **SSE** (`GET /events?filter=…`, `text/event-stream`) — curl-able, works
   in n8n HTTP Request, no new handshake. Best first live channel.
2. Optional JSON WebSocket at `/events` (text frames, Resource Event
   objects) for runtimes that already have WS but cannot do binary v2.
3. Nothing else. No MQTT until someone asks with a use case. No second CRDT.

The binary protocol stays the peer protocol
([`unified-sync.md`](./unified-sync.md)). JSON events are a *view* of
commits, like search is a view of resources.

## App catalog

Grouped by job. "Priority" is about whether we should spend first-party
effort, not whether the app is famous.

### Automation hubs — do first, via webhooks

These products exist so we do not have to write per-app code.

| App | Why it matters | Shape |
| --- | --- | --- |
| **n8n** | Self-hosted, same crowd as self-hosted Atomic. The actual IFTTT successor. | Official node later; webhooks day one |
| **Make, Zapier, IFTTT, Pipedream, Activepieces** | Long tail of SaaS triggers/actions | Inbound URL + outbound Standard Webhooks |
| **Huginn, Node-RED** | Power-user / IoT automation | Same HTTP |
| **GitHub Actions, GitLab CI** | `curl` to an inbox; outbound to `repository_dispatch` | Webhooks |

A first-party **n8n node** is marketing on top of the HTTP contract, not a
different integration. Ship HTTP, then the node.

### Chat and "something happened" — egress templates

| App | Shape |
| --- | --- |
| Discord, Slack, Mattermost, Telegram, Matrix | Outbound webhook + payload template. Discord is the existing plugin demo. |
| ntfy, Gotify, Pushover | Outbound; trivial POST |
| Email | SMTP connector ([`personal-information-suite.md`](./personal-information-suite.md)), not a webhook |

#77's Netlify rebuild is this category too: empty POST on `Article`
commit. Same destination object, boring template.

### Forms, payments, CRM — ingress

#976's motivating example (Airtable form → Person) lives here.

| App | Shape |
| --- | --- |
| Typeform, Tally, Fillout, Google Forms | Their outbound webhook → our inbox; mapping from field ids to class shortnames |
| Airtable, Coda | Outbound automation / script → inbox. Do not mirror bases. |
| Stripe, Polar, Lemon Squeezy | Signed inbound webhook; `externalId` = object id; class `Payment` / `Customer` |
| Calendly, Cal.com | Ingress → `CalendarEvent` + `Person` |
| HubSpot, Attio, Pipedrive | Only via n8n unless a customer pays for a connector |

### Knowledge tools — importer and filesystem, not live sync

| App | Do | Don't |
| --- | --- | --- |
| **Notion** | Export-zip importer (already the M3 forcing function in [`importers.md`](./importers.md)). Optional: Notion's own webhook → inbox for "page created". | Two-way API sync. We become a Notion client with a worse schema. |
| **Obsidian, Logseq, Foam, iA Writer** | Markdown round-trip on the virtual drive. Folder of `.md` files *is* the integration. | Obsidian plugin that reimplements sync. |
| Capacities, Tana, Anytype, Craft | One-shot export importers if formats exist | Live CRDT bridges |
| Roam, Workflowy | JSON/OPML importer | — |
| Google Docs / Word | Files as blobs + Atomizer later; not resources | |

Obsidian users who want Atomic's graph and Obsidian's editor should mount
the drive, not wait for an API. That only works if Documents serialize to
readable Markdown on disk (today VFS is blob-oriented; this is a real gap
in the Obsidian story — see "Markdown as a file" under Build order).

### Devtools and docs

| App | Shape |
| --- | --- |
| GitHub / GitLab issues | Their webhook → `Task`; outbound comment via n8n if needed |
| Linear, Jira | n8n; not first-party |
| Netlify, Vercel, Cloudflare Pages | Outbound build hook (#77) |
| VS Code, Zed | MCP server + VFS |
| Astro / Docusaurus | Already: GET JSON-AD. Keep. |
| Raycast | Extension exists (search). Add "create resource" against inbox or local node. |

### Personal information — connectors, not webhooks

Google, Microsoft, Fastmail, iCloud: OAuth, cursors, two-way eventually.
Specified in [`personal-information-suite.md`](./personal-information-suite.md).
Webhooks help (Gmail push notifications *into* our job runner) but are not
the product.

CalDAV/CardDAV **as a server** (Apple Calendar talking to Atomic) is a
protocol implementation, expensive. An `text/calendar` feed URL per calendar
resource is the 20% version.

### AI — MCP server

| App | Shape |
| --- | --- |
| Claude Desktop, Cursor, ChatGPT, Continue, Windsurf, Open WebUI | Atomic as MCP server: tools from the actions registry, resources as compact JSON-AD |
| Ollama / OpenRouter | Already consumed by the assistant; unrelated to graph interop |

We currently sit on the wrong side of this: the assistant *uses* MCP, other
agents cannot *use Atomic*.

### Social and open protocols — later, as peers

| Protocol | Relation |
| --- | --- |
| NextGraph (`did:ng:`) | Already a plan: Store backend, not webhooks |
| Solid | Similar to NextGraph; don't start a second peer until one works |
| ActivityPub / AT Protocol | Social apps ([`social-apps.md`](./social-apps.md)); Resource Event → Create/Update activities is conceivable after the event type exists |
| RSS / Atom / JSON Feed | Egress of a Collection as a feed. Cheap, #77-adjacent ("feeds"), good for blogs |
| WebMention | CMS nicety once websites are a product |

### Unexpected, still real

| App | Why it is not a joke |
| --- | --- |
| **Home Assistant** | Overlap with self-hosted/local-first users. HA automations POST to an inbox ("motion in office → Atomic log"); Atomic due-dates POST back to HA. MQTT can wait. |
| **Apple Shortcuts / Android Tasker / Share Sheet** | The mobile ingress story that is not "build a native SDK". HTTP POST of JSON or text. Browser extension ([`atomic-assistant-browser-extension.md`](./atomic-assistant-browser-extension.md)) is the desktop analogue. |
| **Readwise, Pocket, browser bookmarks HTML** | Importer + optional inbound webhook |
| **Remarkable / e-ink / any folder-sync** | VFS. Same as Obsidian. |
| **iCal subscription URL** | One content-type adapter; unlocks every calendar app as a *reader* |
| **LLM agent traces** | Commits already are an audit log. An inbox that accepts "tool X did Y" from an agent runtime is a cheap observability store with sharing and search. |
| **MQTT / NATS** | Same Resource Event, different carrier. Only after HTTP delivery is boring. |
| **Airtable / Sheets as a *source*** | Covered under forms; listing it here because people will ask "can I use Atomic as a better Airtable backend" — yes, via n8n, not a Sheets add-on. |

### Explicit non-goals

- Password managers, wallets, health-kit: wrong trust model.
- Figma / Miro / CAD: binary canvases, closed APIs, no shared ontology win.
- Reimplementing Notion's API or n8n's workflow UI inside Atomic.
- Per-SaaS two-way sync as the default answer. If n8n can do it, n8n should.

## Where we should actually integrate

Order is leverage per unit of Atomic-owned code, not user-request volume.

1. **Inbound + outbound webhooks** (#976, #77), on a Resource Event, with
   Standard Webhooks on the way out. Unblocks automation hubs, forms,
   payments, chat, CI rebuilds, Shortcuts, Home Assistant — without an
   official connector for any of them.
2. **SSE of Resource Events.** Live channel for tools that can stream HTTP
   but cannot speak v2.
3. **MCP server.** Same compact write/read as the inbox, different facade.
   Unlocks the AI editor ecosystem.
4. **Notion export importer + Markdown-on-VFS.** The two knowledge-tool
   answers, already partly planned. Not live Notion.
5. **n8n node + Discord/Slack/Netlify templates.** Thin, once (1) exists.
6. **Google/Microsoft connectors.** Product work; depends on jobs + secrets
   that (1) also needs.
7. **Peer protocols** (NextGraph first). Different bet: shared graph, not
   HTTP events.

The mistake is starting at (4) or (6) because the apps are more viscerally
"Atomic-like". Those users already have to *leave* something. Automation
users just need a URL.

## What a webhook should look like

#976 and #77 are one product with two classes. Do not hang a `webhooks`
array on Collection (#77's naive sketch): not secret, not filtered, not
retryable, not an Agent.

### `WebhookInbox` (#976)

Properties:

- `parent` — where created resources land
- `class` — default `isA` (e.g. Person, Article, Task)
- `secret` — unguessable; shown once. Rotation issues a new URL.
- optional `mapping` — later; v1 accepts compact JSON-AD or shortname-keyed JSON
- `agent` — dedicated integration agent with write on `parent`
- `enabled`, rate limit

URL: `POST /inbox/{id}/{secret}` (secret in the path because IFTTT/Zapier
often cannot set headers; also accept `X-Atomic-Token` / Bearer for n8n).

Behavior:

1. Authenticate by secret. No user Agent on the request.
2. Parse JSON. Resolve compact keys against `class`.
3. Set `parent`, `isA`, `externalId` if present.
4. Sign a genesis (or update-by-externalId) Commit as the inbox agent.
5. `201` + compact representation of the created resource.

Rights: checked when the inbox is created (creator can write `parent`) and
enforced by the inbox agent thereafter. Deleting the inbox revokes the
agent. "No token whatsoever" in #976 is the *caller* experience (they paste
a URL); the URL *is* the token. An open POST with no secret is drive spam.

This is *not* `/import`. `/import` is bulk JSON-AD from an Agent. The inbox
is one-resource-per-POST from the internet.

### `WebhookDestination` (#77)

Properties:

- `url`
- `secret` — HMAC key, Standard Webhooks
  ([standardwebhooks.com](https://www.standardwebhooks.com/))
- `filter` — drive + optional class / parent / property+value (the
  `SUBSCRIBE_QUERY` shape)
- `template` — `resource-event` (default) | `discord` | `slack` | `empty`
- `enabled`

On matching commit: enqueue a job. Worker POSTs with
`webhook-id`, `webhook-timestamp`, `webhook-signature`. Retry 2xx only;
backoff; surface failures on the destination resource.

Standard Webhooks does **not** make Discord/Slack just work — those want a
custom JSON shape. Templates are adapters over the same job. A Netlify
build hook is `template: empty`.

SSRF: block private/link-local/metadata IPs unless the node config opts
into "allow LAN webhooks" (Home Assistant on `192.168.x` is a real case).

### Shared runtime

CommitMonitor already fans out after apply. That is the emission point:

```text
commit applied
  → WS UPDATE (Loro, existing)
  → query membership UPDATE (existing)
  → Resource Event
       → webhook destinations (new)
       → SSE subscribers (new)
       → (later) MCP notifications
```

Plugins should stop POSTing HTTP themselves for this use case. `after-commit`
remains for *compute* (derived properties, validation); **delivery** is a
node job.

### Local-first caveat

Destinations fire on the node that applied the commit. With multiple paired
nodes, pick one **delivery owner** (the hosted server if any; otherwise the
node that has the destination resource and is online). Duplicate POSTs are
worse than a missed one while the laptop lid is shut — Standard Webhooks
idempotency keys (`webhook-id` = commit subject) let receivers ignore
duplicates if we ever dual-fire.

## How this relates to existing plans

| Plan | Relation |
| --- | --- |
| [`importers.md`](./importers.md) | Pull / one-shot. Webhooks are push / continuous. Same `externalId`, same mapping-as-pure-function, same "host owns secrets". |
| [`personal-information-suite.md`](./personal-information-suite.md) | Needs the job runner and secret store webhooks force us to build. |
| [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) | Event bus + jobs belong in `atomic_lib`, HTTP is an adapter. |
| [`json-ad-compact.md`](./json-ad-compact.md) | Wire dialect for inbox bodies and event `resource`. Remaining server `format=compact` becomes load-bearing. |
| [`actions.md`](./actions.md) | MCP server is a projection of the same verbs. |
| [`virtual-drive.md`](./virtual-drive.md) | The Obsidian/VS Code/Remarkable integration. Markdown serialization is the missing piece. |
| [`nextgraph-interop.md`](./nextgraph-interop.md) | Peer, not webhook. Do not wait on it for n8n. |
| [`llm-wasm-gui-plugins.md`](./llm-wasm-gui-plugins.md) | Custom integrations that need logic stay plugins. 80% should not require WASM. |
| [`habits-app.md`](./habits-app.md) | Watch app + Shortcuts hitting an inbox is the external-developer test. |

## Build order

Each step is independently shippable and useful.

1. **Specify Resource Event** (this doc + a JSON Schema in `docs/`). No
   runtime yet. Compact `resource` payload; server `format=compact` from
   [`json-ad-compact.md`](./json-ad-compact.md) slice 4.
2. **`WebhookInbox`** (#976). Ontology, POST handler, integration agent,
   UI to copy the URL, rate limit, `externalId` upsert. Demo: Tally/n8n
   POST `{ "name": "Ada", "email": "a@b.c" }` → Person in a folder.
   Integration test in `server/tests/it/` with no browser.
3. **`WebhookDestination`** (#77). Filter = existing query subscription.
   Standard Webhooks signer. Delivery log. Templates: default event,
   `empty`, `discord`. Demo: edit an Article → Netlify build; create a
   Person → Discord channel. SSRF tests.
4. **Job runner extracted** so (3) is not an Actix one-off. Unblocks
   connector polling.
5. **SSE `/events`.** Same filter, same event object.
6. **MCP server** using inbox-equivalent writes + actions registry.
7. **Markdown files on VFS** for Documents, then Obsidian-as-mount works.
8. **n8n node + Notion zip importer** in parallel (node is small; importer
   is [`importers.md`](./importers.md) M3).

Do not start OAuth brokerage, CalDAV, or ActivityPub before 3 is boring.

## Decisions

- **Webhooks first**, not Notion/Obsidian plugins. HTTP events unlock more
  apps per line of code than any single pairwise integration.
- **Two classes** (`WebhookInbox`, `WebhookDestination`), not a `webhooks`
  array on Collection, and not "no secret".
- **Resource Event is the integration contract.** Binary WS stays the
  Atomic peer protocol. Third parties never see Loro.
- **We are a node in other people's workflows**, not a workflow product.
- **Inbox agent, not unsigned writes.** The internet never mutates the
  graph except through a signed Commit. The secret only authenticates the
  HTTP caller.
- **Standard Webhooks outbound.** Custom chat bodies are templates, not a
  reason to skip signatures and retries.
- **Integrations are a node/server capability.** Browser-only Atomic is
  not an IFTTT target.
