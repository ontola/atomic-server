# @tomic/mcp

An [MCP](https://modelcontextprotocol.io) server that lets an LLM client
(Claude Code, Claude Desktop, Cursor, ...) read and edit your Atomic Data.

It runs on your own machine with its own key, made there the first time it
runs. You decide in the app what that key may reach and whether it may edit,
and you can revoke it at any time. Your own secret is never involved, and every
edit it makes is a signed commit by that key, so you can see what it did.

## Setup

1. Connect this machine. It prints a link and opens it in your browser; pick
   the drives to share, choose read only or read and edit, and click
   **Allow**.

   ```sh
   ATOMIC_SERVER_URL=https://atomicdata.dev npx -y @tomic/mcp connect
   ```

2. Add it to your client.

   Claude Code:

   ```sh
   claude mcp add atomic -e ATOMIC_SERVER_URL=https://atomicdata.dev -- npx -y @tomic/mcp
   ```

   Claude Desktop, Cursor and others (`mcpServers` in their config file):

   ```json
   {
     "mcpServers": {
       "atomic": {
         "command": "npx",
         "args": ["-y", "@tomic/mcp"],
         "env": { "ATOMIC_SERVER_URL": "https://atomicdata.dev" }
       }
     }
   }
   ```

If you skip step 1, the tools answer with the link instead, so the assistant
can hand it to you.

To see or revoke what you connected, open your account settings in the app
(`/app/agent`), under **Connected apps**. Revoking removes the key from every
resource it could reach, including the ones it created.

The key is stored in `~/.config/atomic-mcp/<server>.json` (or under
`$XDG_CONFIG_HOME`). Delete that file to start over with a new key.

### Environment variables

| Variable              | Required | Meaning                                                                                                          |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `ATOMIC_SERVER_URL`   | yes      | The server your drives live on.                                                                                  |
| `ATOMIC_APP_URL`      | no       | Where the app runs, for the approval link. Defaults to `ATOMIC_SERVER_URL`.                                      |
| `ATOMIC_CLIENT_NAME`  | no       | The name you see in the app. Defaults to `AI assistant on <hostname>`.                                           |
| `ATOMIC_DRIVE`        | no       | The drive tools default to, out of the ones you shared.                                                          |
| `ATOMIC_READ_ONLY`    | no       | `true` registers only the read tools.                                                                            |
| `ATOMIC_AGENT_SECRET` | no       | For scripts and CI: sign as this Agent instead of a connected key. Anyone with the secret can act as that Agent. |

## Tools

| Tool               | What it does                                                                   |
| ------------------ | ------------------------------------------------------------------------------ |
| `list_drives`      | Your drives, and which one is the default.                                     |
| `get_resource`     | Reads resources as compact JSON-AD; documents and meetings include their text. |
| `search`           | Full-text search.                                                              |
| `semantic_search`  | Search by meaning (needs a server with embeddings).                            |
| `query`            | Finds resources by property values, e.g. all tasks with status "done".         |
| `get_user_classes` | The custom classes on the drive.                                               |
| `get_schema`       | The properties of a class.                                                     |
| `create_resource`  | Creates one or many resources.                                                 |
| `edit_resource`    | Sets one property.                                                             |
| `delete_resource`  | Deletes a resource (never a whole drive).                                      |

These are the same verbs the in-app assistant uses; both call the
implementations in `@tomic/lib` (`assistant-tools.ts`). Results use
JSON-AD-Compact (property shortnames, `#ref` short subjects), see
`planning/json-ad-compact.md`.

Not yet: editing a document's text, and a hosted (remote) MCP endpoint that
claude.ai can connect to without a local process. See
`planning/mcp-endpoint.md`.
