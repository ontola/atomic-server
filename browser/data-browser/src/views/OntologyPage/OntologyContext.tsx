import { core, Resource, unknownSubject, urls, useArray } from '@tomic/react';
import { createContext, useCallback, useContext, useMemo } from 'react';

interface OntologyContext {
  addClass: (subject: string) => Promise<void>;
  removeClass: (subject: string) => Promise<void>;
  addProperty: (subject: string) => Promise<void>;
  removeProperty: (subject: string) => Promise<void>;
  hasProperty: (subject: string) => boolean;
  hasClass: (subject: string) => boolean;
  ontology: Resource;
}

export const OntologyContext = createContext<OntologyContext | undefined>({
  addClass: () => Promise.resolve(),
  removeClass: () => Promise.resolve(),
  addProperty: () => Promise.resolve(),
  removeProperty: () => Promise.resolve(),
  hasProperty: () => false,
  hasClass: () => false,
  ontology: new Resource(unknownSubject),
});

interface OntologyContextProviderProps {
  ontology: Resource;
}

export function OntologyContextProvider({
  ontology,
  children,
}: React.PropsWithChildren<OntologyContextProviderProps>) {
  const [classes, , pushClasses, removeClasses] = useArray(
    ontology,
    core.properties.classes,
    {
      commit: true,
    },
  );

  const [properties, , pushProperties, removeProperties] = useArray(
    ontology,
    urls.properties.properties,
    { commit: true },
  );

  const addClass = useCallback(
    async (subject: string) => {
      pushClasses([subject]);
    },
    [pushClasses],
  );

  const removeClass = useCallback(
    async (subject: string) => {
      removeClasses([subject]);
    },
    [removeClasses],
  );

  const addProperty = useCallback(
    async (subject: string) => {
      pushProperties([subject]);
    },
    [pushProperties],
  );

  const removeProperty = useCallback(
    async (subject: string) => {
      removeProperties([subject]);
    },
    [removeProperties],
  );

  const hasProperty = useCallback(
    (subject: string): boolean => properties.includes(subject),
    [properties],
  );

  const hasClass = useCallback(
    (subject: string): boolean => classes.includes(subject),
    [classes],
  );

  const context = useMemo(
    () => ({
      addClass,
      removeClass,
      addProperty,
      removeProperty,
      hasProperty,
      hasClass,
      ontology,
    }),
    [
      addClass,
      removeClass,
      addProperty,
      removeProperty,
      hasProperty,
      hasClass,
      ontology,
    ],
  );

  return (
    <OntologyContext.Provider value={context}>
      {children}
    </OntologyContext.Provider>
  );
}

export function useOntologyContext(): OntologyContext {
  return useContext(OntologyContext)!;
}
