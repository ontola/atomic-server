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
import { useSyncableCollectionView } from './chunks/PluginRuns/syncableCollectionViews';
import { useDriveApps } from './chunks/AppPage/useDriveApps';
const LazyResourceSyncIndicator = lazy(() =>
  import('./components/ResourceSync/ResourceSyncIndicator').then(module => ({
    default: module.ResourceSyncIndicator,
  })),
);
const LazyAfterCommitBar = lazy(() =>
  import('./chunks/AppPage/AfterCommitBar').then(module => ({
    default: module.AfterCommitBar,
  })),
);
const LazyBuiltinSyncablesApp = lazy(() =>
  import('./chunks/PluginRuns/BuiltinSyncablesApp').then(module => ({
    default: module.BuiltinSyncablesApp,
  })),
);
const LazySyncableCollectionView = lazy(() =>
  import('./chunks/PluginRuns/SyncableCollectionView').then(module => ({
    default: module.SyncableCollectionView,
  })),
);

const LazyAppFrame = lazy(() =>
  import('./chunks/AppPage/AppFrame').then(m => ({ default: m.AppFrame })),
);
const ResourceCard = lazy(() => import('./views/Card/ResourceCard'));
const TableRTE = lazy(() =>
  import('./chunks/RTE/TableRTE').then(m => ({
    default: m.TableRTE,
  })),
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

function AppFrame(props: {
  app: string;
  drive: string;
  table?: string;
  view?: string;
}) {
  return (
    <Suspense fallback={null}>
      <LazyAppFrame {...props} />
    </Suspense>
  );
}

function ResourceSyncIndicator(
  props: React.ComponentProps<typeof LazyResourceSyncIndicator>,
) {
  return (
    <Suspense fallback={null}>
      <LazyResourceSyncIndicator {...props} />
    </Suspense>
  );
}

function AfterCommitBar(
  props: React.ComponentProps<typeof LazyAfterCommitBar>,
) {
  return (
    <Suspense fallback={null}>
      <LazyAfterCommitBar {...props} />
    </Suspense>
  );
}

function BuiltinSyncablesApp(
  props: React.ComponentProps<typeof LazyBuiltinSyncablesApp>,
) {
  return (
    <Suspense fallback={null}>
      <LazyBuiltinSyncablesApp {...props} />
    </Suspense>
  );
}

function SyncableCollectionView(
  props: React.ComponentProps<typeof LazySyncableCollectionView>,
) {
  return (
    <Suspense fallback={null}>
      <LazySyncableCollectionView {...props} />
    </Suspense>
  );
}

function DriveApps({
  children,
  drive,
  table,
  rowClass,
}: {
  children: (apps: DriveAppsData) => React.ReactNode;
  drive?: string;
  table?: string;
  rowClass?: string;
}) {
  const store = useStore();
  const owningDrive = drive ?? store.getDrive();
  const apps = useDriveApps(owningDrive);

  return table && rowClass ? (
    <TableAppDiscovery
      apps={apps}
      drive={owningDrive}
      table={table}
      rowClass={rowClass}
    >
      {children}
    </TableAppDiscovery>
  ) : (
    children(apps)
  );
}

function TableAppDiscovery({
  apps,
  children,
  drive,
  table,
  rowClass,
}: {
  apps: DriveAppsData;
  children: (apps: DriveAppsData) => React.ReactNode;
  drive?: string;
  table: string;
  rowClass: string;
}) {
  const collectionView = useSyncableCollectionView(drive, table, rowClass);

  return children({ ...apps, collectionView });
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
      AfterCommitBar,
      BuiltinSyncablesApp,
      SyncableCollectionView,
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
