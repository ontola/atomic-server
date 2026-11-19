import { useWebsiteClass } from '@chunks/Website/useWebsiteClass';
import {
  isSyncablesPlatformRoot,
  withoutTableViews,
} from '@chunks/PluginRuns/syncablesNavigation';
import { useSyncablesNavigation } from '@chunks/PluginRuns/useSyncablesNavigation';
import { findSyncableLegacyAccounts } from '@chunks/PluginRuns/syncablePlatform';
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ai,
  core,
  dataBrowser,
  forms,
  notifications,
  useResourceSnapshot,
  useStore,
  useCanWrite,
  unknownSubject,
} from '@tomic/react';
import { useChildren } from '@tomic/react';
// Evaluated here, ahead of the row's context menu, on purpose: the module cycle
// routes > Dropdown > ResourceContextMenu only loads in an order that works
// when this comes first ("Cannot access 'DIVIDER' before initialization").
import '../../../helpers/useCurrentSubject';
import { useAncestryIfAncestor, useIsCurrentSubject } from './SidebarSelection';
import { SideBarItem } from '../SideBarItem';
import { AtomicLink } from '../../AtomicLink';
import { styled } from 'styled-components';
import { Details } from '../../Details';
import { errorLookStyle } from '../../ErrorLook';
import { LoaderInline } from '../../Loader';
import { FaTriangleExclamation } from 'react-icons/fa6';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { SidebarItemTitle } from './SidebarItemTitle';
import { TextWrapper } from './shared';
import { DropEdge } from './DropEdge';
import { SIDEBAR_CHILD_LIMIT, SideBarMoreRow } from '../SideBarMoreRow';
import { SideBarDragData, SideBarDropData } from '../useSidebarDnd';
import { transparentize } from 'polished';
import { transition } from '../../../helpers/transition';

interface ResourceSideBarProps {
  subject: string;
  renderedHierarchy: string[];
  /** When a SideBar item is clicked, we should close the SideBar (on mobile devices) */
  onClick?: () => unknown;
}

