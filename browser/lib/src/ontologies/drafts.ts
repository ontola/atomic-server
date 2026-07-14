/* -----------------------------------
 * Hand-maintained, in the shape @tomic/cli generates.
 *
 * The `drafts` ontology is defined in `lib/defaults/drafts.json` and bootstrapped
 * by every server, but its Ontology resource does not exist on atomicdata.dev, so
 * `ad-generate ontologies` cannot produce this file. Keep it in sync with
 * `lib/defaults/drafts.json` by hand until the ontology is published.
 * -------------------------------- */

import type { OntologyBaseObject, BaseProps } from '../index.js';

export const drafts = {
  classes: {
    draft: 'https://atomicdata.dev/classes/Draft',
  },
  properties: {
    originalSubject: 'https://atomicdata.dev/properties/originalSubject',
  },
  __classDefs: {
    ['https://atomicdata.dev/classes/Draft']: [
      'https://atomicdata.dev/properties/originalSubject',
    ],
  },
} as const satisfies OntologyBaseObject;

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Drafts {
  export type Draft = typeof drafts.classes.draft;
}

declare module '../index.js' {
  interface Classes {
    [drafts.classes.draft]: {
      requires: BaseProps | typeof drafts.properties.originalSubject;
      recommends: never;
    };
  }

  interface PropTypeMapping {
    [drafts.properties.originalSubject]: string;
  }

  interface PropSubjectToNameMapping {
    [drafts.properties.originalSubject]: 'originalSubject';
  }
}
