/** Test-only resource/outbox persistence around the real WASM memory backend.
 * Every acknowledged local mutation checkpoints all opaque resource snapshots,
 * JSON-AD projections and observed agents' outboxes under one filesystem barrier.
 * It does not invent a persistent native replica identity or persist Vault's
 * internal bookkeeping. Raw WASM access is reserved for explicit Vault fixtures.
 */
import { mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NodeClientDb,
  type NodeClientDbOptions,
} from '../src/client-db.node.js';
import type { ClientDbOutboxWrite } from '../src/client-db.js';
import { parseCommitJSON } from '../src/commit.js';

interface Checkpoint {
  version: 1;
  resources: { subject: string; jsonAd: string; snapshot: string | null }[];
  outboxes: [string, string[]][];
  blobs: [string, string][];
  envelopes: { subject: string; json: string }[];
  metadata: { method: string; args: unknown[]; accepted?: true }[];
}
interface State {
  memory: NodeClientDb;
  options: NodeClientDbOptions;
  directory?: string;
  path?: string;
  restore: boolean;
  agents: Set<string>;
  blobs: Set<string>;
  envelopeSubjects: Set<string>;
  metadata: Checkpoint['metadata'];
  reopened: boolean;
  chain: Promise<unknown>;
  closing?: Promise<void>;
  closed: boolean;
  failNext: string | undefined;
}
const states = new Map<NodeClientDb, State>();
const directories = new Set<string>();
const metadataWrites = new Set([
  'putResourceSyncReceipts',
  'putResourceVaultAttachmentReceipts',
  'putResourceVaultReceipts',
  'clearResourceVaultReceipts',
]);
const writes = new Set([
  'outboxWrite',
  'putResource',
  'putResourceWithSnapshot',
  'putLoroSnapshot',
  'putResources',
  'removeResource',
  'applyCommit',
  'populate',
  'flush',
  'importAllResources',
  'importEnvelopes',
  'putBlob',
  ...metadataWrites,
]);

