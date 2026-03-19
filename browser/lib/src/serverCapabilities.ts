import { hasBrowserAPI } from './hasBrowserAPI.js';

const ATOMIC_SERVER_VERSION_HEADER = 'X-Atomic-Server-Version';
const MIN_DID_AUTH_SERVER_MINOR = 40;

const warnedDidAuthCompatibilityOrigins = new Set<string>();
const supportsDidAuthByOrigin = new Map<string, boolean>();
const serverVersionByOrigin = new Map<string, string>();

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

export async function ensureServerVersionKnown(url: string): Promise<void> {
  if (!hasBrowserAPI()) {
    return;
  }

  const origin = tryGetOrigin(url);

  if (!origin || serverVersionByOrigin.has(origin)) {
    return;
  }

  try {
    const response = await fetch(`${origin}/`, { method: 'GET' });
    recordServerVersionFromResponse(origin, response);
  } catch {
    // Can't reach the server - treat as legacy (no DID auth support)
    supportsDidAuthByOrigin.set(origin, false);
  }
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
