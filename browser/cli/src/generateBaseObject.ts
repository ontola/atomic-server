import { Resource, type Core, core } from '@tomic/lib';
import { store } from './store.js';
import { camelCaseify, dedupe } from './utils.js';
import chalk from 'chalk';

export type ReverseMapping = Record<string, string>;

type BaseObject = {
  classes: Record<string, string>;
  properties: Record<string, string>;
  __classDefs: Record<string, string[]>;
};

export const generateBaseObject = async (
  ontology: Resource<Core.Ontology>,
): Promise<[string, ReverseMapping]> => {
  if (ontology.error) {
    throw ontology.error;
  }

  const classes = dedupe(ontology.props.classes ?? []);
  const properties = dedupe(ontology.props.properties ?? []);
  const name = camelCaseify(ontology.title);

  const baseObj = {
    classes: await listToObj(classes, 'classes'),
    properties: await listToObj(properties, 'properties'),
    __classDefs: await createClassDefs(classes),
  };

  const objStr = `export const ${name} = {
    classes: ${recordToString(baseObj.classes)},
    properties: ${recordToString(baseObj.properties)},
    __classDefs: ${stringifyClassDefs(baseObj.__classDefs)}
  } as const satisfies OntologyBaseObject`;

  return [objStr, createReverseMapping(name, baseObj)];
};

const listToObj = async (
  list: string[],
  type: string,
): Promise<Record<string, string>> => {
  const entries = await Promise.all(
    list.map(async subject => {
      const resource = await store.getResource(subject);

      return [camelCaseify(resource.title), subject];
    }),
  );

  // check for duplicates and throw an error if there are any.
  const duplicates = entries.filter(
    (entry, index) => entries.findIndex(e => e[0] === entry[0]) !== index,
  );

  if (duplicates.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      chalk.red(`ERROR: Found ${type} with the same name: `),
      duplicates.map(e => e[0]).join(', '),
    );

    // eslint-disable-next-line no-console
    console.log(
      chalk.red(
        'Properties with the same name will conflict in the generated ontology. Try to reuse properties where possible or rename the duplicate to prevent a conflict.',
      ),
    );

    process.exit(1);
  }

  return Object.fromEntries(entries);
};

const createClassDefs = async (
  classes: string[],
): Promise<Record<string, string[]>> => {
  const classResources = await Promise.all(
    classes.map(async c => await store.getResource(c)),
  );

  const entries = classResources.map(resource => {
    return [
      resource.subject,
      [
        ...resource.getArray(core.properties.requires),
        ...resource.getArray(core.properties.recommends),
      ],
    ];
  });

  return Object.fromEntries(entries);
};

const recordToString = (obj: Record<string, string>): string => {
  const innerSting = Object.entries(obj).reduce(
    (acc, [key, value]) => `${acc}\n\t${key}: '${value}',`,
    '',
  );

  return `{${innerSting}\n   }`;
};

const stringifyClassDefs = (obj: Record<string, string[]>) => {
  const innerString = Object.entries(obj).reduce(
    (acc, [key, value]) => `${acc}\n\t["${key}"]: ${JSON.stringify(value)},`,
    '',
  );

  return `{${innerString}\n   }`;
};

const createReverseMapping = (
  ontologyTitle: string,
  obj: BaseObject,
): ReverseMapping => {
  const reverseMapping: ReverseMapping = {};

  for (const [name, subject] of Object.entries(obj.classes)) {
    reverseMapping[subject] = `${ontologyTitle}.classes.${name}`;
  }

  for (const [name, subject] of Object.entries(obj.properties)) {
    reverseMapping[subject] = `${ontologyTitle}.properties.${name}`;
  }

  return reverseMapping;
};
