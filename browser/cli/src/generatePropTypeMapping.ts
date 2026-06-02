import { Datatype, Resource, type Core, type Store } from '@tomic/lib';
import { store } from './store.js';
import { ReverseMapping } from './generateBaseObject.js';
import { DatatypeToTSTypeMap } from './DatatypeToTSTypeMap.js';
import { dedupe } from './utils.js';

export const generatePropTypeMapping = (
  ontology: Resource<Core.Ontology>,
  reverseMapping: ReverseMapping,
  activeStore: Store = store,
): [mappingString: string, usedImports: string[]] => {
  const properties = dedupe(ontology.props.properties ?? []);

  const lines = properties
    .map(subject => generateLine(subject, reverseMapping, activeStore))
    .join('\n');

  const mappingString = `interface PropTypeMapping {
    ${lines}
  }`;

  const imports = mappingString.includes('JSONValue') ? ['JSONValue'] : [];

  return [mappingString, imports];
};

const generateLine = (
  subject: string,
  reverseMapping: ReverseMapping,
  activeStore: Store,
) => {
  const resource = activeStore.getResourceLoading<Core.Property>(subject);
  const datatype = resource.props.datatype as Datatype;

  const type = DatatypeToTSTypeMap[datatype];

  if (!type) {
    console.error(`Unknown datatype ${datatype} on property ${resource.title}`);
    process.exit(1);
  }

  return `[${reverseMapping[subject]}]: ${type}`;
};
