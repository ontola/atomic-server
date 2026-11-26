import { lazy, Suspense, useMemo, type PropsWithChildren } from 'react';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { dataBrowser, useResource, useStore } from '@tomic/react';
import {
  ResourceUIHostProvider,
  type ResourceUIHost,
  type DriveApps as DriveAppsData,
} from '@tomic/resource-ui/ResourceUIHost';
import { useSettings } from './helpers/AppSettings';
import { useNavigateWithTransition } from './hooks/useNavigateWithTransition';
import { constructOpenURL, pathToURL } from './helpers/navigation';
import { isRunningInTauri } from './helpers/tauri';
import { errorHandler } from './handlers/errorHandler';
import { holdBootSplash } from './helpers/bootSplash';
import { isEmbedded } from './helpers/embedMode';
import { loadAtomicWasm } from './helpers/managed/recovery';
import { useDriveApps } from './chunks/AppPage/useDriveApps';
const LazyResourceSyncIndicator = lazy(() =>
  import('./components/ResourceSync/ResourceSyncIndicator').then(module => ({
    default: module.ResourceSyncIndicator,
  })),
);

function ResourceSyncIndicator(
  props: React.ComponentProps<typeof LazyResourceSyncIndicator>,
) {
  return (
    <Suspense fallback={null}>
      <LazyResourceSyncIndicator {...props} />
    </Suspense>
  );
}

const LazyAppFrame = lazy(() =>
  import('./chunks/AppPage/AppFrame').then(m => ({ default: m.AppFrame })),
);
const ResourceCard = lazy(() => import('./views/Card/ResourceCard'));
const TableRTE = lazy(() =>
  import('./chunks/RTE/TableRTE').then(m => ({ default: m.TableRTE })),
);
import CrashPage from './views/CrashPage';
import { useRootWelcomeLayout } from './context/RootWelcomeLayoutContext';
const WorkspaceControls = lazy(() =>
  import('./chunks/PluginRuns/WorkspaceControls').then(m => ({
    default: m.WorkspaceControls,
  })),
);
const FeedbackButton = lazy(() =>
  import('./components/SideBar/FeedbackButton').then(m => ({
    default: m.FeedbackButton,
  })),
);
const links = { constructOpenURL, pathToURL };
const loading = {
  hold: holdBootSplash,
  delay: (centered: boolean) => (centered && isEmbedded() ? 1000 : 0),
};

function AppFrame(props: { app: string; drive: string; table?: string }) {
  return (
    <Suspense fallback={null}>
      <LazyAppFrame {...props} />
    </Suspense>
  );
}

function DriveApps({
  children,
}: {
  children: (apps: DriveAppsData) => React.ReactNode;
}) {
  const apps = useDriveApps(useStore().getDrive());

  return children(apps);
}

function EmbeddedResource(props: { subject: string; highlight?: boolean }) {
  const resource = useResource(props.subject);

  return (
    <Suspense fallback={null}>
      {resource.hasClasses(dataBrowser.classes.table) ? (
        <TableRTE subject={props.subject} />
      ) : (
        <ResourceCard {...props} />
      )}
    </Suspense>
  );
}

function ErrorFallback({
  error,
  clearError,
}: {
  error: Error;
  clearError: () => void;
}) {
  return (
    <CrashPage
      error={error}
      clearError={clearError}
      info={{} as React.ErrorInfo}
    />
  );
}

/** The Atomic shell supplies navigation and integrations; the packages own the complete page and record UI. */
export function AtomicResourceUIHost({ children }: PropsWithChildren) {
  const settings = useSettings();
  const navigate = useNavigate();
  const navigateWithTransition = useNavigateWithTransition();
  const search = useSearch({ strict: false });
  const { history } = useRouter();
  const { rootWelcomeChromeHidden } = useRootWelcomeLayout();
  const value = useMemo<ResourceUIHost>(
    () => ({
      settings,
      search,
      navigate,
      // Dynamic resource paths cross the shell’s registered-route type boundary.
      navigateWithTransition: options =>
        navigateWithTransition(
          options as Parameters<typeof navigateWithTransition>[0],
        ),
      links,
      history,
      isRunningInTauri,
      loading,
      reportError: errorHandler,
      loadAtomicWasm,
      DriveApps,
      AppFrame,
      ResourceSyncIndicator,
      WorkspaceControls,
      ResourceCard: EmbeddedResource,
      errorFallback: ErrorFallback,
      FeedbackButton,
      feedback: rootWelcomeChromeHidden ? (
        <Suspense fallback={null}>
          <FeedbackButton />
        </Suspense>
      ) : undefined,
    }),
    [
      settings,
      search,
      navigate,
      navigateWithTransition,
      history,
      rootWelcomeChromeHidden,
    ],
  );

  return (
    <ResourceUIHostProvider value={value}>{children}</ResourceUIHostProvider>
  );
}
