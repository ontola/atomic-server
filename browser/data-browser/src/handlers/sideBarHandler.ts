import {
  Resource,
  Store,
  isString,
  dataBrowser,
  core,
  CollectionBuilder,
} from '@tomic/react';

export function buildSideBarNewResourceHandler(store: Store) {
  // When a resource is saved add it to the parents subResources list if it's not already there.
  return async (resource: Resource) => {
    const parentSubject = resource.get(core.properties.parent);

    if (!isString(parentSubject)) {
      throw new Error(`Resource doesn't have a parent: ${resource.subject} `);
    }

    const parent = await store.getResource(parentSubject);
    const subResources = parent.getSubjects(
      dataBrowser.properties.subResources,
    );

    if (subResources.includes(resource.subject)) {
      return;
    }

    parent.push(dataBrowser.properties.subResources, [resource.subject]);

    await parent.save();
  };
}

export function buildSideBarRemoveResourceHandler(store: Store) {
  // When a resource is deleted remove it from the parents subResources list.
  return async (subject: string) => {
    // Temporary subjects are never persisted in subResources lists.
    if (subject.startsWith('_new:') || subject.startsWith('_local:')) {
      return;
    }

    const collection = new CollectionBuilder(store)
      .setProperty(dataBrowser.properties.subResources)
      .setValue(subject)
      .build();

    for await (const member of collection) {
      try {
        const resource = await store.getResource(member);

        if (!(await resource.canWrite(store.getAgent()?.subject))) {
          continue;
        }

        const subResources = resource.getArray(
          dataBrowser.properties.subResources,
        ) as string[];

        await resource.set(
          dataBrowser.properties.subResources,
          subResources.filter(r => r !== subject),
        );

        await resource.save();
      } catch (e) {
        console.error('Error removing resource from parent', e);
      }
    }
  };
}
