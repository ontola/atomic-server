import { store } from './store.js';
import { camelCaseify, getExtension } from './utils.js';
import { atomicConfig } from './config.js';
import type { Core, Store } from '@tomic/lib';

enum Inserts {
  MODULE_ALIAS = '{{1}}',
  IMPORTS = '{{2}}',
  REGISTER_ARGS = '{{3}}',
  EXTERNALS_IMPORT = '{{4}}',
}

const TEMPLATE = `
/* -----------------------------------
* GENERATED WITH @tomic/cli
* -------------------------------- */

import { registerOntologies } from '${
  // Prevents a circular dependency
  atomicConfig._ISLIB_ ? `../ontology${getExtension()}` : Inserts.MODULE_ALIAS
}';

${Inserts.IMPORTS}

export function initOntologies(): void {
  registerOntologies(${Inserts.REGISTER_ARGS});
}
`;

export const generateIndex = (
  ontologies: string[],
  inludeExternals: boolean,
  activeStore: Store = store,
) => {
  const names = ontologies.map(x => {
    const res = activeStore.getResourceLoading<Core.Ontology>(x);

    return camelCaseify(res.props.shortname);
  });

  if (inludeExternals) {
    names.push('externals');
  }

  const importLines = names.map(createImportLine).join('\n');
  const registerArgs = names.join(', ');

  const moduleAlias = atomicConfig.moduleAlias ?? '@tomic/lib';
  const content = TEMPLATE.replaceAll(Inserts.MODULE_ALIAS, moduleAlias)
    .replace(Inserts.IMPORTS, importLines)
    .replace(Inserts.REGISTER_ARGS, registerArgs);

  return {
    filename: 'index.ts',
    content,
  };
};

const createImportLine = (name: string) =>
  `import { ${name} } from './${name}${getExtension()}';`;
