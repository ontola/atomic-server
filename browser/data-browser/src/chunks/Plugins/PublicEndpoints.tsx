import { Column } from '@components/Row';
import {
  hostFeatureMessage,
  httpGate,
  type DeclaredHttp,
  type DeclaredRoute,
  type HostFeatureUnavailable,
  type PluginRoutesStatus,
  type RouteAuth,
  type RoutePrincipal,
} from '@tomic/react';
import { FaTriangleExclamation } from 'react-icons/fa6';
import { styled } from 'styled-components';

/** Who may call a route, in words. */
function authText(auth: RouteAuth | undefined): string {
  switch (auth ?? 'none') {
    case 'atomic':
      return 'Callers sign in with their Atomic agent.';
    case 'http-signature':
      return 'Other servers sign their requests (HTTP Signatures).';
    case 'bearer':
      return 'Callers present an access token this plugin issued.';
    case 'dpop':
      return 'Callers present an access token bound to their key (DPoP).';
    default:
      return 'Anyone can call it, without signing in.';
  }
}

/** As whom the plugin reads and writes while answering. */
function principalText(principal: RoutePrincipal | undefined): string {
  switch (principal ?? 'anonymous') {
    case 'installation':
      return 'The plugin answers as itself, with the rights this installation grants it.';
    case 'caller':
      return 'The plugin answers as the caller, with the caller’s rights.';
    default:
      return 'The plugin answers with public data only.';
  }
}

/** The address the endpoints get, which becomes the plugin's public identity. */
function PublicAddress({
  http,
  pluginRoutes,
  serverUrl,
}: {
  http: DeclaredHttp;
  pluginRoutes?: PluginRoutesStatus;
  serverUrl: string;
}) {
  const mount = http.mount ?? 'installation-origin';

  if (mount === 'drive-prefix') {
    return (
      <p>
        Served at <code>{`${serverUrl}/_routes/<installation>/`}</code>. This
        address becomes the plugin’s public identity.
      </p>
    );
  }

  if (mount === 'drive-host') {
    return (
      <p>
        Served on this drive’s own host name, next to its resources. That
        address becomes the plugin’s public identity.
      </p>
    );
  }

  const origin = pluginRoutes?.routesOrigin;

  if (!origin) {
    return (
      <p>
        Served at its own address under the server’s routes origin, which this
        server has not set (<code>ATOMIC_ROUTES_ORIGIN</code>). That address
        becomes the plugin’s public identity.
      </p>
    );
  }

  const { protocol, host } = new URL(origin);

  return (
    <p>
      Served at <code>{`${protocol}//<installation>.${host}/`}</code>. This
      address becomes the plugin’s public identity.
    </p>
  );
}

// Wuchale drops a message with nested elements when it sits inside a
// `{condition && (...)}`, and every such message after it in the same
// element. These small components keep the conditionals free of text.

function GateLevel({ needed }: { needed: 'read-only' | 'read-write' }) {
  if (needed === 'read-only') {
    return (
      <p data-testid='gate-level'>
        The server must run with <code>--plugin-routes read-only</code> or
        higher.
      </p>
    );
  }

  return (
    <p data-testid='gate-level'>
      The server must run with <code>--plugin-routes read-write</code>.
    </p>
  );
}

function MatchNote({ prefix }: { prefix: string }) {
  return (
    <p>
      Answers for <code>{prefix}</code> names only.
    </p>
  );
}

function WritesNote({ targets }: { targets: string[] }) {
  return (
    <p>
      Stores what callers send in <code>{targets.join(', ')}</code>.
    </p>
  );
}

function RouteItem({ route }: { route: DeclaredRoute }) {
  return (
    <li>
      <ItemTitle>
        <code>
          {route.methods.join(', ')} {route.path}
        </code>
      </ItemTitle>
      <p>
        {authText(route.auth)} {principalText(route.principal)}
      </p>
      {route.writes && route.writes.length > 0 && (
        <WritesNote targets={route.writes} />
      )}
      {route.enqueues && route.enqueues.length > 0 && (
        <p>Can send requests to other servers: {route.enqueues.join(', ')}</p>
      )}
    </li>
  );
}

/**
 * The "Public endpoints" section of the install review (design 2.9, 2.10):
 * every route, well-known claim, write target, key, token store, listener
 * and sidecar a release opens, the address that becomes its identity, and
 * the gate level it needs.
 */
