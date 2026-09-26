/**
 * Loro runs twice in the browser: the tab edits resources with the npm
 * `loro-crdt` build, while the client-DB worker (and the server) read and
 * merge the same bytes with the Rust `loro` crate compiled into atomic-wasm.
 * These tests pin that the two engines agree on the bytes they hand each
 * other.
 *
 * Fixtures live in `lib/test_files/loro-compat/` and are shared with the Rust
 * test `lib/tests/loro_compat.rs`:
 * - `tab-*` is written here, with loro-crdt, shaped like a tab's resource doc;
 *   Rust reads it.
 * - `rust-*` is written by the Rust test, shaped like a worker/server resource
 *   doc; this file reads it.
 *
 * Regenerate after changing a fixture's shape (not after a version bump: the
 * point is that old bytes keep reading the same):
 *   LORO_COMPAT_REGENERATE=1 pnpm exec vitest run src/loro-compat.test.ts
 *   LORO_COMPAT_REGENERATE=1 cargo test -p atomic_lib --test loro_compat
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LORO_VERSION,
  LoroDoc,
  LoroList,
  LoroMap,
  LoroText,
  type Container,
} from 'loro-crdt';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const fixtures = path.join(repoRoot, 'lib/test_files/loro-compat');
const regenerate = process.env.LORO_COMPAT_REGENERATE === '1';

const NAME = 'https://atomicdata.dev/properties/name';
const DESCRIPTION = 'https://atomicdata.dev/properties/description';
const IS_A = 'https://atomicdata.dev/properties/isA';
const PARENT = 'https://atomicdata.dev/properties/parent';
const COUNT = 'https://example.com/count';
const RATIO = 'https://example.com/ratio';
const DONE = 'https://example.com/done';
const LABEL = 'https://example.com/label';
const TEXT_PATH = 'doc/children/0/children/0';
const T1 = 1_700_000_000_000;
const T2 = 1_700_000_060_000;

interface Expected {
  v1: { deep: unknown; vv: Record<string, number>; delta: unknown };
  v2: { deep: unknown; vv: Record<string, number>; delta: unknown };
  /** Properties whose value an import of the v2 update changes or removes. */
  changedByUpdate: string[];
}

/** Shaped like `Resource` in the tab: `properties` + `datatypes` maps, a
 * loro-prosemirror style `doc` tree with a marked text node, ms timestamps and
 * a commit message on each change. */
function buildTabDocs(): { v1: Uint8Array; v2: Uint8Array; exp: Expected } {
  const doc = new LoroDoc();
  doc.setPeerId(1);
  doc.setRecordTimestamp(true);
  doc.configTextStyle({ bold: { expand: 'after' } });

  const props = doc.getMap('properties');
  props.set(NAME, 'Written by the tab');
  props.set(DESCRIPTION, '# Heading\n\nSome *markdown*');
  props.set(PARENT, 'https://example.com/drive');
  props.set(COUNT, 42);
  props.set(RATIO, 0.25);
  props.set(DONE, true);
  const isA = props.setContainer(IS_A, new LoroList());
  isA.push('https://atomicdata.dev/classes/Document');
  const label = props.setContainer(LABEL, new LoroMap());
  label.set('en', 'Hello');
  label.set('nl', 'Hallo');

  const datatypes = doc.getMap('datatypes');
  datatypes.set(DESCRIPTION, 'markdown');
  datatypes.set(PARENT, 'atomicUrl');
  datatypes.set(IS_A, 'resourceArray');

  const root = doc.getMap('doc');
  root.set('nodeName', 'doc');
  const children = root.setContainer('children', new LoroList());
  const para = children.insertContainer(0, new LoroMap());
  para.set('nodeName', 'paragraph');
  const paraChildren = para.setContainer('children', new LoroList());
  const text = paraChildren.insertContainer(0, new LoroText());
  text.insert(0, 'Hello rich world');
  text.mark({ start: 6, end: 10 }, 'bold', true);

  doc.commit({ timestamp: T1, message: 'did:ad:agent:tab' });

  const v1 = doc.export({ mode: 'snapshot' });
  const vv1 = doc.oplogVersion();
  const exp1 = readBack(doc);

  // A second peer edits on top, as another tab would; the worker receives
  // this as a commit's Loro update.
  const other = new LoroDoc();
  other.setPeerId(2);
  other.setRecordTimestamp(true);
  other.configTextStyle({ bold: { expand: 'after' } });
  other.import(v1);
  const otherProps = other.getMap('properties');
  otherProps.set(NAME, 'Renamed by another tab');
  otherProps.delete(DONE);
  (otherProps.get(IS_A) as LoroList).push(
    'https://atomicdata.dev/classes/Article',
  );
  (other.getByPath(TEXT_PATH) as LoroText).insert(16, '!');
  other.commit({ timestamp: T2, message: 'did:ad:agent:other' });

  const v2 = other.export({ mode: 'update', from: vv1 });

  return {
    v1,
    v2,
    exp: {
      v1: exp1,
      v2: readBack(other),
      changedByUpdate: [DONE, IS_A, NAME].sort(),
    },
  };
}

