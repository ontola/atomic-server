import { hasBrowserAPI } from './hasBrowserAPI.js';

const ATOMIC_SERVER_VERSION_HEADER = 'X-Atomic-Server-Version';
const MIN_DID_AUTH_SERVER_MINOR = 40;

const warnedDidAuthCompatibilityOrigins = new Set<string>();
const supportsDidAuthByOrigin = new Map<string, boolean>();
const serverVersionByOrigin = new Map<string, string>();
/** Capability names each origin advertised in its WebSocket `AUTH_OK`
 *  payload (see `ServerCapability` in `ws-v2.ts`). Absent origin = the
 *  server never told us, which for a server older than 2026-09 means it
 *  supports none of the named features. */
const wsCapabilitiesByOrigin = new Map<string, ReadonlySet<string>>();

/** Record what a server said it speaks, from its `AUTH_OK` payload. */
export function recordServerWsCapabilities(
  origin: string,
  capabilities: readonly string[],
): void {
  wsCapabilitiesByOrigin.set(origin, new Set(capabilities));
}

/** Whether `origin` advertised `capability`. False when unknown: callers
 *  fall back to the pre-capability behaviour, never the other way round. */
export function serverHasCapability(
  origin: string,
  capability: string,
): boolean {
  return wsCapabilitiesByOrigin.get(origin)?.has(capability) ?? false;
}

/** The full advertised set for `origin`, or an empty array. */
export function getServerWsCapabilities(origin: string): string[] {
  return [...(wsCapabilitiesByOrigin.get(origin) ?? [])];
}

export function shouldSkipDidAuthForLegacyServer(
  url: string,
  agentSubject?: string,
): boolean {
  if (!agentSubject?.startsWith('did:ad:agent:')) {
    return false;
  }

  if (!hasBrowserAPI()) {
    return false;
  }

  const requestOrigin = tryGetOrigin(url);

  if (!requestOrigin) {
    return false;
  }

  const supportsDidAuth = supportsDidAuthByOrigin.get(requestOrigin);

  // If we explicitly know it does not support it, skip.
  // If we don't know yet (undefined), we should TRY it.
  return supportsDidAuth === false;
}

export function warnDidAuthCompatibility(url: string): void {
  if (!hasBrowserAPI()) {
    return;
  }

  const origin = tryGetOrigin(url);

  if (!origin || warnedDidAuthCompatibilityOrigins.has(origin)) {
    return;
  }

  const version = serverVersionByOrigin.get(origin);
  const reason = version
    ? `server version '${version}' does not support DID auth`
    : `server version unknown (assuming <0.40)`;

  warnedDidAuthCompatibilityOrigins.add(origin);
  console.debug(
    `[atomic-lib] Skipping DID authentication request to '${origin}': ${reason}.`,
  );
}

export function recordServerVersionFromResponse(
  url: string,
  response: Response,
): void {
  const version = response.headers.get(ATOMIC_SERVER_VERSION_HEADER);
  const origin = tryGetOrigin(url);

  if (!origin) {
    return;
  }

  if (!version) {
    // No version header means old server that doesn't support DID auth
    supportsDidAuthByOrigin.set(origin, false);

    return;
  }

  serverVersionByOrigin.set(origin, version);
  supportsDidAuthByOrigin.set(origin, versionSupportsDidAuth(version));
}

/**
 * Records server version and DID auth support based on WebSocket protocol.
 *
 * Any negotiated `atomicdata-ws.*` subprotocol means a server new enough to
 * speak DID auth; only a server that selects none is treated as legacy. The
 * previous check compared against `atomicdata-ws.v0.1`, a name the client
 * stopped sending when it moved to `v2` (see `WS_PROTOCOL`), so every server
 * — including the app's own embedded one — was recorded as not supporting it.
 */
export function recordServerVersionFromWsProtocol(
  protocol: string | undefined,
  origin: string,
): void {
  const speaksAtomicWs = protocol?.startsWith('atomicdata-ws.') ?? false;

  serverVersionByOrigin.set(origin, protocol ?? 'legacy');
  supportsDidAuthByOrigin.set(origin, speaksAtomicWs);
}

function versionSupportsDidAuth(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);

  if (!match) {
    return false;
  }

  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);

  if (Number.isNaN(major) || Number.isNaN(minor)) {
    return false;
  }

  return major > 0 || (major === 0 && minor >= MIN_DID_AUTH_SERVER_MINOR);
}

function tryGetOrigin(url: string): string | undefined {
  try {
    // Normalize WebSocket URLs to HTTP so they share the same origin key
    const normalized = url
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://');

    return new URL(
      normalized,
      hasBrowserAPI() ? window.location.origin : undefined,
    ).origin;
  } catch {
    return undefined;
  }
}
