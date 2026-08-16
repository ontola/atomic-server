/**
 * TS vs WASM comparison for the operations that exist on both sides of
 * `@tomic/lib` / `atomic_lib`. Run with `pnpm bench` from `browser/lib`.
 *
 * WASM benches need `wasm/pkg` (from `pnpm --filter @tomic/data-browser
 * build:wasm`). They are skipped when that artifact is missing so the rest
 * of the suite still runs.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bench, describe } from 'vitest';
import { blake3 } from '@noble/hashes/blake3.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { hashes, sign } from '@noble/ed25519';
import stringify from 'fast-json-stable-stringify';

import { encodeGenesisCert, decodeGenesisCert } from './genesis.js';
import { serializeDeterministically } from './commit.js';
import { itemFingerprint } from './rbsr.js';
import { canonicalDriveHash } from './canonical-drive-hash.js';
import { Resource } from './resource.js';
import { core } from './ontologies/core.js';
import { enableLoro } from './loro-loader.js';
import { decodeB64 } from './base64.js';

hashes.sha512 = sha512;

await enableLoro();

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '../../../wasm/pkg/atomic_wasm_bg.wasm');
const wasmAvailable = existsSync(wasmPath);

const TYPICAL_JSON_AD = {
  '@id': 'https://example.com/r',
  'https://atomicdata.dev/properties/name': 'My important document',
  'https://atomicdata.dev/properties/description':
    'This is a longer description that contains more text to simulate real content in a resource.',
  'https://atomicdata.dev/properties/isA': [
    'https://atomicdata.dev/classes/Document',
  ],
  'https://atomicdata.dev/properties/parent':
    'did:ad:8ZEtla9eiLhfcPQQq42se35kyScsiUtvBMXdqqXrAubs8ReINwLkgx6M5LsSyGQoT/WrARH3NMxaneKKZ2iJCA==',
};

const jsonAdStr = JSON.stringify(TYPICAL_JSON_AD);
const oneKiB = new Uint8Array(1024);

const cert = {
  signerPubkey: new Uint8Array(32).fill(1),
  createdAt: 1_780_000_123_456,
  nonce: new Uint8Array(16).fill(2),
  stateHash: new Uint8Array(32).fill(9),
  parent: 'https://example.com/parent',
  drive: 'did:ad:driveAAAA',
};
const encodedCert = encodeGenesisCert(cert);

const privateKey = new Uint8Array(32).fill(7);
const authMessage = new TextEncoder().encode(
  'https://example.com/resource 1775504552928',
);

const unsignedCommit = {
  subject: 'https://example.com/r',
  signer: 'did:ad:agent:abc',
  createdAt: 1775504552928,
  loroUpdate: new Uint8Array([1, 2, 3, 4]),
};

const resource = new Resource('https://example.com/a');
resource.applyHydratedValues([
  [core.properties.name, 'My Resource'],
  [core.properties.description, 'description'],
]);

describe('hot path: stay in JS (per-render)', () => {
  bench('Resource.get(name) cache hit', () => {
    resource.get(core.properties.name);
  });

  bench('JSON.parse typical resource JSON-AD', () => {
    JSON.parse(jsonAdStr);
  });

  bench('JSON.stringify typical resource', () => {
    JSON.stringify(TYPICAL_JSON_AD);
  });

  bench('structuredClone typical resource (worker postMessage proxy)', () => {
    structuredClone(TYPICAL_JSON_AD);
  });
});

describe('must-match protocol (TS)', () => {
  bench('genesis.encode', () => {
    encodeGenesisCert(cert);
  });

  bench('genesis.decode', () => {
    decodeGenesisCert(encodedCert);
  });

  bench('commit.serializeDeterministically', () => {
    serializeDeterministically({ ...unsignedCommit });
  });

  bench('fast-json-stable-stringify typical resource', () => {
    stringify(TYPICAL_JSON_AD);
  });

  bench('rbsr.itemFingerprint (SubtleCrypto SHA-256)', async () => {
    await itemFingerprint('s', { p1: 1, p2: 2 });
  });

  bench('canonicalDriveHash 2 subjects', async () => {
    await canonicalDriveHash({ s1: [2, 0], s2: [0, 3] });
  });

  bench('ed25519.sign noble (auth message)', async () => {
    await sign(authMessage, privateKey);
  });

  bench('blake3.hash 1KiB (noble)', () => {
    blake3(oneKiB);
  });
});

describe.skipIf(!wasmAvailable)('WASM ClientDb (in-process, no Worker)', () => {
  let db: {
    blake3Hash: (data: Uint8Array) => Uint8Array;
    putResource: (json: string) => Promise<void>;
    getResource: (subject: string) => Promise<unknown>;
  };

  // vitest bench runs describe callbacks before benches; init once here.
  // Top-level await in this callback is allowed.
  const ready = (async () => {
    const initMod = await import('../../../wasm/pkg/atomic_wasm.js');
    const bytes = await readFile(wasmPath);
    await initMod.default({ module_or_path: bytes });
    db = await initMod.ClientDb.newInMemory(undefined);
    await db.putResource(jsonAdStr);
  })();

  bench('wasm init wait (once, ignored in comparison)', async () => {
    await ready;
  });

  bench('WASM blake3.hash 1KiB (wasm-bindgen + copy)', async () => {
    await ready;
    db.blake3Hash(oneKiB);
  });

  bench('WASM putResource typical JSON-AD', async () => {
    await ready;
    await db.putResource(jsonAdStr);
  });

  bench('WASM getResource → JSON string across FFI', async () => {
    await ready;
    await db.getResource('https://example.com/r');
  });

  bench('WASM getResource + JSON.parse (JS materialize)', async () => {
    await ready;
    const json = await db.getResource('https://example.com/r');
    if (typeof json === 'string') JSON.parse(json);
  });
});

describe('FFI cost model (why Resource.get cannot live in a Worker)', () => {
  const payload = jsonAdStr;

  bench('TextEncoder.encode JSON-AD (copy into WASM memory)', () => {
    new TextEncoder().encode(payload);
  });

  bench('base64 decode 64-byte signature', () => {
    decodeB64('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });
});
