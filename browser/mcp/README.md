# @tomic/mcp

An [MCP](https://modelcontextprotocol.io) server that lets an LLM client
(Claude Code, Claude Desktop, Cursor, ...) read and edit your Atomic Data.

It runs on your own machine and signs its edits with your Agent's key, so every
change is an ordinary signed commit, exactly as if you made it in the app. The
key never leaves your machine.

## Setup

1. In the app, open your account settings (`/app/agent`) and, under
   **Account recovery**, reveal and copy your agent secret.
2. Note the address of the server your drives live on (the origin of the app,
   e.g. `https://atomicdata.dev` or your own node).
3. Add the server to your client.

Claude Code:

```sh
claude mcp add atomic \
  -e ATOMIC_SERVER_URL=https://atomicdata.dev \
  -e ATOMIC_AGENT_SECRET=<your secret> \
  -- npx -y @tomic/mcp
```

Claude Desktop, Cursor and others (`mcpServers` in their config file):

```json
{
  "mcpServers": {
    "atomic": {
      "command": "npx",
      "args": ["-y", "@tomic/mcp"],
      "env": {
        "ATOMIC_SERVER_URL": "https://atomicdata.dev",
        "ATOMIC_AGENT_SECRET": "<your secret>"
      }
    }
  }
}
```

Treat the secret like a password: anyone who has it can act as you.

### Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `ATOMIC_SERVER_URL` | yes | The server your drives live on. |
| `ATOMIC_AGENT_SECRET` | for writes | Your Agent secret. Without it, only public data can be read. |
| `ATOMIC_DRIVE` | no | The drive tools default to. Defaults to the drive in your secret. |
| `ATOMIC_READ_ONLY` | no | `true` registers only the read tools. |

## Tools

| Tool | What it does |
| --- | --- |
| `list_drives` | Your drives, and which one is the default. |
| `get_resource` | Reads resources as compact JSON-AD; documents and meetings include their text. |
| `search` | Full-text search. |
| `semantic_search` | Search by meaning (needs a server with embeddings). |
| `query` | Finds resources by property values, e.g. all tasks with status "done". |
| `get_user_classes` | The custom classes on the drive. |
| `get_schema` | The properties of a class. |
| `create_resource` | Creates one or many resources. |
| `edit_resource` | Sets one property. |
| `delete_resource` | Deletes a resource (never a whole drive). |

These are the same verbs the in-app assistant uses; both call the
implementations in `@tomic/lib` (`assistant-tools.ts`). Results use
JSON-AD-Compact (property shortnames, `#ref` short subjects), see
`planning/json-ad-compact.md`.

Not yet: editing a document's text, and a hosted (remote) MCP endpoint that
claude.ai can connect to without a local process. See
`planning/mcp-endpoint.md`.
