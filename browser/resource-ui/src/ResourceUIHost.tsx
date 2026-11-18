import {
  createContext,
  useContext,
  type ComponentType,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import type { Agent, Resource, OptionalClass } from '@tomic/react';
import type { AtomicWasmModule } from './helpers/loadAtomicWasm.js';
import type { DriveApps } from './helpers/driveApps.js';

export type { DriveApp, DriveApps } from './helpers/driveApps.js';

export type ResourcePageProps<Subject extends OptionalClass = never> = {
  resource: Resource<Subject>;
};
export type ResourceSearch = Record<string, unknown> & {
  view?: string;
  editColumn?: string;
};
export interface NavigateOptions {
  to: string;
  search?: ResourceSearch | ((previous: ResourceSearch) => ResourceSearch);
  replace?: boolean;
}
export interface ResourceHistory {
  location: {
    href: string;
    state: object;
  };
  push: (href: string, state: Record<string, unknown>) => void;
  back: () => void;
  subscribe: (listener: () => void) => () => void;
}
export type WorkspaceSection = 'connections' | 'automations';

/** Shell integration only; record fields and all built-in table views remain SDK-aware components. */
export interface ResourceUIHost {
  settings: {
    drive: string;
    contentLanguage: string;
    setContentLanguage: (language: string) => void;
    agent: Agent | undefined;
  };
  search: ResourceSearch;
  navigate: (options: NavigateOptions) => Promise<unknown> | void;
  navigateWithTransition: (
    options: NavigateOptions | string,
  ) => Promise<unknown> | void;
  links: {
    constructOpenURL: (
      subject: string,
      extraParams?: Record<string, string>,
    ) => string;
    pathToURL: (path: string) => string;
  };
  history?: ResourceHistory;
  isRunningInTauri: () => boolean;
  reportError: (error: unknown) => void;
  loadAtomicWasm: () => Promise<AtomicWasmModule>;
  DriveApps: ComponentType<{ children: (apps: DriveApps) => ReactNode }>;
  AppFrame: ComponentType<{ app: string; drive: string; table?: string }>;
  WorkspaceControls: ComponentType<{
    workspace: string;
    section: WorkspaceSection;
    onClosed: () => void;
  }>;
  ResourceCard: ComponentType<{ subject: string; highlight?: boolean }>;
  errorFallback: ComponentType<{ error: Error; clearError: () => void }>;
  loading?: { hold: () => () => void; delay: (centered: boolean) => number };
  feedback?: ReactNode;
  FeedbackButton?: ComponentType<{ reportError?: Error }>;
}
const ResourceUIHostContext = createContext<ResourceUIHost | undefined>(
  undefined,
);

export function ResourceUIHostProvider({
  value,
  children,
}: PropsWithChildren<{ value: ResourceUIHost }>) {
  return (
    <ResourceUIHostContext.Provider value={value}>
      {children}
    </ResourceUIHostContext.Provider>
  );
}
export const useOptionalResourceUIHost = () =>
  useContext(ResourceUIHostContext);

export function useResourceUIHost(): ResourceUIHost {
  const host = useContext(ResourceUIHostContext);
  if (!host)
    throw new Error(
      /* @wc-ignore */ 'Resource-aware UI requires ResourceUIHostProvider.',
    );

  return host;
}
export const useSettings = () => useResourceUIHost().settings;
export const useNavigate = () => useResourceUIHost().navigate;
export const useNavigateWithTransition = () =>
  useResourceUIHost().navigateWithTransition;
export const useResourceNavigation = () => useResourceUIHost().links;
