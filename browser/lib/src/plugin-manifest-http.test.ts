import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { validateManifest } from './plugin-manifest.js';
import {
  checkGate,
  checkHostFeatures,
  derivedRequires,
  hostFeatureMessage,
  hostFeatureUnavailableError,
  httpGate,
  parsePluginRoutesStatus,
  requiresGate,
  HostFeatureUnavailableError,
  type PluginRoutesStatus,
} from './plugin-manifest-http.js';
import { pinPluginRelease } from './plugin-connection.js';
import {
  AtomicError,
  ErrorType,
  PROBLEM_MARKER,
  splitProblem,
} from './error.js';
vi.mock('./authentication.js', () => ({
  signRequest: async () => ({ authorization: 'signed' }),
}));

// Shared with server/src/plugins/manifest.rs and manifest_http.rs.
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../testdata/plugin-manifest/${name}`, import.meta.url),
      'utf8',
    ),
  );

describe('manifest v3 http block conformance', () => {
  const cases: {
    name: string;
    file: string;
    error?: string;
    serialized?: unknown;
    gate?: unknown;
    requires?: string[];
  }[] = fixture('http-index.json');

  for (const entry of cases) {
    it(entry.name, () => {
      const raw = fixture(entry.file);

      if (entry.error !== undefined) {
        expect(() => validateManifest(raw)).toThrow(entry.error);

        return;
      }

      const manifest = validateManifest(raw);
      if (entry.serialized !== undefined)
        expect(manifest).toEqual(entry.serialized);
      expect(httpGate(manifest.http)).toEqual(entry.gate);
      expect(derivedRequires(manifest)).toEqual(entry.requires);
      // The canonical form is a fixed point.
      expect(validateManifest(manifest)).toEqual(manifest);
    });
  }
});

describe('host-feature-unavailable refusals', () => {
  const cases: {
    name: string;
    file: string;
    node: PluginRoutesStatus;
    refusal: unknown;
    message?: string;
  }[] = fixture('http-refusals.json');

  for (const entry of cases) {
    it(entry.name, () => {
      const manifest = validateManifest(fixture(entry.file));
      const refusal = checkHostFeatures(manifest.http, entry.node);

      if (entry.refusal === null) {
        expect(refusal).toBeUndefined();

        return;
      }

      expect(refusal).toEqual(entry.refusal);
      expect(hostFeatureMessage(refusal!)).toBe(entry.message);
    });
  }
});

describe('pinning a release the node cannot open', () => {
  it('throws the typed problem the server answers with', async () => {
    const problem = fixture('http-refusals.json').find(
      (c: { name: string }) =>
        c.name === 'read-only route on a feature build at off',
    );
    const body = {
      ...problem.refusal,
      status: 409,
      title: "This server can't open this plugin's public endpoints",
      detail: problem.message,
    };
    const transport = (async () =>
      new Response(JSON.stringify(body), {
        status: 409,
        headers: { 'content-type': 'application/problem+json' },
      })) as unknown as typeof fetch;
    const store = {
      getAgent: () => ({}) as never,
      getServerUrl: () => 'https://atomic.test',
    };

    const error = await pinPluginRelease(
      store,
      { drive: 'd', plugin: 'p' },
      transport,
    ).catch(e => e);

    expect(error).toBeInstanceOf(HostFeatureUnavailableError);
    expect(error.problem).toEqual(problem.refusal);
    expect(error.message).toBe(problem.message);
  });
});

describe('a refused Installation commit', () => {
  const entry = fixture('http-refusals.json').find(
    (c: { name: string }) =>
      c.name === 'read-only route on a feature build at off',
  );
  const trailer =
    PROBLEM_MARKER +
    JSON.stringify({
      ...entry.refusal,
      detail: entry.message,
    });

  it('carries the typed problem on the WS ERROR frame', () => {
    // `websockets.ts` builds this from the frame's code and message.
    const error = new AtomicError(
      entry.message + trailer,
      ErrorType.Server,
      11,
    );

    expect(error.message).toBe(entry.message);
    const typed = hostFeatureUnavailableError(error);
    expect(typed).toBeInstanceOf(HostFeatureUnavailableError);
    expect(typed!.problem).toEqual(entry.refusal);
    expect(typed!.message).toBe(entry.message);
  });

  it('carries it on the /commit Error resource', () => {
    // `client.ts` builds this from the response body.
    const body = JSON.stringify({
      'https://atomicdata.dev/properties/description': entry.message + trailer,
      'https://atomicdata.dev/properties/errorCode': 11,
    });
    const error = new AtomicError(body, ErrorType.Client);

    expect(error.message).toBe(entry.message);
    expect(error.code).toBe(11);
    expect(hostFeatureUnavailableError(error)!.problem).toEqual(entry.refusal);
  });

  it('is left alone when it is another error', () => {
    expect(
      hostFeatureUnavailableError(new AtomicError('nope')),
    ).toBeUndefined();
    expect(hostFeatureUnavailableError(new Error('nope'))).toBeUndefined();
    const other = new AtomicError(
      `nope${PROBLEM_MARKER}{"type":"something-else"}`,
    );
    expect(other.message).toBe('nope');
    expect(hostFeatureUnavailableError(other)).toBeUndefined();
    // The 409 path's error passes through as it is.
    const pinned = new HostFeatureUnavailableError(entry.refusal);
    expect(hostFeatureUnavailableError(pinned)).toBe(pinned);
  });

  it('splits the problem off whatever wraps the message', () => {
    const problem = { type: 'x', surfaces: ['route `GET /a/{b}`', '}{'] };
    const wrapped = `Hook failed: Refused.${PROBLEM_MARKER}${JSON.stringify(problem)}. Retry`;

    expect(splitProblem(wrapped)).toEqual(['Hook failed: Refused.', problem]);
    expect(splitProblem('plain')).toEqual(['plain', undefined]);
    const broken = `x${PROBLEM_MARKER}not json`;
    expect(splitProblem(broken)).toEqual([broken, undefined]);
  });
});

describe('a catalog entry gated by its derived requires', () => {
  const cases: {
    name: string;
    file: string;
    node: PluginRoutesStatus;
    refusal: { compiled: boolean; level: string; needed: string } | null;
  }[] = fixture('http-refusals.json');

  // A catalog must not mark a plugin the install would accept, or list one
  // it would refuse.
  for (const entry of cases) {
    it(`agrees with the manifest: ${entry.name}`, () => {
      const manifest = validateManifest(fixture(entry.file));
      const refusal = checkGate(
        requiresGate(derivedRequires(manifest)),
        entry.node,
      );

      if (entry.refusal === null) {
        expect(refusal).toBeUndefined();

        return;
      }

      expect(refusal).toMatchObject({
        compiled: entry.refusal.compiled,
        level: entry.refusal.level,
        needed: entry.refusal.needed,
      });
    });
  }

  it('needs nothing without requires', () => {
    expect(requiresGate(null).needed).toBe('none');
    expect(requiresGate(['wasm-sandbox']).needed).toBe('none');
    // An uncached release the server couldn't read names no gate; the
    // catalog marks it instead.
    expect(requiresGate('unknown').needed).toBe('none');
  });
});

describe('hostFeatures in a /plugin-catalog body', () => {
  it('reads pluginRoutes', () => {
    const pluginRoutes = {
      compiled: true,
      level: 'read-only',
      routesOrigin: null,
      listeners: ['willow-wgps'],
      sidecars: [],
    };

    expect(
      parsePluginRoutesStatus({ entries: [], hostFeatures: { pluginRoutes } }),
    ).toEqual(pluginRoutes);
  });

  it('is absent for a server from before the gates', () => {
    expect(parsePluginRoutesStatus([])).toBeUndefined();
  });
});
