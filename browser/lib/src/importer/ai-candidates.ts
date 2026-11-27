import { core } from '../ontologies/core.js';
import { dataBrowser } from '../ontologies/dataBrowser.js';
import { Datatype } from '../datatypes.js';
import type { Store } from '../store.js';
import type { JSONValue } from '../value.js';

/**
 * Classes the model may fill in, taken from what the store already knows.
 * Nothing here creates schema: the importer only ever points at a class that
 * exists, and the model chooses between them.
 */

/**
 * Class subjects that AI extraction never offers, by prefix.
 *
 * Medical values are copied literally from the lab's own page and are never
 * interpreted (MDR: an app that interprets values is a medical device). A
 * model reading a lab page would be doing exactly that, so these classes are
 * left out of the candidate list. This is the only medical-specific line in
 * the importer; the deterministic import is unaffected.
 */
export const AI_EXCLUDED_CLASS_PREFIXES: readonly string[] = [
  'https://atomicdata.dev/medical/',
];

/**
 * Built-in vocabulary (Class, Property, Drive, Commit and so on). They are
 * ontology members too, but a web page is never one of them.
 */
const BUILT_IN_CLASS_PREFIXES: readonly string[] = [
  'https://atomicdata.dev/classes/',
  'https://atomicdata.dev/class/',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/',
];

/** The generic landing places. Always offered, even when nothing else is. */
export const GENERIC_CLASSES: readonly string[] = [
  dataBrowser.classes.bookmark,
  dataBrowser.classes.article,
];

/** Most specific classes in one request (the generic two come on top). */
export const MAX_CANDIDATES = 12;
/** Most properties listed per class: required ones first. */
export const MAX_PROPERTIES = 20;
const MAX_DESCRIPTION = 160;

/** Datatypes a model can fill from page text. Links and blobs are for the user. */
const FILLABLE = new Set<string>([
  Datatype.STRING,
  Datatype.MARKDOWN,
  Datatype.SLUG,
  Datatype.DATE,
  Datatype.INTEGER,
  Datatype.FLOAT,
  Datatype.BOOLEAN,
  Datatype.URI,
]);

export interface CandidateProperty {
  subject: string;
  /** Shortname, unique within the class: the key the model writes. */
  key: string;
  datatype: string;
  name?: string;
  description?: string;
  required: boolean;
  /** The class's raw constraint for this property (enum, minimum, ...). */
  constraint?: Record<string, JSONValue>;
}

export interface CandidateClass {
  subject: string;
  /** Short unique handle the model answers with. */
  key: string;
  name?: string;
  description?: string;
  /** Shortname of the ontology that holds the class. */
  ontology?: string;
  /** Only the properties a model can fill. */
  properties: CandidateProperty[];
  /** Required properties the model cannot fill (links); the user does. */
  requiredElsewhere: string[];
}

export function isAiExcluded(classSubject: string): boolean {
  return AI_EXCLUDED_CLASS_PREFIXES.some(p => classSubject.startsWith(p));
}

/** Whether a class is a domain class rather than built-in vocabulary. */
function isDomainClass(subject: string): boolean {
  return !BUILT_IN_CLASS_PREFIXES.some(p => subject.startsWith(p));
}

type Reader = Pick<Store, 'getResource'>;

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function clip(s: string | undefined, max: number): string | undefined {
  if (!s) return s;

  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function constraintsOf(
  raw: unknown,
): Record<string, Record<string, JSONValue>> {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, Record<string, JSONValue>>)
      : {};
  } catch {
    return {};
  }
}