export function PublicEndpoints({
  http,
  pluginRoutes,
  serverUrl,
}: {
  http: DeclaredHttp;
  pluginRoutes?: PluginRoutesStatus;
  serverUrl: string;
}) {
  const gate = httpGate(http);

  if (gate.needed === 'none') return null;

  return (
    <Column as='section' aria-label='Public endpoints'>
      <h3>Public endpoints</h3>
      <p>
        Anyone on the internet can call these endpoints; this plugin decides
        what they may see.
      </p>
      {http.reason && <p>{http.reason}</p>}
      <PublicAddress
        http={http}
        pluginRoutes={pluginRoutes}
        serverUrl={serverUrl}
      />
      <GateLevel needed={gate.needed} />
      <List>
        {http.routes?.map(route => (
          <RouteItem key={route.id} route={route} />
        ))}
        {http.wellKnown?.map(claim => (
          <li key={`well-known:${claim.name}`}>
            <ItemTitle>
              <code>/.well-known/{claim.name}</code>
            </ItemTitle>
            <p>
              {claim.kind === 'exclusive'
                ? 'Only this plugin answers this address on its host.'
                : 'Shared with other plugins on its host; this plugin answers only its own entries.'}
            </p>
            {claim.match && <MatchNote prefix={claim.match.resourcePrefix} />}
          </li>
        ))}
        {http.writeTargets?.map(target => (
          <li key={`write:${target.id}`}>
            <ItemTitle>
              Stores incoming data: <code>{target.id}</code>
            </ItemTitle>
            <p>
              Callers add resources to <code>{target.parent}</code> unattended.
            </p>
          </li>
        ))}
        {http.keys?.map(key => (
          <li key={`key:${key.name}`}>
            <ItemTitle>
              Signing key: <code>{key.name}</code> ({key.alg})
            </ItemTitle>
            <p>
              {key.reason ??
                'The server keeps the private key; the plugin can only ask it to sign.'}
            </p>
          </li>
        ))}
        {http.tokens?.map(token => (
          <li key={`token:${token.name}`}>
            <ItemTitle>
              Access tokens: <code>{token.name}</code>
            </ItemTitle>
            <p>
              {token.reason ??
                'The plugin issues access tokens to other apps; the server stores them.'}
            </p>
          </li>
        ))}
        {http.listeners?.map(listener => (
          <li key={`listener:${listener.name}`}>
            <ItemTitle>
              Network port: <code>{listener.name}</code>
            </ItemTitle>
            <p>
              {listener.reason ??
                'A raw port the server operator opens for this plugin.'}
            </p>
            <p>
              The operator binds it with <code>ATOMIC_PLUGIN_LISTENERS</code>.
            </p>
          </li>
        ))}
        {http.sidecars?.map(sidecar => (
          <li key={`sidecar:${sidecar.name}`}>
            <ItemTitle>
              Local service: <code>{sidecar.name}</code>
            </ItemTitle>
            <p>
              {sidecar.reason ??
                'A service the server operator runs next to the server.'}
            </p>
            <p>
              The operator names it in <code>ATOMIC_PLUGIN_SIDECARS</code>.
            </p>
          </li>
        ))}
      </List>
    </Column>
  );
}

/**
 * The refusal text of design 0.4 (`hostFeatureMessage`, the server's own
 * words), with its `code` spans rendered as code.
 */
export function RefusalText({ problem }: { problem: HostFeatureUnavailable }) {
  return (
    <>
      {hostFeatureMessage(problem)
        .split('`')
        .map((part, i) =>
          i % 2 === 1 ? (
            <code key={i}>{part}</code>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
    </>
  );
}

/**
 * Why this server can't install a release (design 0.4), as an inline banner.
 * The words are the server's own (`hostFeatureMessage`).
 */
export function GateRefusal({ problem }: { problem: HostFeatureUnavailable }) {
  return (
    <Banner role='alert' data-testid='gate-refusal'>
      <FaTriangleExclamation aria-hidden />
      <p>
        <RefusalText problem={problem} />
      </p>
    </Banner>
  );
}

/** The status-pill chip a marked catalog entry carries. */
export function NeedsPublicEndpointsChip() {
  return <Pill data-status='needs-attention'>Needs public endpoints</Pill>;
}

/**
 * The chip a catalog entry carries when the server couldn't say what its
 * release needs. The review checks the manifest before anything installs.
 */
export function RequirementsUnknownChip() {
  return (
    <Pill
      data-status='unknown'
      title='This server couldn’t read what this release needs. The review checks it before installing.'
    >
      Requirements unknown
    </Pill>
  );
}

const List = styled.ul`
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size()};
  padding: 0;
  margin: 0;

  li {
    background-color: ${p => p.theme.colors.bg1};
    border-radius: ${p => p.theme.radius};
    list-style: none;
    padding: ${p => p.theme.size()};
    margin: 0;
    overflow-wrap: anywhere;

    p {
      margin: 0;
    }
  }
`;

const ItemTitle = styled.p`
  font-weight: bold;
  font-size: 0.9rem;
`;

const Banner = styled.div`
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  color: ${p => p.theme.colors.alert};
  border: 1px solid ${p => p.theme.colors.alert};
  border-radius: ${p => p.theme.radius};
  padding: ${p => p.theme.size()};
  overflow-wrap: anywhere;

  svg {
    flex-shrink: 0;
    margin-top: 0.2rem;
  }

  p {
    margin: 0;
    color: ${p => p.theme.colors.text};
  }
`;

const Pill = styled.span`
  font-size: 0.8rem;
  padding: 0.1rem 0.5rem;
  border-radius: ${p => p.theme.radius};
  border: 1px solid ${p => p.theme.colors.warning};
  color: ${p => p.theme.colors.text};
  white-space: nowrap;
`;
