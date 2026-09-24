import {
  parseHostFeatureUnavailable,
  type HostFeatureUnavailable,
  type PluginRoutesLevel,
  type RouteAuth,
  type RouteMount,
  type RoutePrincipal,
} from './plugin-manifest-http.js';

/**
 * `readRouteStatus` (design 2.10, #1721): an Installation's public endpoints
 * as the server sees them. From `GET /plugin-route-status`, which only a
 * server built with plugin routes has.
 */

/** A delivery job that failed at least once, or ended as a dead letter. */
export interface DeliveryFailure {
  id: string;
  /** The route whose handler enqueued it. */
  route?: string;
  operation: string;
  host?: string;
  /** `queued`: retried at `nextAt`. `dead`: given up on. */
  state: 'queued' | 'sending' | 'delivered' | 'dead';
  attempts: number;
  enqueuedAt: number;
  /** When the last attempt ended. */
  at?: number;
  /** The destination's answer, when it answered. */
  status?: number;
  error?: string;
  /** Timed out or cut off: it may have arrived. */
  uncertain: boolean;
  nextAt?: number;
}

export interface RouteLastError {
  at: number;
  status: number;
  message: string;
}

export interface RouteHealth {
  id: string;
  /** The public URL; empty when the server can't say (no routes origin). */
  url: string;
  path?: string;
  methods: string[];
  auth?: RouteAuth;
  principal?: RoutePrincipal;
  requests24h: number;
  errors24h: number;
  lastError?: RouteLastError;
  queueDepth: number;
  oldestQueueFailure?: DeliveryFailure;
}

export interface DeliveryHealth {
  queued: number;
  sending: number;
  held: number;
  waitingForCap: number;
  delivered24h: number;
  dead: number;
  sentToday: number;
  /** Absent when the node has no daily cap. */
  dailyCap?: number;
  /** Dead letters first, then jobs still retrying; newest first. */
  lastFailures: DeliveryFailure[];
}

export type InstallationRouteState =
  | 'active'
  | 'paused'
  | 'retired'
  | 'degraded'
  | 'unregistered';

export interface InstallationRouteStatus {
  installation: string;
  state: InstallationRouteState;
  /** The server's reason, when `state` is `degraded`. */
  degraded?: string;
  /** The gates that hold the release back, as design 0.4's typed problem. */
  refusal?: HostFeatureUnavailable;
  level: PluginRoutesLevel;
  mount?: RouteMount;
  routes: RouteHealth[];
  deliveries?: DeliveryHealth;
}

export interface RouteToken {
  id: string;
  /** The declared token store (`http.tokens[].name`). */
  name: string;
  scopes: string[];
  client?: string;
  issuedAt: number;
  expiresAt?: number;
  approvedBy?: string;
}

type Raw = Record<string, unknown>;

const STATES: InstallationRouteState[] = [
  'active',
  'paused',
  'retired',
  'degraded',
  'unregistered',
];
const LEVELS: PluginRoutesLevel[] = ['off', 'read-only', 'read-write'];
const AUTHS: RouteAuth[] = [
  'none',
  'atomic',
  'http-signature',
  'bearer',
  'dpop',
];
const PRINCIPALS: RoutePrincipal[] = ['anonymous', 'installation', 'caller'];
const MOUNTS: RouteMount[] = [
  'installation-origin',
  'drive-host',
  'drive-prefix',
];

const obj = (v: unknown): Raw | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;
const oneOf = <T extends string>(v: unknown, of: T[]): T | undefined =>
  of.includes(v as T) ? (v as T) : undefined;

function parseFailure(value: unknown): DeliveryFailure | undefined {
  const raw = obj(value);
  const id = str(raw?.id);

  if (!raw || !id) return undefined;

  return {
    id,
    route: str(raw.route),
    operation: str(raw.operation) ?? '',
    host: str(raw.host),
    state:
      oneOf(raw.state, ['queued', 'sending', 'delivered', 'dead']) ?? 'queued',
    attempts: num(raw.attempts) ?? 0,
    enqueuedAt: num(raw.enqueuedAt) ?? 0,
    at: num(raw.at),
    status: num(raw.status),
    error: str(raw.error),
    uncertain: raw.uncertain === true,
    nextAt: num(raw.nextAt),
  };
}

function parseRoute(value: unknown): RouteHealth | undefined {
  const raw = obj(value);
  const id = str(raw?.id);

  if (!raw || !id) return undefined;
  const lastError = obj(raw.lastError);

  return {
    id,
    url: str(raw.url) ?? '',
    path: str(raw.path),
    methods: Array.isArray(raw.methods)
      ? raw.methods.filter((m): m is string => typeof m === 'string')
      : [],
    auth: oneOf(raw.auth, AUTHS),
    principal: oneOf(raw.principal, PRINCIPALS),
    requests24h: num(raw.requests24h) ?? 0,
    errors24h: num(raw.errors24h) ?? 0,
    lastError: lastError
      ? {
          at: num(lastError.at) ?? 0,
          status: num(lastError.status) ?? 0,
          message: str(lastError.message) ?? '',
        }
      : undefined,
    queueDepth: num(raw.queueDepth) ?? 0,
    oldestQueueFailure: parseFailure(raw.oldestQueueFailure),
  };
}

function parseDeliveries(value: unknown): DeliveryHealth | undefined {
  const raw = obj(value);

  if (!raw) return undefined;

  return {
    queued: num(raw.queued) ?? 0,
    sending: num(raw.sending) ?? 0,
    held: num(raw.held) ?? 0,
    waitingForCap: num(raw.waitingForCap) ?? 0,
    delivered24h: num(raw.delivered24h) ?? 0,
    dead: num(raw.dead) ?? 0,
    sentToday: num(raw.sentToday) ?? 0,
    dailyCap: num(raw.dailyCap),
    lastFailures: Array.isArray(raw.lastFailures)
      ? raw.lastFailures.flatMap(f => parseFailure(f) ?? [])
      : [],
  };
}

/** A `/plugin-route-status` body, dropping anything malformed. */
export function parseRouteStatus(
  body: unknown,
): InstallationRouteStatus | undefined {
  const raw = obj(body);
  const installation = str(raw?.installation);

  if (!raw || !installation) return undefined;

  return {
    installation,
    state: oneOf(raw.state, STATES) ?? 'unregistered',
    degraded: str(raw.degraded),
    refusal: parseHostFeatureUnavailable(raw.refusal),
    level: oneOf(raw.level, LEVELS) ?? 'off',
    mount: oneOf(raw.mount, MOUNTS),
    routes: Array.isArray(raw.routes)
      ? raw.routes.flatMap(r => parseRoute(r) ?? [])
      : [],
    deliveries: parseDeliveries(raw.deliveries),
  };
}

/** A `/plugin-route-tokens` listing, dropping anything malformed. */
export function parseRouteTokens(body: unknown): RouteToken[] {
  const tokens = obj(body)?.tokens;

  if (!Array.isArray(tokens)) return [];

  return tokens.flatMap(t => {
    const raw = obj(t);
    const id = str(raw?.id);

    if (!raw || !id) return [];

    return [
      {
        id,
        name: str(raw.name) ?? '',
        scopes: Array.isArray(raw.scopes)
          ? raw.scopes.filter((s): s is string => typeof s === 'string')
          : [],
        client: str(raw.client),
        issuedAt: num(raw.issuedAt) ?? 0,
        expiresAt: num(raw.expiresAt),
        approvedBy: str(raw.approvedBy),
      },
    ];
  });
}
