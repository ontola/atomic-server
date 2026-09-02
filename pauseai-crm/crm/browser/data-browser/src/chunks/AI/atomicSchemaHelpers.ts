// @wc-ignore-file
import { core, type Core, type Store } from '@tomic/react';

export const toClassString = async (subject: string, store: Store) => {
  const resource = await store.getResource<Core.Class>(subject);

  if (resource.error || resource.loading) {
    return `Could not read class: ${subject}`;
  }

  const requiredLines = await Promise.all(
    (resource.props.requires ?? []).map((prop: string) =>
      toPropertyLine(prop, store),
    ),
  );

  const recommendedLines = await Promise.all(
    (resource.props.recommends ?? []).map((prop: string) =>
      toPropertyLine(prop, store),
    ),
  );

  return `Class ${resource.title} has the following properties:
Required:
${requiredLines.join('\n') || 'None'}

Optional:
${recommendedLines.join('\n') || 'None'}`;
};

export const toPropertyLine = async (subject: string, store: Store) => {
  const resource = await store.getResource(subject);

  if (resource.error || resource.loading) {
    return `Could not read property: ${subject}`;
  }

  return `- ${resource.title} (${subject})`;
};

export async function toClassObject(subject: string, store: Store) {
  const resource = await store.getResource<Core.Class>(subject);

  if (resource.error || resource.loading) {
    return `Could not read class: ${subject}`;
  }

  return {
    subject,
    shortname: resource.props.shortname,
    description: resource.props.description,
    required: await Promise.all(
      (resource.props.requires ?? []).map(prop =>
        toPropertyObject(prop, store),
      ),
    ),
    recommended: await Promise.all(
      (resource.props.recommends ?? []).map(prop =>
        toPropertyObject(prop, store),
      ),
    ),
  };
}

export async function getClassesOnDrive(
  drive: string,
  store: Store,
): Promise<string[]> {
  return store.search('', {
    filters: {
      [core.properties.isA]: core.classes.class,
    },
    parents: [drive],
    include: true,
    limit: 1000,
  });
}

async function toPropertyObject(subject: string, store: Store) {
  const resource = await store.getResource<Core.Property>(subject);

  if (resource.error || resource.loading) {
    return `Could not read property: ${subject}`;
  }

  return {
    subject,
    shortname: resource.props.shortname,
    datatype: resource.props.datatype,
  };
}
