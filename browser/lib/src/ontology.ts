import { JSONValue } from './value.js';

export type OntologyBaseObject = {
  readonly classes: Record<string, string>;
  readonly properties: Record<string, string>;
  readonly __classDefs: Record<string, string[]>;
};

// Extended via module augmentation
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface Classes {
  'unknown-subject': {
    requires: BaseProps;
    recommends: never;
  };
}

export type UnknownClass = 'unknown-subject';

export type BaseProps =
  | 'https://atomicdata.dev/properties/isA'
  | 'https://atomicdata.dev/properties/parent';

// Extended via module augmentation
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface PropTypeMapping {}

// Extended via module augmentation
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface PropSubjectToNameMapping {}

export type Requires<C extends keyof Classes> = Classes[C]['requires'];
export type Recommends<C extends keyof Classes> = Classes[C]['recommends'];

type PropsOfClass<C extends keyof Classes> = {
  [P in Requires<C>]: P;
} & {
  [P in Recommends<C>]?: P;
};

/**
 * Infers the js type a value can have on a resource for the given property.
 * If the property is not known in any ontology, it will return JSONValue.
 */
export type InferTypeOfValueInTriple<
  Class extends keyof Classes | never = never,
  Prop = string,
  Returns = Prop extends keyof PropTypeMapping
    ? Prop extends Requires<Class>
      ? PropTypeMapping[Prop]
      : PropTypeMapping[Prop] | undefined
    : JSONValue,
> = Returns;

type QuickAccessKnownPropType<Class extends OptionalClass> = {
  [Prop in keyof PropsOfClass<Class> as PropSubjectToNameMapping[Prop]]: InferTypeOfValueInTriple<
    Class,
    Prop
  >;
};

/** Type of the dynamically created resource.props field */
export type QuickAccessPropType<Class extends OptionalClass = UnknownClass> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Class extends UnknownClass ? any : QuickAccessKnownPropType<Class>;

export type OptionalClass = keyof Classes | UnknownClass;

/** Let atomic lib know your custom ontologies exist */
export function registerOntologies(...ontologies: OntologyBaseObject[]): void {
  if (!globalThis.ATOMIC_SUBJECT_TO_NAME_MAPPING) {
    globalThis.ATOMIC_SUBJECT_TO_NAME_MAPPING = new Map<string, string>();
  }

  for (const ontology of ontologies) {
    for (const [key, value] of Object.entries(ontology.properties)) {
      globalThis.ATOMIC_SUBJECT_TO_NAME_MAPPING.set(value, key);
    }
  }

  if (!globalThis.ATOMIC_CLASS_DEFS) {
    globalThis.ATOMIC_CLASS_DEFS = new Map<string, Record<string, string>>();
  }

  for (const ontology of ontologies) {
    if (!ontology.__classDefs) {
      throw new Error(
        'Outdated ontology format, update your ontologies using @tomic/cli',
      );
    }

    for (const [key, value] of Object.entries(ontology.__classDefs)) {
      const classDef = Object.fromEntries(
        value.map(subject => [getKnownNameBySubject(subject), subject]),
      );
      globalThis.ATOMIC_CLASS_DEFS.set(key, classDef);
    }
  }
}

export function getKnownNameBySubject(subject: string): string | undefined {
  return globalThis.ATOMIC_SUBJECT_TO_NAME_MAPPING.get(subject);
}

export function getKnownClassDefBySubject(
  subject: string,
): Map<string, Record<string, string>> {
  return globalThis.ATOMIC_CLASS_DEFS.get(subject);
}

export function __INTERNAL_GET_KNOWN_SUBJECT_MAPPING(): Map<string, string> {
  return globalThis.ATOMIC_SUBJECT_TO_NAME_MAPPING;
}
