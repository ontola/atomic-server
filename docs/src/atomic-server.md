{{#title AtomicServer: An open-source, realtime, headless CMS}}
# AtomicServer and its features

[`AtomicServer`](https://github.com/atomicdata-dev/atomic-server/blob/master/server/README.md) is the _reference implementation_ of the Atomic Data Core + Extended specification.
It was developed parallel to this specification, and it served as a testing ground for various ideas (some of which didn't work, and some of which ended up in the spec).

AtomicServer is a real-time headless CMS, graph database server for storing and sharing typed linked data.
It's free, open source (MIT license), and has a ton of features:

<!-- Copied from root README -->
- 🏠  **Local-first**: works offline in the browser, syncs when you reconnect.
- 🔄  **Real-time collaboration**: live cursors, typing indicators, and following what a teammate is doing.
- 📄  **Documents**: collaborative rich text, like Google Docs or Notion.
- 🗄️  **Tables**: strict schema, keyboard navigation, copy / paste. Like Airtable.
- 📋  **Kanban, calendar, dashboard and timer views** on any table.
- 🧰  **Templates**: issue tracker, CRM, project tasks, time tracker and more.
- 🌐  **Websites**: design pages in the browser, publish in one click, roll back any version.
- 🗂️  **Virtual drive**: mount your drive as a folder in Finder or Explorer (desktop app).
- ✨  **AI** with [MCP](https://modelcontextprotocol.io/) support, any model via OpenRouter or local Ollama.
- 🧩  **Apps**: custom screens in plain JavaScript, backed by your own data.
- 🔌  **Plugins and integrations**: Wasm plugins, and syncing from Notion, GitHub and more.
- 💬  **Group chat**: channels with attachments, search and replies.
- 🎥  **Meetings**: video calls with shared notes and presence.
- 🎨  **Canvas**: an infinite drawing surface, shared live.
- 📂  **Files**: upload, download and preview attachments.
- 🔧  **Custom data models**: your own classes and properties in the Ontology Editor, shared as [Atomic Schema](https://docs.atomicdata.dev/schema/intro.html).
- 🔒  **Encrypted at rest**: each agent's local database is encrypted under their own key.
- 💾  **Versioning**: full history, every write a signed [Atomic Commit](https://docs.atomicdata.dev/commits/intro.html).
- 🔎  **Full-text search**: typeahead and fuzzy, often under 3ms, same index on server and client.
- 🔐  **Authorization**: read / write rights, [hierarchies](https://docs.atomicdata.dev/hierarchy.html) and [invite links](https://docs.atomicdata.dev/invitations.html).
- ⚙️  **RESTful API** with [JSON-AD](https://docs.atomicdata.dev/core/json-ad.html), plus RDF, Turtle, N-Triples and JSON-LD.
- 📖  **Pagination, sorting and filtering** with [Atomic Collections](https://docs.atomicdata.dev/schema/collections.html).
- 🚀  **Fast**: under 1ms median response time, powered by actix-web and redb.
- 🪶  **One binary** (~70MB): server, web app, search, database and automatic HTTPS.
- 💻  **Runs everywhere**: linux, windows, mac, arm, plus desktop and mobile apps.
- 📚  **Libraries** for JavaScript, React, Svelte, Rust and Dart / Flutter.

## Document undo and redo

While editing a document, use **Cmd-Z** on macOS or **Ctrl-Z** on Windows/Linux
to undo your local edits. Use **Cmd-Shift-Z** or **Ctrl-Shift-Z** to redo.

Undo and redo history survives switching to Data View and returning to the
document within the same signed-in browser session. It is kept in memory;
reloading the page, signing out, or switching accounts starts a new undo history.
Collaborators' edits are not added to your local undo history.