function readBack(doc: LoroDoc) {
  const text = doc.getByPath(TEXT_PATH) as Container | undefined;

  return {
    deep: doc.toJSON(),
    vv: Object.fromEntries(
      [...doc.oplogVersion().toJSON()].map(([peer, counter]) => [
        String(peer),
        counter,
      ]),
    ),
    delta: text instanceof LoroText ? text.toDelta() : null,
  };
}

function load(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(fixtures, name)));
}

function loadExpected(name: string): Expected {
  return JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
}

describe('Loro bytes shared between the tab and the Rust worker', () => {
  it('writes the tab fixture (regenerate mode only)', () => {
    const built = buildTabDocs();

    if (regenerate || !existsSync(path.join(fixtures, 'tab-v1.snapshot'))) {
      mkdirSync(fixtures, { recursive: true });
      writeFileSync(path.join(fixtures, 'tab-v1.snapshot'), built.v1);
      writeFileSync(path.join(fixtures, 'tab-v2.update'), built.v2);
      writeFileSync(
        path.join(fixtures, 'tab-expected.json'),
        JSON.stringify(built.exp, null, 2) + '\n',
      );
    }

    // The committed fixture must still describe what the tab writes today,
    // or the Rust side would be testing a shape the tab no longer produces.
    expect(built.exp).toEqual(loadExpected('tab-expected.json'));
  });

  it('reads a snapshot and update written by Rust loro identically', () => {
    const exp = loadExpected('rust-expected.json');

    const doc = new LoroDoc();
    doc.import(load('rust-v1.snapshot'));
    expect(readBack(doc)).toEqual(exp.v1);

    doc.import(load('rust-v2.update'));
    expect(readBack(doc)).toEqual(exp.v2);
  });

  it('reads the Rust update into a doc restored from the tab side', () => {
    // The tab keeps its own doc and imports the worker's snapshot, then a
    // later update: a fresh import of each must agree with an incremental one.
    const exp = loadExpected('rust-expected.json');
    const a = new LoroDoc();
    a.import(load('rust-v1.snapshot'));
    const b = new LoroDoc();
    b.import(a.export({ mode: 'snapshot' }));
    b.import(load('rust-v2.update'));
    expect(readBack(b)).toEqual(exp.v2);
  });

  it('runs a loro-crdt whose minor version matches the Rust loro crate', () => {
    // Loro keeps its encoding stable across 1.x, but read behaviour can still
    // shift between minors (1.12.1 changed how same-name roots of different
    // types read). Bumping one engine without the other must be a choice.
    const lock = readFileSync(path.join(repoRoot, 'Cargo.lock'), 'utf8');
    const rust = /\[\[package\]\]\nname = "loro"\nversion = "([^"]+)"/.exec(
      lock,
    )?.[1];
    expect(rust, 'loro in Cargo.lock').toBeDefined();

    const minor = (v: string) => v.split('.').slice(0, 2).join('.');
    expect(minor(LORO_VERSION())).toBe(minor(rust!));
  });
});
