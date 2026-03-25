import { useSettings } from '@helpers/AppSettings';
import { core, useStore, type Core, type Store } from '@tomic/react';

interface RAGMetadata {
  title: string;
  classes?: string[];
}

export type GetRelevantResources = (prompt: string) => Promise<string>;

export function useRAG(): GetRelevantResources {
  const store = useStore();
  const { drive } = useSettings();

  const getRAGData = async (prompt: string) => {
    const chunkData = await store.semanticSearch(prompt, {
      parents: drive,
      rerank: true,
    });

    const text = await Promise.all(
      chunkData.slice(0, 5).map(async chunk => {
        const meta = await getMetaData(chunk.subject, store);

        return toText(chunk.subject, chunk.chunk, meta);
      }),
    );

    return text.join('\n------\n');
  };

  return getRAGData;
}

const getMetaData = async (
  subject: string,
  store: Store,
): Promise<{ title: string; classes?: string[] } | undefined> => {
  const resource = await store.getResource(subject);
  const classSubjects = resource.get(core.properties.isA);

  if (resource.error || resource.loading) {
    return undefined;
  }

  if (!classSubjects) {
    return { title: resource.title };
  }

  const classes = [];

  for (const classSubject of classSubjects) {
    const classResource = await store.getResource<Core.Class>(classSubject);

    if (classResource.error || classResource.loading) {
      continue;
    }

    classes.push(classResource.title);
  }

  return { title: resource.title, classes: classes };
};

const toText = (subject: string, text: string, metadata?: RAGMetadata) => {
  const title =
    metadata?.title && metadata.title !== subject
      ? `title: ${metadata.title}\n`
      : '';
  const classes =
    metadata?.classes && metadata.classes.length > 0
      ? `classes: ${metadata.classes.join(', ')}\n`
      : '';

  return `subject: ${subject}\n${title}${classes}relevant Text: ${text}`;
};
