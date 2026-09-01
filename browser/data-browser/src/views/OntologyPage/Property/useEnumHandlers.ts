import {
  Resource,
  Core,
  core,
  useArray,
  useStore,
  Store,
  DataBrowser,
} from '@tomic/react';
import { useCallback } from 'react';

export function useEnumHandlers(
  property: Resource<Core.Property>,
  ontology: Resource<Core.Ontology>,
) {
  const store = useStore();

  const [, , pushAllowsOnly, removeAllowsOnly] = useArray(
    property,
    core.properties.allowsOnly,
    { commit: true },
  );
  const [, , pushInstances, removeInstances] = useArray(
    ontology,
    core.properties.instances,
    { commit: true },
  );

  const addTag = useCallback(
    async (tag: Resource) => {
      pushAllowsOnly([tag.subject]);
      pushInstances([tag.subject]);

      await tag.save();
    },
    [pushAllowsOnly, pushInstances],
  );

  const removeTag = useCallback(
    async (subject: string) => {
      removeAllowsOnly([subject]);

      // If the tag is not used in any other property, remove from ontology and delete it.
      if (!(await isTagUsed(subject, ontology, store))) {
        removeInstances([subject]);
        await store.getResourceLoading(subject).destroy();
      }
    },
    [removeAllowsOnly, removeInstances, ontology, store],
  );

  return {
    addTag,
    removeTag,
  };
}

const isTagUsed = async (
  tagSubject: string,
  ontology: Resource<Core.Ontology>,
  store: Store,
) => {
  const tag = store.getResourceLoading<DataBrowser.Tag>(tagSubject);

  if (tag.props.parent !== ontology.subject) {
    return true;
  }

  for (const property of ontology.props.properties ?? []) {
    const propertyResource = await store.getResource(property);

    if (propertyResource.props.allowsOnly?.includes(tagSubject)) {
      return true;
    }
  }

  return false;
};
