import { useSettings } from '@helpers/AppSettings';
import { dataBrowser, useStore } from '@tomic/react';

export type TreeElement = {
  subject: string;
  children?: TreeNode;
};

export type TreeNode = {
  [title: string]: TreeElement;
};

/** Serializes a TreeNode into a string optimized for LLM agents (indented list with subjects) */
export function stringifyTree(tree: TreeNode, indent = 0): string {
  return Object.entries(tree)
    .map(([title, { subject, children }]) => {
      const prefix = '  '.repeat(indent);
      const line = `${prefix}- ${title} (${subject})`;

      if (children) {
        return `${line}\n${stringifyTree(children, indent + 1)}`;
      }

      return line;
    })
    .join('\n');
}

export function useGetDriveStructure() {
  const store = useStore();
  const { drive } = useSettings();

  const buildTree = async (
    subjects: string[],
    visited: Set<string>,
  ): Promise<TreeNode> => {
    const node: TreeNode = {};

    const resources = await Promise.all(
      subjects.map(subject => store.getResource(subject)),
    );

    for (const resource of resources) {
      const subject = resource.subject;

      if (visited.has(subject)) {
        continue;
      }

      visited.add(subject);

      const subResources =
        (resource.get(dataBrowser.properties.subResources) as string[]) || [];

      const title = resource.title;

      const element: TreeElement = {
        subject,
      };

      if (subResources.length > 0) {
        element.children = await buildTree(subResources, visited);
      }

      node[title] = element;
    }

    return node;
  };

  return async (): Promise<TreeNode> => {
    const driveResource = await store.getResource(drive);
    const rootSubjects =
      (driveResource.get(dataBrowser.properties.subResources) as string[]) || [];

    return buildTree(rootSubjects, new Set([drive]));
  };
}
