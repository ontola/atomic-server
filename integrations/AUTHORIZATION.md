# Authorization through integration-proxy

The former AtomicServer-hosted Notion authorization service has been removed.
New Notion connections use the shared browser integration-proxy flow described in
[LocalThought integrations](localthought/README.md) and [Notion](notion/README.md).
OAuth client registration, token exchange and refresh belong to the proxy and
its composed OpenAPI metadata. `ATOMIC_NOTION_*` and `ATOMIC_OAUTH_*` no longer
configure an AtomicServer authorization service.

Existing generic plugin secrets remain intact for manual-token installations.
They are not transferred into browser credentials. Reconnect through the proxy;
there is no automatic table or baseline migration.