/** Reads one class and its properties from the store. Undefined if unusable. */
export async function loadCandidateClass(
  store: Reader,
  subject: string,
): Promise<CandidateClass | undefined> {
  const klass = await store.getResource(subject);

  if (klass.error || klass.loading) return undefined;

  const shortname = text(klass.get(core.properties.shortname));

  if (!shortname) return undefined;

  const requires = list(klass.get(core.properties.requires));
  const recommends = list(klass.get(core.properties.recommends));
  const constraints = constraintsOf(klass.get(core.properties.constraints));
  const used = new Set<string>();
  const properties: CandidateProperty[] = [];
  const requiredElsewhere: string[] = [];

  const ordered = [
    ...requires.map(p => [p, true] as const),
    ...recommends.map(p => [p, false] as const),
  ];

  for (const [propSubject, required] of ordered) {
    const prop = await store.getResource(propSubject);

    if (prop.error || prop.loading) continue;

    const key = text(prop.get(core.properties.shortname));
    const datatype = text(prop.get(core.properties.datatype)) ?? '';

    if (!key) continue;

    if (!FILLABLE.has(datatype)) {
      if (required) requiredElsewhere.push(key);

      continue;
    }

    if (used.has(key) || properties.length >= MAX_PROPERTIES) continue;

    used.add(key);
    properties.push({
      subject: propSubject,
      key,
      datatype,
      name: text(prop.get(core.properties.name)),
      description: clip(
        text(prop.get(core.properties.description)),
        MAX_DESCRIPTION,
      ),
      required,
      constraint: constraints[propSubject],
    });
  }

  if (properties.length === 0) return undefined;

  const ontologySubject = text(klass.get(core.properties.parent));
  let ontology: string | undefined;

  if (ontologySubject) {
    const o = await store.getResource(ontologySubject);

    ontology = text(o.get(core.properties.shortname));
  }

  return {
    subject,
    key: shortname,
    name: text(klass.get(core.properties.name)),
    description: clip(
      text(klass.get(core.properties.description)),
      MAX_DESCRIPTION,
    ),
    ontology,
    properties,
    requiredElsewhere,
  };
}

/**
 * Subjects of the classes AI extraction may choose from: classes of the
 * drive's own ontologies and of every ontology the store has cached (an
 * installed app's bundle, for instance), minus built-in vocabulary and the
 * denylist. Order is not relevance; see {@link rankCandidates}.
 */
export async function collectCandidateSubjects(
  store: Store,
  driveClasses: string[],
): Promise<string[]> {
  const found = new Set<string>(driveClasses);

  for (const resource of store.resources.values()) {
    if (resource.loading || resource.error) continue;

    if (!resource.hasClasses(core.classes.ontology)) continue;

    for (const c of list(resource.get(core.properties.classes))) found.add(c);
  }

  return [...found].filter(c => isDomainClass(c) && !isAiExcluded(c));
}

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length >= 3);

/**
 * Keeps the {@link MAX_CANDIDATES} classes whose names and properties share
 * the most words with the page, then adds the generic ones. `hint` is any
 * extra text that says what the page is (a schema.org type, say).
 */
export function rankCandidates(
  classes: CandidateClass[],
  pageText: string,
  hint = '',
  max = MAX_CANDIDATES,
): CandidateClass[] {
  const page = new Set(words(`${hint} ${pageText}`));
  // A plural in the page ("recipes") still names the class ("recipe").
  const seen = (w: string) =>
    page.has(w) || page.has(`${w}s`) || page.has(w.replace(/s$/, ''));

  const score = (c: CandidateClass): number => {
    const strong = words(`${c.key} ${c.name ?? ''}`);
    const weak = words(
      `${c.description ?? ''} ${c.properties.map(p => p.key).join(' ')}`,
    );

    return (
      strong.filter(seen).length * 3 + [...new Set(weak)].filter(seen).length
    );
  };

  const generic = classes.filter(c => GENERIC_CLASSES.includes(c.subject));
  const specific = classes
    .filter(c => !GENERIC_CLASSES.includes(c.subject))
    .map(c => ({ c, s: score(c) }))
    .sort((a, b) => b.s - a.s || a.c.key.localeCompare(b.c.key))
    .slice(0, max)
    .map(x => x.c);

  return [...specific, ...generic];
}

/** Makes the keys of a candidate list unique, by suffixing the ontology. */
export function uniqueKeys(classes: CandidateClass[]): CandidateClass[] {
  const taken = new Set<string>();

  return classes.map(c => {
    let key = c.key;

    if (taken.has(key) && c.ontology) key = `${c.ontology}-${c.key}`;

    for (let n = 2; taken.has(key); n++) key = `${c.key}-${n}`;

    taken.add(key);

    return key === c.key ? c : { ...c, key };
  });
}

/**
 * Everything the AI step needs from the store: the candidate list, loaded and
 * ranked. Never throws for one unreadable class; it is just left out.
 */
export async function findCandidates(
  store: Store,
  driveClasses: string[],
  pageText: string,
  hint = '',
): Promise<CandidateClass[]> {
  const subjects = await collectCandidateSubjects(store, driveClasses);
  const loaded = await Promise.all(
    [...subjects, ...GENERIC_CLASSES].map(s =>
      loadCandidateClass(store, s).catch(() => undefined),
    ),
  );
  const seen = new Set<string>();
  const classes = loaded.filter((c): c is CandidateClass => {
    if (!c || seen.has(c.subject)) return false;

    seen.add(c.subject);

    return true;
  });

  return uniqueKeys(rankCandidates(classes, pageText, hint));
}
