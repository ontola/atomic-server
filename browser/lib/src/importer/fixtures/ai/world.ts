import { core } from '../../../ontologies/core.js';
import { dataBrowser } from '../../../ontologies/dataBrowser.js';
import type { Store } from '../../../store.js';

/**
 * An invented store for the AI importer tests and the owner-run evaluation:
 * a small ontology (recipe, event, product, lesson), a medical class that the
 * denylist must keep out, the built-in vocabulary and Bookmark and Article.
 */

export const DT = 'https://atomicdata.dev/datatypes/';
export const P = core.properties;

type Def = Record<string, unknown>;

/** A tiny in-memory store: classes, properties and ontologies as plain maps. */
export function fakeStore(defs: Record<string, Def>): Store {
  const res = (subject: string) => {
    const d = defs[subject];

    return {
      subject,
      error: d ? undefined : new Error('missing'),
      loading: false,
      get: (p: string) => d?.[p],
      hasClasses: (c: string) =>
        ((d?.[P.isA] as string[] | undefined) ?? []).includes(c),
    };
  };

  const map = new Map(Object.keys(defs).map(s => [s, res(s)]));

  return {
    getResource: async (s: string) => res(s),
    resources: map,
  } as unknown as Store;
}

const prop = (
  subject: string,
  shortname: string,
  datatype: string,
  extra: Def = {},
): [string, Def] => [
  subject,
  { [P.shortname]: shortname, [P.datatype]: DT + datatype, ...extra },
];

export const ONT = 'https://example.test/kit/v1';
export const MED = 'https://atomicdata.dev/medical/v1';

export function world(): Record<string, Def> {
  const defs: Record<string, Def> = {};
  const add = ([s, d]: [string, Def]) => (defs[s] = d);

  for (const [s, short, dt] of [
    [P.name, 'name', 'string'],
    [P.description, 'description', 'markdown'],
    [dataBrowser.properties.url, 'url', 'string'],
    [dataBrowser.properties.preview, 'preview', 'markdown'],
    [dataBrowser.properties.imageUrl, 'image-url', 'string'],
    [dataBrowser.properties.publishedAt, 'published-at', 'date'],
    [`${ONT}/property/ingredients`, 'ingredients', 'markdown'],
    [`${ONT}/property/steps`, 'steps', 'markdown'],
    [`${ONT}/property/servings`, 'servings', 'integer'],
    [`${ONT}/property/starts`, 'starts-on', 'date'],
    [`${ONT}/property/venue`, 'venue', 'string'],
    [`${ONT}/property/price`, 'price', 'float'],
    [`${ONT}/property/brand`, 'brand', 'string'],
    [`${ONT}/property/grade`, 'grade', 'integer'],
    [`${ONT}/property/goals`, 'learning-goals', 'markdown'],
    [`${MED}/property/med-value`, 'med-value', 'float'],
    [`${MED}/property/med-unit`, 'med-unit', 'string'],
  ] as const) {
    add(prop(s, short, dt));
  }

  add(prop(`${ONT}/property/organizer`, 'organizer', 'atomicURL'));
  defs[`${ONT}/property/venue`][P.description] = 'Place name and address';

  const klass = (
    subject: string,
    short: string,
    name: string,
    description: string,
    requires: string[],
    recommends: string[] = [],
    parent = ONT,
  ) =>
    (defs[subject] = {
      [P.isA]: ['https://atomicdata.dev/classes/Class'],
      [P.shortname]: short,
      [P.name]: name,
      [P.description]: description,
      [P.requires]: requires,
      [P.recommends]: recommends,
      [P.parent]: parent,
    });
  const pr = (s: string) => `${ONT}/property/${s}`;

  klass(
    `${ONT}/class/recipe`,
    'recipe',
    'Recipe',
    'A dish with ingredients and steps',
    [P.name],
    [pr('ingredients'), pr('steps'), pr('servings')],
  );
  klass(
    `${ONT}/class/event`,
    'event',
    'Event',
    'Something that happens at a time and place',
    [P.name, pr('starts')],
    [pr('venue'), P.description, pr('organizer')],
  );
  klass(
    `${ONT}/class/product`,
    'product',
    'Product',
    'Something for sale',
    [P.name],
    [pr('price'), pr('brand'), P.description],
  );
  klass(
    `${ONT}/class/lesson`,
    'lesson',
    'Lesson',
    'A lesson with learning goals',
    [P.name],
    [pr('grade'), pr('goals'), P.description],
  );
  klass(
    `${MED}/class/lab-result`,
    'lab-result',
    'Lab result',
    'A lab measurement',
    [`${MED}/property/med-value`],
    [`${MED}/property/med-unit`],
    MED,
  );
  klass(
    dataBrowser.classes.bookmark,
    'Bookmark',
    'Bookmark',
    'A saved link',
    [P.name, dataBrowser.properties.url],
    [
      dataBrowser.properties.preview,
      P.description,
      dataBrowser.properties.imageUrl,
    ],
    'https://atomicdata.dev/ontology/data-browser',
  );
  klass(
    dataBrowser.classes.article,
    'Article',
    'Article',
    'Written text',
    [P.name, P.description],
    [dataBrowser.properties.publishedAt],
    'https://atomicdata.dev/ontology/data-browser',
  );

  defs[ONT] = {
    [P.isA]: [core.classes.ontology],
    [P.shortname]: 'kit',
    [P.classes]: [
      `${ONT}/class/recipe`,
      `${ONT}/class/event`,
      `${ONT}/class/product`,
      `${ONT}/class/lesson`,
    ],
  };
  defs[MED] = {
    [P.isA]: [core.classes.ontology],
    [P.shortname]: 'medical',
    [P.classes]: [`${MED}/class/lab-result`],
  };
  // Built-in vocabulary is an ontology too, and must never be offered.
  defs['https://atomicdata.dev/ontology/core'] = {
    [P.isA]: [core.classes.ontology],
    [P.classes]: [
      'https://atomicdata.dev/classes/Class',
      'https://atomicdata.dev/classes/Drive',
    ],
  };

  return defs;
}
