import { JSONValue, Resource, useStore } from '@tomic/react';
import { useCallback } from 'react';
import toast from 'react-hot-toast';
import { constructOpenURL } from '../helpers/navigation';
import { useNavigate } from '@tanstack/react-router';

export type CreateAndNavigate = (
  isA: string,
  propVals: Record<string, JSONValue>,
  options: {
    parent?: string;
    noParent?: boolean;
    extraParams?: Record<string, string>;
    /** Query parameters for the resource / endpoint */
    onCreated?: (resource: Resource) => Promise<void> | void;
    /** Only pass subject if you really need a custom subject. Random ULID are prefered in most cases. */
    subject?: string;
    /** If true, skip navigation after resource creation */
    skipNavigation?: boolean;
  },
) => Promise<Resource>;

/**
 * Hook that builds a function that will create a new resource with the given
 * properties and then navigate to it.
 *
 * @returns A {@link CreateAndNavigate} function.
 */
export function useCreateAndNavigate(): CreateAndNavigate {
  const store = useStore();
  const navigate = useNavigate();

  const createAndNavigate: CreateAndNavigate = useCallback(
    async (
      isA,
      propVals,
      { parent, extraParams, onCreated, subject, noParent, skipNavigation },
    ): Promise<Resource> => {
      const classTitle = store
        .getResourceLoading(isA)
        ?.title?.replace(/^https?:\/\/[^/]+\/classes\//, '') ?? 'Resource';

      const resource = await store.newResource({
        subject,
        isA,
        parent,
        propVals,
        noParent,
      });

      try {
        await resource.save();

        if (onCreated) {
          await onCreated(resource);
        }

        if (!skipNavigation) {
          await navigate({
            to: constructOpenURL(resource.subject, extraParams),
          });
        }

        toast.success(`${classTitle} created`);
        store.notifyResourceManuallyCreated(resource);
      } catch (e) {
        store.notifyError(e);
        toast.error('Failed to save new resource');
      }

      return resource;
    },
    [store, navigate],
  );

  return createAndNavigate;
}
