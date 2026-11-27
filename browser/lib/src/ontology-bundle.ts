import { JSONADParser } from './parse.js';
import type { Resource } from './resource.js';
import type { Store } from './store.js';
import { isJSONObject, type JSONObject } from './value.js';

/** What {@link installOntologyBundle} did. */
export interface InstallOntologyReport {
  /** Subjects stored for the first time. */
  created: string[];
  /** Subjects whose label (`name`, `description`) or ontology member lists changed. */
  updated: string[];
  /** Subjects already stored as in the bundle. */
  unchanged: string[];
}

const IS_A = 'https://atomicdata.dev/properties/isA';
const PARENT = 'https://atomicdata.dev/properties/parent';
const NAME = 'https://atomicdata.dev/properties/name';
const DESCRIPTION = 'https://atomicdata.dev/properties/description';
const ONTOLOGY = 'https://atomicdata.dev/class/ontology';
const CLASS = 'https://atomicdata.dev/classes/Class';
const PROPERTY = 'https://atomicdata.dev/classes/Property';
const SELECT_PROPERTY = 'https://atomicdata.dev/classes/SelectProperty';
const TAG = 'https://atomicdata.dev/classes/Tag';
const ONTOLOGY_LISTS = [
  'https://atomicdata.dev/properties/classes',
  'https://atomicdata.dev/properties/properties',
];

/** Fields that may change between versions without changing what a term means. */
const LABELS = [NAME, DESCRIPTION];

/** Mirrors `Subject::CANONICAL_VOCABULARY_PREFIXES` (`lib/src/subject.rs`). */
const RESERVED_PREFIXES = [
  'atomicdata.dev/properties/',
  'atomicdata.dev/classes/',
  'atomicdata.dev/datatypes/',
  'atomicdata.dev/class/',
  'atomicdata.dev/property/',
  'atomicdata.dev/methods/',
  'atomicdata.dev/ontology/',
  'atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/',
];

const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? value
        .map(v => String(v))
        .sort()
        .join('\n')
    : JSON.stringify(value);

const asList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(v => String(v)) : [];

/** Ontology 0, Property (or SelectProperty) 1, Tag 2, Class 3, anything else -1. */
const kindOf = (item: JSONObject): number => {
  const classes = asList(item[IS_A]).sort();
  const only = (c: string) => classes.length === 1 && classes[0] === c;

  if (only(ONTOLOGY)) return 0;

  if (
    only(PROPERTY) ||
    (classes.length === 2 &&
      classes.includes(PROPERTY) &&
      classes.includes(SELECT_PROPERTY))
  ) {
    return 1;
  }

  if (only(TAG)) return 2;

  return only(CLASS) ? 3 : -1;
};

/**
 * Store an ontology bundle (a JSON-AD array of one Ontology plus its Classes
 * and Properties, Tags) in the local store under the subjects it names, as if each
 * had been fetched from its address. No network request, no commit, nothing is
 * signed, queued or synced.
 *
 * - Idempotent: a bundle that is already stored changes nothing.
 * - Refuses, storing nothing, when a term is stored with a different meaning:
 *   every field except `name`, `description` (and the ontology's member lists,
 *   which may grow) must match what is stored.
 * - Only an Ontology (class `https://atomicdata.dev/class/ontology`), Classes and
 *   Properties and Tags at absolute `https://` subjects. Exactly one Ontology. The
 *   reserved vocabulary namespaces and the own server's address are refused.
 *
 * Mirrors `atomic_lib::ontology_bundle::install_ontology_bundle`; both run the
 * fixture `lib/tests/fixtures/ontology-bundle.json`.
 */
export async function installOntologyBundle(
  store: Store,
  bundle: unknown,
): Promise<InstallOntologyReport> {
  const items: JSONObject[] = Array.isArray(bundle)
    ? bundle.filter(isJSONObject)
    : [];

  if (!Array.isArray(bundle) || items.length !== bundle.length) {
    throw new Error('An ontology bundle is a JSON-AD array of resources');
  }

  if (items.filter(i => kindOf(i) === 0).length !== 1) {
    throw new Error('An ontology bundle holds exactly one Ontology');
  }

  const ownHost = (() => {
    try {
      return new URL(store.getServerUrl()).host;
    } catch {
      return undefined;
    }
  })();

  for (const item of items) {
    const subject = String(item['@id']);
    let url: URL;

    try {
      url = new URL(subject);
    } catch {
      throw new Error(`${subject} is not an absolute https:// subject`);
    }

    if (url.protocol !== 'https:' || url.search) {
      throw new Error(`${subject} is not an absolute https:// subject`);
    }

    if (url.host === ownHost) {
      throw new Error(
        `${subject} is served by this store itself; publish the bundle there by importing it`,
      );
    }

    if (
      RESERVED_PREFIXES.some(p => `${url.host}${url.pathname}`.startsWith(p))
    ) {
      throw new Error(`${subject} belongs to the shared vocabulary`);
    }

    if (kindOf(item) < 0) {
      throw new Error(
        `${subject} is not an Ontology (${ONTOLOGY}), Class, Property or Tag`,
      );
    }
  }

  // Plan everything before writing anything: a refusal leaves no half install.
  const report: InstallOntologyReport = {
    created: [],
    updated: [],
    unchanged: [],
  };
  const plan: { item: JSONObject; existed: boolean }[] = [];

  for (const item of items) {
    const subject = String(item['@id']);
    const stored = await storedOnly(store, subject);

    if (!stored) {
      plan.push({ item, existed: false });
      continue;
    }

    const next: JSONObject = { ...item };
    let changed = false;

    for (const [property, value] of Object.entries(item)) {
      if (property === '@id' || property === PARENT) continue;

      const current = stored.get(property);

      if (current !== undefined && canonical(current) === canonical(value)) {
        continue;
      }

      const growable = kindOf(item) === 0 && ONTOLOGY_LISTS.includes(property);

      if (!LABELS.includes(property) && !growable) {
        throw new Error(
          `${subject} is already stored with a different \`${property}\`: refusing to change what the term means`,
        );
      }

      if (growable) {
        const merged = [
          ...new Set([...asList(current), ...asList(value)]),
        ].sort();

        if (canonical(current ?? []) === canonical(merged)) continue;
        next[property] = merged;
      }

      changed = true;
    }

    if (changed) plan.push({ item: next, existed: true });
    else report.unchanged.push(subject);
  }

  const parsed = new JSONADParser().parse(plan.map(p => p.item));

  for (const resource of parsed) {
    const subject = resource.subject;
    const existed = plan.find(p => p.item['@id'] === subject)?.existed;

    // The same ingress a fetched External resource takes.
    store.applyIncoming({
      subject,
      resource,
      source: 'http-fetch',
      replaceLoroDocsFromRemote: !!existed,
    });
    (existed ? report.updated : report.created).push(subject);
  }

  return report;
}

/** The resource as this store holds it, without ever fetching it. */
async function storedOnly(
  store: Store,
  subject: string,
): Promise<Resource | undefined> {
  try {
    const found = await store.getLocalResource(subject);

    return found.isReady() ? found : undefined;
  } catch {
    return undefined;
  }
}
