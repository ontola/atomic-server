import {
  core,
  dataBrowser,
  type DataBrowser,
  type Resource,
  type Store,
} from '@tomic/react';
import type { JSONContent } from '@tiptap/core';

const resourceToContentItem = (resource: Resource) => ({
  type: 'atomic-data-resource',
  attrs: {
    subject: resource.subject,
  },
});

export async function upgradeDocument(
  resource: Resource<DataBrowser.Document>,
  store: Store,
) {
  const { MarkdownManager } = await import('@tiptap/markdown');
  const { getCollaborativeEditorSchema } = await import(
    '@chunks/RTE/getCollaborativeEditorSchema'
  );
  const { prosemirrorJSONToYXmlFragment } = await import('@tiptap/y-tiptap');

  const { schema, extensions } = getCollaborativeEditorSchema(store);

  const mdManager = new MarkdownManager({ extensions });

  const elements = (
    await Promise.allSettled(
      (resource.props.elements ?? []).map(element =>
        store.getResource(element),
      ),
    )
  )
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value);

  let tiptapContent: JSONContent[] = [];
  let paragraphs: Resource[] = [];

  for (const element of elements) {
    if (element.hasClasses(dataBrowser.classes.paragraph)) {
      const description = element.get(core.properties.description);

      if (element.props.parent === resource.subject) {
        paragraphs.push(element);
      }

      if (!description) {
        continue;
      }

      const parsed = mdManager.parse(description);

      if (!parsed.content) {
        continue;
      }

      tiptapContent.push(...parsed.content);
    } else {
      tiptapContent.push(resourceToContentItem(element));
    }
  }

  const tiptapDoc = {
    type: 'doc',
    content: tiptapContent,
  };

  // Upgrade the resource
  const yDoc = resource.getYDoc(dataBrowser.properties.documentContent);

  const fragment = yDoc.getXmlFragment('content');

  prosemirrorJSONToYXmlFragment(schema, tiptapDoc, fragment);

  resource.remove(dataBrowser.properties.elements);
  await resource.set(core.properties.isA, [dataBrowser.classes.documentV2]);

  await resource.save();

  for (const paragraph of paragraphs) {
    await paragraph.destroy();
  }
}
