// @wc-ignore-file
import type { Store } from '@tomic/react';
import { withoutIdentifiers } from './sentry';
import { isRunningInTauri } from './tauri';

/** Sentry tag values are cut at 200 characters, so cut here and say so. */
const MAX_VALUE = 200;

/**
 * Everything the app knows about its own setup that helps diagnose a report.
 * Deliberately no workspace content, resource names or subjects, agent keys
 * or secrets; errors enter only as a short, identifier-free text of the app's
 * own connection or storage state.
 */
export interface FeedbackDiagnosticsInput {
  /** The app release, as Sentry reports it. */
  release: string;
  desktop: boolean;
  /** Where the store sends writes. Reduced to scheme, host and port. */
  serverUrl: string;
  connected: boolean;
  connectionError?: string;
  /** Names the server advertised on `AUTH_OK`; empty on a node older than 2026-09. */
  capabilities: string[];
  outboxSize: number;
  outboxBlocked: number;
  /** The highest consecutive failure count among outbox entries. */
  outboxFailures: number;
  /** The local database could not start, if it could not. */
  storageError?: string;
  browserOnline?: boolean;
}

type Tags = Record<string, string | number | boolean>;

/** A clue is useful without its URLs and ids, which could name a resource. */
function describeError(message: string | undefined): string | undefined {
  if (!message) return undefined;

  return withoutIdentifiers(message)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .slice(0, MAX_VALUE);
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Pure: the Sentry tags that go on every feedback event. */
export function buildFeedbackDiagnostics(
  input: FeedbackDiagnosticsInput,
): Tags {
  const tags: Tags = {
    appRelease: input.release,
    desktop: input.desktop,
    // Same keys as a repeated commit failure report.
    connected: input.connected,
    outboxSize: input.outboxSize,
    blocked: input.outboxBlocked,
    failures: input.outboxFailures,
    capabilityCount: input.capabilities.length,
    canonicalScheme: input.capabilities.includes('canonical-scheme'),
    capabilities: input.capabilities
      .slice()
      .sort()
      .join(',')
      .slice(0, MAX_VALUE),
  };
  const server = originOf(input.serverUrl);

  if (server) tags.server = server;

  if (input.browserOnline !== undefined)
    tags.browserOnline = input.browserOnline;

  const connectionError = input.connected
    ? undefined
    : describeError(input.connectionError);
  const storageError = describeError(input.storageError);

  if (connectionError) tags.connectionError = connectionError;

  if (storageError) tags.storageError = storageError;

  return tags;
}

/** Reads the diagnostics off the live store. Nothing is fetched. */
export function collectFeedbackDiagnostics(store: Store): Tags {
  const status = store.getSyncStatus();
  const outbox = store.outbox.pending();

  return buildFeedbackDiagnostics({
    release: `atomic-data-browser@${__APP_VERSION__}+${__GIT_COMMIT__}`,
    desktop: isRunningInTauri(),
    serverUrl: status.serverUrl,
    connected: status.serverConnected,
    connectionError: status.serverConnectionError,
    capabilities: store.getDefaultWebSocket()?.serverCapabilities ?? [],
    outboxSize: outbox.length,
    outboxBlocked: status.blockedCount,
    outboxFailures: outbox.reduce((m, e) => Math.max(m, e.failures ?? 0), 0),
    storageError: status.clientDbError,
    browserOnline:
      typeof navigator === 'undefined' ? undefined : navigator.onLine,
  });
}
