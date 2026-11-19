# Authorization through integration-proxy

Drive apps connect to providers such as Notion through the host's integration
proxy API (`store.proxy`). The data browser starts the OAuth flow, redeems the
handoff with the signed-in user's agent and delegates the connection to the
app. [Atomic Plugins integration guide](https://github.com/ontola/atomic-plugins/blob/main/integrations/README.md)

OAuth client registration, token exchange and refresh belong to the proxy and
its composed OpenAPI metadata. The former AtomicServer-hosted Notion
authorization service and its `ATOMIC_NOTION_*` and `ATOMIC_OAUTH_*` settings
have been removed.

Manual-token installations keep their existing generic plugin secrets. Connect
again through the proxy to use a drive app. Existing tables and import baselines
stay with their original installation.
