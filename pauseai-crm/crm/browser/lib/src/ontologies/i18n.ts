/* -----------------------------------
 * Hand-maintained, in the shape @tomic/cli generates.
 *
 * The `i18n` ontology is defined in `lib/defaults/i18n.json` and bootstrapped
 * by every server, but its Ontology resource does not exist on atomicdata.dev,
 * so `ad-generate ontologies` cannot produce this file. Keep it in sync with
 * `lib/defaults/i18n.json` by hand until the ontology is published.
 * -------------------------------- */

import type { OntologyBaseObject, JSONValue } from '../index.js';

export const i18n = {
  classes: {},
  properties: {
    language: 'https://atomicdata.dev/properties/language',
    translationOf: 'https://atomicdata.dev/properties/translationOf',
    defaultLanguage: 'https://atomicdata.dev/properties/defaultLanguage',
    languages: 'https://atomicdata.dev/properties/languages',
  },
  __classDefs: {},
} as const satisfies OntologyBaseObject;

declare module '../index.js' {
  interface PropTypeMapping {
    [i18n.properties.language]: string;
    [i18n.properties.translationOf]: string;
    [i18n.properties.defaultLanguage]: string;
    [i18n.properties.languages]: JSONValue;
  }

  interface PropSubjectToNameMapping {
    [i18n.properties.language]: 'language';
    [i18n.properties.translationOf]: 'translationOf';
    [i18n.properties.defaultLanguage]: 'defaultLanguage';
    [i18n.properties.languages]: 'languages';
  }
}