async function checkpoint(state: State, operation: string) {
  const subjects = await state.memory.allSubjects();
  const rows = await state.memory.getResourcesWithSnapshots(subjects);
  const resources = rows.map((row, index) => {
    if (row.jsonAd === null)
      throw new Error('Checkpoint cannot omit a stored resource');

    return {
      subject: subjects[index],
      jsonAd: row.jsonAd,
      snapshot: row.snapshot
        ? Buffer.from(row.snapshot).toString('base64')
        : null,
    };
  });
  const outboxes: Checkpoint['outboxes'] = [];
  for (const agent of state.agents)
    outboxes.push([agent, await state.memory.outboxEntries(agent)]);
  const blobs: Checkpoint['blobs'] = [];

  for (const hash of state.blobs) {
    const bytes = await state.memory.getBlob(Buffer.from(hash, 'hex'));
    if (bytes === null) throw new Error('Checkpoint cannot omit a stored blob');
    blobs.push([hash, Buffer.from(bytes).toString('base64')]);
  }

  const envelopes: Checkpoint['envelopes'] = [];

  for (const [subject, entries] of Object.entries(
    await state.memory.envelopesFor([
      ...new Set([...subjects, ...state.envelopeSubjects]),
    ]),
  ))
    for (const json of entries) {
      envelopes.push({ subject, json });
      state.envelopeSubjects.add(subject);
    }

  const value: Checkpoint = {
    version: 1,
    resources,
    outboxes,
    blobs,
    envelopes,
    metadata: state.metadata,
  };
  const temporary = state.path! + '.tmp';

  try {
    const file = await open(temporary, 'wx', 0o600);

    try {
      await file.writeFile(JSON.stringify(value));

      if (state.failNext === operation) {
        state.failNext = undefined;
        throw new Error('injected checkpoint fsync failure');
      }

      await file.sync();
    } finally {
      await file.close();
    }

    await rename(temporary, state.path!);
    const directory = await open(state.directory!, 'r');

    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function restore(state: State) {
  const saved = JSON.parse(await readFile(state.path!, 'utf8')) as Checkpoint;
  if (
    saved.version !== 1 ||
    !Array.isArray(saved.resources) ||
    !Array.isArray(saved.outboxes) ||
    !Array.isArray(saved.blobs) ||
    !Array.isArray(saved.envelopes) ||
    !Array.isArray(saved.metadata)
  )
    throw new Error('Invalid resource/outbox checkpoint');
  const kept = new Set(saved.resources.map(row => row.subject));
  for (const subject of await state.memory.allSubjects())
    if (!kept.has(subject)) await state.memory.removeResource(subject);

  for (const row of saved.resources) {
    await state.memory.putResourceWithSnapshot(
      row.subject,
      row.jsonAd,
      row.snapshot === null ? undefined : Buffer.from(row.snapshot, 'base64'),
    );
  }

  for (const [hash, bytes] of saved.blobs) {
    await state.memory.putBlob(
      Buffer.from(hash, 'hex'),
      Buffer.from(bytes, 'base64'),
    );
    state.blobs.add(hash);
  }

  await state.memory.importEnvelopes(saved.envelopes);
  for (const { subject } of saved.envelopes)
    state.envelopeSubjects.add(subject);

  for (const operation of saved.metadata) {
    if (!metadataWrites.has(operation.method))
      throw new Error('Unsupported checkpoint metadata mutation');
    const accepted = await Reflect.get(state.memory, operation.method).apply(
      state.memory,
      operation.args,
    );
    if (operation.accepted && accepted !== true)
      throw new Error('Accepted checkpoint metadata could not be restored');
  }

  state.metadata = saved.metadata;

  for (const [agent, entries] of saved.outboxes) {
    state.agents.add(agent);
    await state.memory.outboxWrite(
      {
        agent,
        deletes: [],
        puts: entries.map(value => ({
          subject: (JSON.parse(value) as { subject: string }).subject,
          value,
        })),
      },
      false,
    );
  }
}

/** Only this fixture acknowledges resource/outbox writes after an actual disk
 * barrier; production NodeClientDb remains explicitly memory-backed. */
export function fileClientDb(
  options: NodeClientDbOptions,
  previous?: NodeClientDb,
): NodeClientDb {
  const old = previous ? states.get(previous) : undefined;
  if (previous && (!old?.path || !old.closed || old.reopened))
    throw new Error('Only a closed owned checkpoint can reopen');
  if (old) old.reopened = true;
  const state: State = {
    memory: new NodeClientDb(options),
    options,
    directory: old?.directory,
    path: old?.path,
    restore: !!old,
    agents: new Set(),
    blobs: new Set(),
    envelopeSubjects: new Set(),
    metadata: [],
    reopened: false,
    chain: Promise.resolve(),
    failNext: undefined,
    closed: false,
  };

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    if (state.closing)
      return Promise.reject(new Error('Checkpoint database is closing'));
    const next = state.chain.then(work);
    state.chain = next.catch(() => undefined);

    return next;
  };

  const overrides = new Map<PropertyKey, PropertyDescriptor>();
  const proxy = new Proxy(state.memory, {
    defineProperty(_target, key, descriptor) {
      overrides.set(key, { ...descriptor, configurable: true });

      return true;
    },
    getOwnPropertyDescriptor(target, key) {
      return (
        overrides.get(key) ?? Reflect.getOwnPropertyDescriptor(target, key)
      );
    },
    set(_target, key, value) {
      overrides.set(key, {
        value,
        writable: true,
        enumerable: false,
        configurable: true,
      });

      return true;
    },
    deleteProperty(_target, key) {
      overrides.delete(key);

      return true;
    },
    get(target, key) {
      const override = overrides.get(key);
      if (override)
        return override.get ? override.get.call(proxy) : override.value;
      if (key === 'setSeedPromise') return target.setSeedPromise.bind(target);
      if (key === 'supportsDurablePersistence') return true;
      if (key === 'destroy') return () => closeFileClientDb(proxy);
      if (key === 'init')
        return (baseUrl?: string) =>
          serialize(async () => {
            await target.init(baseUrl);

            if (!state.path) {
              state.directory = await mkdtemp(
                join(tmpdir(), 'atomic-file-db-'),
              );
              directories.add(state.directory);
              state.path = join(state.directory, 'checkpoint.json');
            }

            if (state.restore) {
              await restore(state);
              state.restore = false;
            } else await checkpoint(state, 'init');
          });
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;

      if (key === 'outboxEntries')
        return (agent: string) => {
          state.agents.add(agent);

          return state.chain.then(() => target.outboxEntries(agent));
        };

      if (typeof key === 'string' && writes.has(key))
        return (...args: unknown[]) =>
          serialize(async () => {
            if (key === 'outboxWrite')
              state.agents.add((args[0] as ClientDbOutboxWrite).agent);
            const outbox =
              key === 'putLoroSnapshot' || key === 'putResourceWithSnapshot'
                ? (args[3] as ClientDbOutboxWrite | undefined)
                : undefined;
            if (outbox) state.agents.add(outbox.agent);
            const result = await value.apply(target, args);
            if (key === 'putBlob')
              state.blobs.add(
                Buffer.from(args[0] as Uint8Array).toString('hex'),
              );

            if (key === 'applyCommit') {
              const subject = parseCommitJSON(args[0] as string).subject;
              if (typeof subject !== 'string')
                throw new Error('Applied checkpoint commit has no subject');
              state.envelopeSubjects.add(subject);
            }

            if (key === 'importEnvelopes')
              for (const row of args[0] as { subject: string }[])
                state.envelopeSubjects.add(row.subject);
            if (metadataWrites.has(key) && result !== false)
              state.metadata.push({
                method: key,
                args: JSON.parse(JSON.stringify(args)),
                ...(result === true ? { accepted: true as const } : {}),
              });
            await checkpoint(state, key);

            return result;
          });

      if (
        typeof key === 'string' &&
        /^(?:put|remove|clear|apply|populate|flush|import)/.test(key)
      )
        return () =>
          Promise.reject(new Error('Unsupported checkpoint mutation: ' + key));

      return (...args: unknown[]) =>
        state.chain.then(() => value.apply(target, args));
    },
  });
  states.set(proxy, state);

  return proxy;
}

export function failNextFileCheckpoint(
  db: NodeClientDb,
  operation = 'putLoroSnapshot',
) {
  const state = states.get(db);
  if (!state) throw new Error('Not an owned filesystem fixture');
  state.failNext = operation;
}

export async function closeFileClientDb(db: NodeClientDb): Promise<void> {
  const state = states.get(db);

  if (!state) {
    db.destroy();

    return;
  }

  state.closing ??= state.chain.then(() => {
    state.memory.destroy();
    state.closed = true;
  });
  await state.closing;
}

export async function disposeFileClientDbs(): Promise<void> {
  for (const db of states.keys()) await closeFileClientDb(db);
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
  states.clear();
  directories.clear();
}

export async function readFileCheckpoint(
  db: NodeClientDb,
): Promise<Checkpoint> {
  const state = states.get(db);
  if (!state?.path) throw new Error('No owned checkpoint');
  await state.chain;

  return JSON.parse(await readFile(state.path, 'utf8')) as Checkpoint;
}
