import { useSettings } from '@helpers/AppSettings';
import {
  isSyncablesNavigationTable,
  isSyncablesPlatformRoot,
  withoutTableViews,
} from '@chunks/PluginRuns/syncablesNavigation';
import { syncableHierarchySchema } from '@chunks/PluginRuns/syncableHierarchy';
import { readHiddenSyncableSetups } from '@chunks/PluginRuns/syncableSetupVisibility';
import { canonicalizeScheme } from '@tomic/lib';
import { shortenSubject } from '@tomic/react';
import {
  ai,
  CollectionBuilder,
  core,
  dataBrowser,
  findSchema,
  isCommitSubject,
  useStore,
  type Store,
} from '@tomic/react';

export type TreeElement = {
  subject: string;
  children?: TreeNode;
};

export type TreeNode = {
  [title: string]: TreeElement;
};

/** Serializes a TreeNode into a string optimized for LLM agents (indented
 *  list with short subject refs — also seeds the ref registry every turn). */
export function stringifyTree(tree: TreeNode, indent = 0): string {
  return Object.entries(tree)
    .map(([title, { subject, children }]) => {
      const prefix = '  '.repeat(indent);
      const line = `${prefix}- ${title} (${shortenSubject(subject)})`;

      if (children) {
        return `${line}\n${stringifyTree(children, indent + 1)}`;
      }

      return line;
    })
    .join('\n');
}

/** Fetches a resource's direct children via the `parent=` query — the same
 *  source of truth the sidebar uses. (The legacy `sub-resources` array this
 *  used to read is not maintained by normal resource creation, so the tree
 *  missed almost everything.) */
async function fetchChildren(store: Store, parent: string): Promise<string[]> {
  const collection = new CollectionBuilder(store)
    .setProperty(core.properties.parent)
    .setValue(parent)
    .setPageSize(500)
    .build();

  const members = await collection.getAllMembers();

  return members.filter(subject => !isCommitSubject(subject));
}

/** Resources that present their own children in dedicated UI; recursing into
 *  them (table rows, chat messages) would flood the tree. Same set the
 *  sidebar hides children for — including "class not loaded yet", so a
 *  table's rows don't flash in the tree before `isA` arrives. */
function hideChildrenOf(classes: string[], isDirectory: boolean): boolean {
  return (
    classes.length === 0 ||
    (classes.includes(dataBrowser.classes.table) && !isDirectory) ||
    classes.includes(dataBrowser.classes.chatroom) ||
    classes.includes(dataBrowser.classes.meeting) ||
    classes.includes(ai.classes.aiChat) ||
    classes.includes(core.classes.ontology)
  );
}

export function useGetDriveStructure() {
  const store = useStore();
  const { drive } = useSettings();

  const buildTree = async (
    subjects: string[],
    visited: Set<string>,
    getSourceKeyProperty: () => Promise<string | undefined>,
    hidden: ReadonlySet<string>,
  ): Promise<TreeNode> => {
    const node: TreeNode = {};

    const resources = await Promise.all(
      subjects.map(subject => store.getResource(subject)),
    );

    for (const resource of resources) {
      const subject = resource.subject;

      if (hidden.has(canonicalizeScheme(subject))) continue;

      if (visited.has(subject)) {
        continue;
      }

      visited.add(subject);

      const element: TreeElement = {
        subject,
      };

      const classes = resource.getClasses();
      const localId = resource.get(core.properties.localId);
      const legacyDirectory =
        classes.includes(dataBrowser.classes.table) &&
        isSyncablesNavigationTable(localId);
      const keyProperty =
        legacyDirectory && !isSyncablesPlatformRoot(localId)
          ? await getSourceKeyProperty()
          : undefined;
      const isDirectory =
        legacyDirectory &&
        isSyncablesNavigationTable(
          localId,
          keyProperty ? resource.get(keyProperty) : undefined,
        );

      if (!hideChildrenOf(classes, isDirectory)) {
        const children = await fetchChildren(store, subject);
        const visibleChildren = isDirectory
          ? withoutTableViews(
              children,
              resource.getSubjects(dataBrowser.properties.tableViews),
            )
          : children;

        if (visibleChildren.length > 0) {
          element.children = await buildTree(
            visibleChildren,
            visited,
            getSourceKeyProperty,
            hidden,
          );
        }
      }

      node[resource.title] = element;
    }

    return node;
  };

  return async (): Promise<TreeNode> => {
    let sourceKeyProperty: Promise<string | undefined> | undefined;

    const getSourceKeyProperty = () => {
      if (!sourceKeyProperty)
        sourceKeyProperty = findSchema(store, drive, syncableHierarchySchema())
          .then(terms => terms.properties?.['syncable-source-key'])
          .catch(() => undefined);

      return sourceKeyProperty;
    };

    const rootSubjects = await fetchChildren(store, drive);

    const hidden = await readHiddenSyncableSetups(store, drive).catch(
      () => new Set<string>(),
    );

    return buildTree(
      rootSubjects,
      new Set([drive]),
      getSourceKeyProperty,
      hidden,
    );
  };
}
