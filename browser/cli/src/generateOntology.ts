import { generateBaseObject } from './generateBaseObject.js';
import { generateClasses } from './generateClasses.js';
import { store } from './store.js';
import { camelCaseify, dedupe } from './utils.js';
import { generatePropTypeMapping } from './generatePropTypeMapping.js';
import { generateSubjectToNameMapping } from './generateSubjectToNameMapping.js';
import { generateClassExports } from './generateClassExports.js';

import { atomicConfig } from './config.js';
import { PropertyRecord } from './PropertyRecord.js';
import { Core, type Store } from '@tomic/lib';

enum Inserts {
  MODULE_ALIAS = '{{1}}',
  BASE_OBJECT = '{{2}}',
  CLASS_EXPORTS = '{{3}}',
  CLASSES = '{{4}}',
  PROP_TYPE_MAPPING = '{{7}}',
  PROP_SUBJECT_TO_NAME_MAPPING = '{{8}}',
  TYPE_IMPORTS = '{{9}}',
}

const TEMPLATE = `
/* -----------------------------------
* GENERATED WITH @tomic/cli
* For more info on how to use ontologies: https://github.com/atomicdata-dev/atomic-server/blob/develop/browser/cli/readme.md
* -------------------------------- */

import type { ${Inserts.TYPE_IMPORTS} } from '${Inserts.MODULE_ALIAS}'

${Inserts.BASE_OBJECT}

${Inserts.CLASS_EXPORTS}

declare module '${Inserts.MODULE_ALIAS}' {
  ${Inserts.CLASSES}

  ${Inserts.PROP_TYPE_MAPPING}

  ${Inserts.PROP_SUBJECT_TO_NAME_MAPPING}
}
`;

export const generateOntology = async (
  subject: string,
  propertyRecord: PropertyRecord,
  activeStore: Store = store,
): Promise<{
  filename: string;
  content: string;
}> => {
  const ontology = await activeStore.getResource<Core.Ontology>(subject);

  const properties = dedupe(ontology.props.properties ?? []);

  for (const prop of properties) {
    propertyRecord.reportPropertyDefined(prop);
  }

  const [baseObjStr, reverseMapping] = await generateBaseObject(
    ontology,
    activeStore,
  );
  const classesStr = generateClasses(
    ontology,
    reverseMapping,
    propertyRecord,
    activeStore,
  );
  const [propertiesStr, propertiesImports] = generatePropTypeMapping(
    ontology,
    reverseMapping,
    activeStore,
  );
  const subToNameStr = generateSubjectToNameMapping(ontology, reverseMapping);
  const classExportsStr = generateClassExports(
    ontology,
    reverseMapping,
    activeStore,
  );

  const content = TEMPLATE.replaceAll(
    Inserts.MODULE_ALIAS,
    atomicConfig.moduleAlias ?? '@tomic/lib',
  )
    .replace(
      Inserts.TYPE_IMPORTS,
      ['OntologyBaseObject', 'BaseProps', ...propertiesImports].join(', '),
    )
    .replace(Inserts.BASE_OBJECT, baseObjStr)
    .replace(Inserts.CLASS_EXPORTS, classExportsStr)
    .replace(Inserts.CLASSES, classesStr)
    .replace(Inserts.PROP_TYPE_MAPPING, propertiesStr)
    .replace(Inserts.PROP_SUBJECT_TO_NAME_MAPPING, subToNameStr);

  return {
    filename: `${camelCaseify(ontology.props.shortname)}.ts`,
    content,
  };
};
