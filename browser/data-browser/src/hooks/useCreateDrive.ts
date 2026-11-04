import { useStore, type Resource } from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { getManagedPortalUrl } from '../helpers/managed/cloudSync';
import { constructOpenURL } from '../helpers/navigation';
import { prepareTemplateDrive } from '../chunks/Templates/prepareTemplateDrive';
import { useNavigateWithTransition } from './useNavigateWithTransition';

/** One creation at a time, so a double click or a StrictMode re-run shares it. */
let inFlight: Promise<Resource> | undefined;

/**
 * Returns a function that creates a drive named "My drive", makes it the
 * current drive and opens it. The name is changed later on the drive page.
 * Rejects when creating fails; callers must show the error.
 */
export function useCreateDrive(): (options?: {
  skipNavigation?: boolean;
}) => Promise<Resource> {
  const store = useStore();
  const { setDrive } = useSettings();
  const navigate = useNavigateWithTransition();

  return options => {
    inFlight ??= (async () => {
      try {
        await prepareTemplateDrive(store);
        const resource = await store.createDrive('My drive', {
          personal: false,
          localOnly: !!getManagedPortalUrl(),
        });
        await store.notifyResourceManuallyCreated(resource);
        setDrive(resource.subject);

        return resource;
      } finally {
        inFlight = undefined;
      }
    })();

    return inFlight.then(resource => {
      if (!options?.skipNavigation)
        navigate(constructOpenURL(resource.subject));

      return resource;
    });
  };
}
