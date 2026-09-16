# Notion activation dependencies

The generic proxy implementation is merged in [integration-proxy PR #67](https://github.com/localthought/integration-proxy/pull/67), commit
`516079e5a3ecd254c748995b50570998e486e4fc`. CI passed, including database and network tests. Heroku release **v64** deployed this exact merge commit successfully; `/` and `/catalog` returned HTTP 200. It implements generic JSON OAuth operations and fixed OpenAPI header defaults with no provider-specific production branches. The proxy repository owns its regression fixture and code; no duplicate patch is kept here.

The supported OAuth operation subset uses local POST operation references, JSON
or form bodies and HTTP Basic client authentication. Unsupported profiles fail
closed. Header defaults come from `schema.default` or a singleton enum, never an
example. Notion calls retain the `/v1` base path through `/proxy/notion/v1/...`.

`notion.openapi.yaml` is an authored OpenAPI 3.0.3 subset of the API used by this
plugin, including search, data sources, pages, views and the token operation.
`auth-overlay.yaml` adds OAuth authorization-code metadata, owner=user, disabled
PKCE at the provider (the browser/proxy handoff still uses PKCE), Basic auth and
JSON token/refresh operation references. These are staging files, not public
catalog URLs or a production catalog entry.

Before enabling real connections:

1. Review and publish the API document in `localthought/openapi-directory` and
   the overlay in `localthought/overlays`.
2. Add a `notion` entry to the existing root `overlays/catalog.json`, using
   immutable public commit URLs and preserving all other entries.
3. Verify the merged proxy release is deployed and point its catalog at the
   reviewed catalog revision.
4. Register/configure the Notion OAuth app for
   `https://localthought.io/oauth/notion/callback`, using the proxy's
   `OAUTH_NOTION_CLIENT_ID` and `OAUTH_NOTION_CLIENT_SECRET` settings and Basic
   `OAUTH_NOTION_CLIENT_AUTH_METHOD=client_secret_basic` setting. Do not put credentials in this repository.
5. Verify real consent, discovery and two-way synchronization on a disposable
   database. The local tests use authored responses and do not certify live OAuth.

The proxy implementation is published and merged. Metadata publication, client
registration and live provider verification remain pending.
