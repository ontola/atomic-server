import { core, useResource, useString, type Resource } from '@tomic/react';

/**
 * Human name of a resource's class, e.g. "Document" or "Folder", for copy like
 * "Share Document". Falls back to "Resource" while the class loads.
 */
export function useClassLabel(resource: Resource): string {
  const classResource = useResource(resource.getClasses()[0]);
  const [shortname] = useString(classResource, core.properties.shortname);

  if (!shortname) return 'Resource';

  // `document-v2` is still a Document to the person sharing it.
  const words = shortname
    .replace(/[-_]?v\d+$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  return words.charAt(0).toUpperCase() + words.slice(1);
}
