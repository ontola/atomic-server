// @wc-ignore-file
import * as Sentry from '@sentry/react';
import {
  getLoroFailure,
  STORAGE_BLOCKED_ERROR_NAME,
  type Store,
} from '@tomic/react';
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

/** Pure: the Sentry tags that go on every event. */
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

/**
 * Loro's panic hook logs the Rust message with `console.error` just before
 * the wasm traps, and the SDK keeps that line as a breadcrumb. The trap itself
 * arrives as a bare `RuntimeError: unreachable`.
 */
const PANIC = /^panicked at (.+):\n(.*)/;
const PANIC_LOOKBACK = 30;

/** Pure: the location and message of the wasm panic behind a trap, if logged. */
export function wasmPanicTags(event: Sentry.Event): Tags {
  if (!event.exception?.values?.some(v => v.type === 'RuntimeError')) return {};

  const crumbs = event.breadcrumbs ?? [];

  for (
    let i = crumbs.length - 1;
    i >= 0 && i >= crumbs.length - PANIC_LOOKBACK;
    i--
  ) {
    const found =
      crumbs[i].category === 'console'
        ? PANIC.exec(crumbs[i].message ?? '')
        : null;

    // Quoted text may be a key or a value from the workspace.
    if (found)
      return {
        wasmPanicAt: found[1].slice(0, MAX_VALUE),
        wasmPanic: describeError(found[2].replace(/"[^"]*"/g, '"…"'))!,
      };
  }

  return {};
}

/** Pure: what {@link getLoroFailure} knows, as tags. */
function loroFailureTags(error: unknown): Tags {
  const failure = getLoroFailure(error);

  if (!failure) return {};

  return {
    loroOp: failure.op,
    ...(failure.bytes !== undefined && { loroBytes: failure.bytes }),
    ...(failure.ops !== undefined && { loroOps: failure.ops }),
  };
}

/**
 * Put the app's setup on every Sentry event, not just on feedback: a report is
 * only as useful as what it says about the setup it came from. Read when the
 * event is made, so nothing runs until something goes wrong. Tags the event
 * already carries win. Never throws, so it can never keep an event from being
 * sent.
 */
export function addDiagnosticsToSentryEvents(store: Store): void {
  if (!Sentry.isEnabled()) return;

  Sentry.addEventProcessor((event, hint) => {
    try {
      event.tags = {
        ...collectFeedbackDiagnostics(store),
        ...loroFailureTags(hint.originalException),
        ...wasmPanicTags(event),
        ...event.tags,
      };

      // A browser that refuses local storage is a state to know about, not a defect.
      if (
        event.exception?.values?.some(
          v => v.type === STORAGE_BLOCKED_ERROR_NAME,
        )
      )
        event.level = 'warning';
    } catch {
      // The tags are a courtesy.
    }

    return event;
  });
}
