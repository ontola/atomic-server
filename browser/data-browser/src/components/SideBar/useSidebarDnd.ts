import {
  Announcements,
  DragEndEvent,
  DragStartEvent,
  DropAnimationFunction,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { commits, core, dataBrowser, Resource, useStore } from '@tomic/react';
import { useCallback, useState } from 'react';
import {
  SIDEBAR_TRANSITION_TAG,
  getTransitionName,
} from '../../helpers/transitionName';
import { useSettings } from '../../helpers/AppSettings';

/**
 * Data attached to a sidebar drop target.
 *
 * `parent` — the resource the dragged item should become (or stay) a child
 * of. For a "drop onto folder row" target this is that row's subject; for
 * a `DropEdge` it's the parent that owns the two surrounding siblings.
 *
 * `prevSubject` / `nextSubject` — the subjects immediately above and below
 * this drop point. The drag handler uses their `sortOrder` (or
 * `createdAt` as fallback) to compute a fractional sort key for the
 * dragged item, so only one resource needs to be re-saved per reorder.
 * `undefined` on either side means "drop at the start / end of the
 * parent's children". A "drop onto row" target has `prevSubject` set to
 * that row's last child (if any) and `nextSubject` undefined — i.e.
 * "append at end".
 */
export type SideBarDropData = {
  parent: string;
  prevSubject?: string;
  nextSubject?: string;
};

export type SideBarDragData = {
  renderedUnder: string;
};

/**
 * Resolve a resource's sort key: its explicit `sortOrder` if set, else
 * `createdAt` (which is what the server query returns siblings sorted
 * by, and what `useChildren` uses as the implicit fallback). Returns
 * `undefined` if neither is available — the caller picks a default.
 */
function readSortKey(resource: Resource | undefined): number | undefined {
  if (!resource) return undefined;
  const explicit = resource.get(dataBrowser.properties.sortOrder);
  if (typeof explicit === 'number') return explicit;
  const createdAt = resource.get(commits.properties.createdAt);
  if (typeof createdAt === 'number') return createdAt;

  return undefined;
}

/**
 * Compute the fractional `sortOrder` to assign to a dragged resource
 * given its new neighbors. Mirrors the classic fractional-index pattern
 * — midpoint when both neighbors exist; offset by 1 when only one does.
 *
 * The `±1` step at the ends is arbitrary but big enough that subsequent
 * drops on the same side still get sub-second resolution (next midpoint
 * is `±0.5`, then `±0.25`, …).
 */
function computeSortOrder(
  prevKey: number | undefined,
  nextKey: number | undefined,
): number {
  if (prevKey !== undefined && nextKey !== undefined) {
    return (prevKey + nextKey) / 2;
  }

  if (prevKey !== undefined) {
    // Drop at end — must come after `prev`.
    return prevKey + 1;
  }

  if (nextKey !== undefined) {
    // Drop at start — must come before `next`.
    return nextKey - 1;
  }

  // Empty folder — any value works; align with the implicit createdAt
  // axis so future drops sit naturally.
  return Date.now();
}

export const useSidebarDnd = (
  onIsRearangingChange: (isRearanging: boolean) => void,
) => {
  const store = useStore();
  const { sidebarKeyboardDndEnabled } = useSettings();

  const keyboardSensor = useSensor(KeyboardSensor);

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 10,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    }),
    sidebarKeyboardDndEnabled ? keyboardSensor : undefined,
  );

  const [draggingResource, setDraggingResource] = useState<string>();
  const [waitForSavePromise, setWaitForSavePromise] = useState<Promise<void>>();

  const animateDrop: DropAnimationFunction = useCallback(
    ({ active, dragOverlay, transform }) => {
      if (!active || !dragOverlay) {
        return;
      }

      return new Promise(resolve => {
        waitForSavePromise?.then(() => {
          const targetNode = document.querySelector(
            `[data-sidebar-id="${getTransitionName(
              SIDEBAR_TRANSITION_TAG,
              active.id as string,
            )}"]`,
          ) as HTMLElement;

          if (!targetNode) {
            return resolve();
          }

          targetNode.style.opacity = '0';

          const { top: originTop, left: originLeft } = dragOverlay.rect;
          const { x: originTransformX, y: originTransformY } = transform;

          const { top: targetTop, left: targetLeft } =
            targetNode.getBoundingClientRect();

          const targetTransformX = targetLeft - originLeft + originTransformX;
          const targetTransformY = targetTop - originTop + originTransformY;

          const dropAnimation = dragOverlay.node.animate(
            [
              {
                transform: `translate(${originTransformX}px, ${originTransformY}px)`,
              },
              {
                transform: `translate(${targetTransformX}px, ${targetTransformY}px)`,
              },
            ],
            {
              duration: 300,
              easing: 'cubic-bezier(0.2, 0, 0, 1)',
            },
          );

          dropAnimation.onfinish = () => {
            targetNode.style.opacity = '1';
            resolve();
          };
        });
      });
    },
    [waitForSavePromise],
  );

  const handleDragStart = (event: DragStartEvent) => {
    onIsRearangingChange(true);
    setDraggingResource(event.active.id as string);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    if (!event.over) {
      setDraggingResource(undefined);
      onIsRearangingChange(false);
      setWaitForSavePromise(Promise.resolve());

      return;
    }

    const subject = event.active.id as string;
    const { renderedUnder } = event.active.data
      .current as unknown as SideBarDragData;
    const {
      parent: dropParent,
      prevSubject,
      nextSubject,
    } = event.over.data.current as unknown as SideBarDropData;

    const resource = store.getResourceLoading(subject);

    // The user should not be able to nest a folder inside itself.
    if (subject === dropParent) {
      onIsRearangingChange(false);
      setDraggingResource(undefined);
      setWaitForSavePromise(Promise.resolve());

      return;
    }

    // Dragged neighbor cases: if the drop point is immediately above or
    // below the dragged item itself within the same parent, that's a
    // no-op move — bail out so we don't write a redundant sortOrder.
    if (
      renderedUnder === dropParent &&
      (prevSubject === subject || nextSubject === subject)
    ) {
      setDraggingResource(undefined);
      onIsRearangingChange(false);
      setWaitForSavePromise(Promise.resolve());

      return;
    }

    const prevResource = prevSubject
      ? store.getResourceLoading(prevSubject)
      : undefined;
    const nextResource = nextSubject
      ? store.getResourceLoading(nextSubject)
      : undefined;

    const newSortOrder = computeSortOrder(
      readSortKey(prevResource),
      readSortKey(nextResource),
    );

    const promise = (async () => {
      // Re-parent if necessary. The live `useChildren` query on the new
      // parent picks up the change automatically.
      if (renderedUnder !== dropParent) {
        await resource.set(core.properties.parent, dropParent);
      }

      await resource.set(dataBrowser.properties.sortOrder, newSortOrder);
      await resource.save();
    })();

    setWaitForSavePromise(promise);
    await promise;
    setDraggingResource(undefined);
    onIsRearangingChange(false);
  };

  const dndExplanation: string = sidebarKeyboardDndEnabled
    ? 'To rearange items, press space or enter to start dragging. While dragging, use the arrow keys to move the item in any given direction. Press space or enter again to drop the item in its new position, or press escape to cancel.'
    : 'Keyboard support for drag and drop is disabled. Enable it in the settings.';

  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const resource = store.getResourceLoading(active.id as string);

      return `Picked up ${resource.title}`;
    },
    onDragOver: ({ active, over }) => {
      if (!over || !over.data.current) {
        return;
      }

      const dragResource = store.getResourceLoading(active.id as string);
      const dropResource = store.getResourceLoading(over.data.current.parent);

      return `Draggable item ${dragResource.title} was moved over droppable area in ${dropResource.title}`;
    },
    onDragEnd: ({ active, over }) => {
      if (!over || !over.data.current) {
        return `Dragging canceled`;
      }

      const dragResource = store.getResourceLoading(active.id as string);
      const dropResource = store.getResourceLoading(over.data.current.parent);

      return `${dragResource.title} was moved to ${dropResource.title}`;
    },
    onDragCancel: () => {
      return `Dragging canceled`;
    },
  };

  return {
    handleDragStart,
    handleDragEnd,
    draggingResource,
    sensors,
    animateDrop,
    dndExplanation,
    announcements,
  };
};