/** Renders a Resource as a nav item for in the sidebar. */
export const ResourceSideBar: React.FC<ResourceSideBarProps> = memo(
  ({ subject, renderedHierarchy, onClick }) => {
    if (renderedHierarchy.length === 0) {
      throw new Error('renderedHierarchy should not be empty');
    }

    // Prevent infinite recursion: stop if we've already rendered this subject
    // in the hierarchy, or if we're too deep.
    const MAX_DEPTH = 10;

    const recursive =
      renderedHierarchy.includes(subject) ||
      renderedHierarchy.length > MAX_DEPTH;

    const snapshot = useResourceSnapshot(subject, { allowIncomplete: true });
    const resource = snapshot.resource;
    const syncableNavigation = useSyncablesNavigation(resource);
    const store = useStore();
    const drive = store.getDrive();
    const canWrite = useCanWrite(resource);
    const active = useIsCurrentSubject(subject);
    const ancestryWhenAncestor = useAncestryIfAncestor(subject);
    const [open, setOpen] = useState(active);

    // Ordinary tables show rows in the grid. Syncables directory tables hold
    // navigable resources. Other views such as chatrooms and forms present
    // their children in their own UI.
    //
    // `allowIncomplete` means `classes` is `[]` until `isA` hydrates. Treat
    // that as hidden too: otherwise `useChildren` fetches every table row
    // into the tree, then hides them when the class arrives — the sidebar
    // flash on open.
    const {
      classes,
      isTable,
      isDirectory,
      isPlatformRoot,
      navigationDecorations,
    } = useMemo(() => {
      const current = snapshot.resource;
      const currentClasses = current.getClasses();
      const table = currentClasses.includes(dataBrowser.classes.table);
      const directory = table && syncableNavigation.isDirectory;
      const icon = current.get(dataBrowser.properties.icon);

      return {
        classes: currentClasses,
        isTable: table,
        isDirectory: directory,
        isPlatformRoot: isSyncablesPlatformRoot(
          current.get(core.properties.localId),
        ),
        // An app's icon is stored alongside its data, but is not a folder to browse.
        navigationDecorations: [
          ...(directory ||
          isSyncablesPlatformRoot(current.get(core.properties.localId))
            ? current.getSubjects(dataBrowser.properties.tableViews)
            : []),
          ...(typeof icon === 'string' ? [icon] : []),
        ],
      };
    }, [snapshot, syncableNavigation.isDirectory]);
    const [legacyNavigation, setLegacyNavigation] = useState<{
      snapshot: typeof snapshot;
      drive: string;
      hidden?: string;
    }>();
    const legacySnapshot = useResourceSnapshot(
      legacyNavigation?.hidden ?? unknownSubject,
      { allowIncomplete: true },
    );
    useEffect(() => {
      if (!isPlatformRoot || !drive || snapshot.loading || snapshot.error)
        return;
      let cancelled = false;
      void findSyncableLegacyAccounts(store, drive, subject)
        .then(hidden => {
          if (!cancelled) setLegacyNavigation({ snapshot, drive, hidden });
        })
        .catch(() => {
          // A failed validation must never hide an unrelated user resource.
          if (!cancelled) setLegacyNavigation({ snapshot, drive });
        });

      return () => {
        cancelled = true;
      };
    }, [store, drive, subject, snapshot, isPlatformRoot, legacySnapshot]);
    const validatingLegacy =
      isPlatformRoot &&
      (legacyNavigation?.snapshot !== snapshot ||
        legacyNavigation?.drive !== drive);
    const hiddenNavigation = [
      ...navigationDecorations,
      ...(isPlatformRoot && legacyNavigation?.hidden
        ? [legacyNavigation.hidden]
        : []),
    ];
    const websiteClass = useWebsiteClass(classes.join('|'));
    const hideChildren =
      recursive ||
      validatingLegacy ||
      !!websiteClass ||
      classes.length === 0 ||
      (isTable && !isDirectory) ||
      classes.includes(dataBrowser.classes.chatroom) ||
      classes.includes(dataBrowser.classes.meeting) ||
      classes.includes(ai.classes.aiChat) ||
      classes.includes(core.classes.ontology) ||
      classes.includes(forms.classes.form);
    const hideDropTargets = hideChildren || isTable;

    const { subjects: children, total } = useChildren(
      hideChildren ? undefined : subject,
      { limit: SIDEBAR_CHILD_LIMIT + hiddenNavigation.length },
    );
    const visibleChildren = withoutTableViews(children, hiddenNavigation);
    const totalChildren = total - (children.length - visibleChildren.length);
    const subResources =
      visibleChildren.length > SIDEBAR_CHILD_LIMIT
        ? visibleChildren.slice(0, SIDEBAR_CHILD_LIMIT)
        : visibleChildren;

    const dragData: SideBarDragData = {
      renderedUnder: renderedHierarchy.at(-1)!,
    };

    const {
      setNodeRef,
      listeners,
      attributes,
      over,
      active: draggingNode,
    } = useDraggable({
      id: subject,
      data: dragData,
      disabled: !canWrite,
    });

    // "Drop onto folder" target: the whole row accepts drops, setting
    // this resource as the dragged item's parent. The drop sits at the
    // *end* of this folder's children — `prevSubject = last child` so
    // the handler computes `sortOrder = lastSibling.sortOrder + 1`.
    //
    // Disable when:
    //  - the user can't write here,
    //  - this row IS the dragged item (drop-on-self),
    //  - an ancestor of this row is being dragged (would create a cycle),
    //  - this row owns app data (such as table rows or chat messages).
    const draggedId = draggingNode?.id as string | undefined;
    const dropDisabled =
      !canWrite ||
      hideDropTargets ||
      (!!draggedId &&
        (draggedId === subject || renderedHierarchy.includes(draggedId)));
    const dropData: SideBarDropData = {
      parent: subject,
      prevSubject: subResources.at(-1),
      nextSubject: undefined,
    };
    const { setNodeRef: setDropNodeRef } = useDroppable({
      id: `${subject}-into`,
      data: dropData,
      disabled: dropDisabled,
    });

    const setItemRef = useCallback(
      (node: HTMLAnchorElement | null) => {
        setNodeRef(node);
        setDropNodeRef(node);
      },
      [setNodeRef, setDropNodeRef],
    );

    const hasSubResources = subResources.length > 0;

    const toggleExpanded = useCallback(() => setOpen(prev => !prev), []);

    const TitleComp = useMemo(
      () => (
        <SidebarItemTitle
          subject={subject}
          active={active}
          onClick={onClick}
          ref={setItemRef}
          listeners={canWrite ? listeners : undefined}
          attributes={canWrite ? attributes : undefined}
          expandable={hasSubResources}
          expanded={open}
          onToggleExpand={hasSubResources ? toggleExpanded : undefined}
        />
      ),
      [
        subject,
        active,
        onClick,
        listeners,
        attributes,
        canWrite,
        setItemRef,
        hasSubResources,
        open,
        toggleExpanded,
      ],
    );
    const isDragging = draggingNode?.id === subject;
    const isHoveringOver = over?.data.current?.parent === subject;
    const hierarchyWithItself = useMemo(
      () => [...renderedHierarchy, subject],
      [renderedHierarchy, subject],
    );

    useEffect(() => {
      if (isDragging) {
        setOpen(false);
      }
    }, [isDragging]);

    useEffect(() => {
      if (ancestryWhenAncestor) {
        setOpen(true);
      }
    }, [ancestryWhenAncestor]);

    if (recursive || !subject || subject === unknownSubject) {
      return null;
    }

    // App data, not content: reached from Notifications, never the tree.
    if (
      classes.includes(notifications.classes.inbox) ||
      classes.includes(notifications.classes.notification)
    ) {
      return null;
    }

    if (snapshot.loading) {
      return (
        <TreeLoadingRow
          onClick={onClick}
          disabled={active}
          resource={subject}
          title={`${subject} is loading...`}
        >
          <LoaderInline />
        </TreeLoadingRow>
      );
    }

    if (snapshot.error) {
      return (
        <StyledLink subject={subject} clean>
          <TreeLoadingRow
            onClick={onClick}
            disabled={active}
            resource={subject}
          >
            <SideBarErrorWrapper>
              <FaTriangleExclamation />
              <span>Resource with error</span>
            </SideBarErrorWrapper>
          </TreeLoadingRow>
        </StyledLink>
      );
    }

    return (
      <Wrapper highlight={isHoveringOver}>
        <Details
          initialState={open}
          open={open}
          disabled={!hasSubResources}
          onStateToggle={setOpen}
          data-test='resource-sidebar'
          showCaret={false}
          summaryClickable={false}
          title={TitleComp}
        >
          {hasSubResources && (
            <>
              {!hideDropTargets && (
                <DropEdge
                  parentHierarchy={hierarchyWithItself}
                  index={0}
                  prevSubject={undefined}
                  nextSubject={subResources[0]}
                />
              )}
              {subResources.map((child, idx) => (
                <Fragment key={child}>
                  <ResourceSideBar
                    subject={child}
                    renderedHierarchy={hierarchyWithItself}
                    onClick={onClick}
                  />
                  {!hideDropTargets && (
                    <DropEdge
                      parentHierarchy={hierarchyWithItself}
                      index={idx + 1}
                      prevSubject={child}
                      nextSubject={subResources[idx + 1]}
                    />
                  )}
                </Fragment>
              ))}
              {totalChildren > subResources.length && (
                <SideBarMoreRow
                  parent={subject}
                  hidden={totalChildren - subResources.length}
                  onClick={onClick}
                />
              )}
            </>
          )}
        </Details>
      </Wrapper>
    );
  },
);

const Wrapper = styled.div<{ highlight: boolean }>`
  background-color: ${p =>
    p.highlight ? transparentize(0.9, p.theme.colors.main) : 'none'};

  border-radius: ${({ theme }) => theme.radius};
  ${transition('background-color')}
`;

const TreeLoadingRow = styled(SideBarItem)`
  box-sizing: border-box;
  width: 100%;
`;

const StyledLink = styled(AtomicLink)`
  box-sizing: border-box;
  display: block;
  width: 100%;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
`;

const SideBarErrorWrapper = styled(TextWrapper)`
  margin-left: 1.3rem;
  ${errorLookStyle}
`;
