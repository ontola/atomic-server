/* -----------------------------------
 * Hand-maintained, in the shape @tomic/cli generates.
 *
 * The `forks` ontology is defined in `lib/defaults/forks.json` and bootstrapped
 * by every server, but its Ontology resource does not exist on atomicdata.dev, so
 * `ad-generate ontologies` cannot produce this file. Keep it in sync with
 * `lib/defaults/forks.json` by hand until the ontology is published.
 * -------------------------------- */

import type { OntologyBaseObject, BaseProps, JSONValue } from '../index.js';

export const forks = {
  classes: {
    fork: 'https://atomicdata.dev/classes/Fork',
  },
  properties: {
    originalSubject: 'https://atomicdata.dev/properties/originalSubject',
    forkBase: 'https://atomicdata.dev/properties/forkBase',
    forkVersion: 'https://atomicdata.dev/properties/forkVersion',
  },
  __classDefs: {
    ['https://atomicdata.dev/classes/Fork']: [
      'https://atomicdata.dev/properties/originalSubject',
    ],
  },
} as const satisfies OntologyBaseObject;

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Forks {
  export type Fork = typeof forks.classes.fork;
}

declare module '../index.js' {
  interface Classes {
    [forks.classes.fork]: {
      requires: BaseProps | typeof forks.properties.originalSubject;
      recommends: typeof forks.properties.forkBase;
    };
  }

  interface PropTypeMapping {
    [forks.properties.originalSubject]: string;
    [forks.properties.forkBase]: JSONValue;
    [forks.properties.forkVersion]: string;
  }

  interface PropSubjectToNameMapping {
    [forks.properties.originalSubject]: 'originalSubject';
    [forks.properties.forkBase]: 'forkBase';
    [forks.properties.forkVersion]: 'forkVersion';
  }
}
