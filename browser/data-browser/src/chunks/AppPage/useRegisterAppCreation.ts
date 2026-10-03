import { useEffect } from 'react';
import { useStore } from '@tomic/react';
import { constructOpenURL } from '@helpers/navigation';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { registerBasicInstanceHandler } from '@components/forms/NewForm/useNewResourceUI';
import { useAppClass } from '@chunks/PluginRuns/runScript';

/**
 * Makes "App" in the New menu build a working app.
 *
 * An App is not one resource. It is an app, its own ontology, a row class, a
 * table for its rows, the plugin that renders it and an identity to write as.
 * The generic new-resource form can only make the first of those, so choosing
 * App there produced something that asked the user to fill in an entry point
 * by hand and could never work.
 *
 * Registered from an effect rather than at module load because the App class
 * is minted per drive, so its subject is not known until one is open. The
 * registry is keyed by subject, so several drives can each register their own.
 */
export function useRegisterAppCreation(drive: string | undefined): void {
  const store = useStore();
  const appClass = useAppClass(drive);
  const navigate = useNavigateWithTransition();

  useEffect(() => {
    if (!appClass || !drive) return;

    registerBasicInstanceHandler(appClass, async (parent, _create, ctx) => {
      const { createDriveResource } =
        await import('../../routes/NewResource/createDriveResource');
      const subject = await createDriveResource(
        'app',
        ctx.store,
        drive,
        parent,
      );
      navigate(constructOpenURL(subject));
    });
  }, [store, drive, appClass, navigate]);
}
