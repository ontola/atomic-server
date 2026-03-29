import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
  useEffect,
  type JSX,
} from 'react';
import { DarkModeOption, useDarkMode } from './useDarkMode';
import {
  useCurrentAgent,
  useServerURL,
  Agent,
  useStore,
  StoreEvents,
} from '@tomic/react';
import toast from 'react-hot-toast';
import { SIDEBAR_TOGGLE_WIDTH } from '../components/SideBar';
import { serverURLStorage } from './serverURLStorage';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { errorHandler } from '../handlers/errorHandler';
import { isDev } from '../config';

interface ProviderProps {
  children: ReactNode;
}

/** Create a provider for components to consume and subscribe to changes */
export const AppSettingsContextProvider = (
  props: ProviderProps,
): JSX.Element => {
  // == SYSTEM ==
  const [agent, setAgent] = useCurrentAgent();
  const [baseURL, setBaseURL] = useServerURL();
  const [drive, innerSetDrive] = useLocalStorage('drive', baseURL);

  // == APPEARANCE ==
  const [darkMode, setDarkMode, darkModeSetting] = useDarkMode();
  const [mainColor, setMainColor] = useLocalStorage('mainColor', '#1b50d8');
  const [hideTemplates, setHideTemplates] = useLocalStorage(
    'hideTemplates',
    false,
  );
  const [sideBarLocked, setSideBarLocked] = useLocalStorage(
    'sideBarOpen',
    window.innerWidth > SIDEBAR_TOGGLE_WIDTH,
  );
  const [navbarTop, setNavbarTop] = useLocalStorage('navbarTop', true);

  const store = useStore();

  useEffect(() => {
    return store.on(StoreEvents.DriveChanged, newDrive => {
      if (newDrive !== drive) {
        innerSetDrive(newDrive);
      }
    });
  }, [drive, store, innerSetDrive]);

  useEffect(() => {
    store.setDrive(drive);
  }, [drive, store]);

  // == ACCESSIBILITY ==
  const [viewTransitionsDisabled, setViewTransitionsDisabled] = useLocalStorage(
    'viewTransitionsDisabled',
    false,
  );
  const [sidebarKeyboardDndEnabled, setSidebarKeyboardDndEnabled] =
    useLocalStorage('sidebarKeyboardDndEnabled', false);

  useEffect(() => {
    const currentOrigin = isDev()
      ? 'http://localhost:9883'
      : window.location.origin;

    serverURLStorage.addKnownServer(currentOrigin);
  }, []);

  const setServer = useCallback(
    (newServer: string) => {
      if (newServer.startsWith('http://') || newServer.startsWith('https://')) {
        const url = new URL(newServer);
        setBaseURL(url.origin);
        serverURLStorage.set(url.origin);
      }
    },
    [setBaseURL],
  );

  const setDrive = useCallback(
    (newDrive: string) => {
      innerSetDrive(newDrive);

      if (newDrive.startsWith('http://') || newDrive.startsWith('https://')) {
        const url = new URL(newDrive);
        setBaseURL(url.origin);
        serverURLStorage.set(url.origin);
      }
    },
    [innerSetDrive, setBaseURL],
  );

  const setAgentAndShowToast = useCallback(
    (newAgent: Agent | undefined) => {
      try {
        setAgent(newAgent);

        if (newAgent?.subject) {
          toast.success('Signed in!');
        }

        if (newAgent === undefined) {
          toast.success('Signed out.');
        }
      } catch (e) {
        errorHandler(new Error('Agent setting failed: ' + e.message));
      }
    },
    [setAgent],
  );

  const context = useMemo(
    () => ({
      drive,
      setDrive,
      darkMode,
      darkModeSetting,
      setDarkMode,
      mainColor,
      setMainColor,
      sideBarLocked,
      setSideBarLocked,
      agent,
      setAgent: setAgentAndShowToast,
      viewTransitionsDisabled,
      setViewTransitionsDisabled,
      sidebarKeyboardDndEnabled,
      setSidebarKeyboardDndEnabled,
      hideTemplates,
      setHideTemplates,
      baseURL,
      setBaseURL,
      setServer,
      navbarTop,
      setNavbarTop,
    }),
    [
      drive,
      setDrive,
      darkMode,
      darkModeSetting,
      setDarkMode,
      mainColor,
      setMainColor,
      sideBarLocked,
      setSideBarLocked,
      agent,
      setAgentAndShowToast,
      viewTransitionsDisabled,
      setViewTransitionsDisabled,
      sidebarKeyboardDndEnabled,
      setSidebarKeyboardDndEnabled,
      hideTemplates,
      setHideTemplates,
      baseURL,
      setBaseURL,
      setServer,
      navbarTop,
      setNavbarTop,
    ],
  );

  return (
    <SettingsContext.Provider value={context}>
      {props.children}
    </SettingsContext.Provider>
  );
};

/** A bunch of getters and setters for client-side app settings */
export interface AppSettings {
  /** Whether the App should render in dark mode. Checks user preferences. */
  darkMode: boolean;
  /** 'always', 'never' or 'auto' */
  darkModeSetting: DarkModeOption;
  /** When calling this with undefined (no arguments), it uses the browser's preference */
  setDarkMode: (b?: boolean) => void;
  /** CSS value for the primary color */
  mainColor: string;
  setMainColor: (s: string) => void;
  /** The URL that points to the Drive shown in the SideBar */
  drive: string;
  /** Sets the current Drive (and therefore, server!) */
  setDrive: (s: string) => void;
  /** If the Sidebar should be locked to the side */
  sideBarLocked: boolean;
  setSideBarLocked: (s: boolean) => void;
  /** The currently signed in Agent */
  agent: Agent | undefined;
  setAgent: (a: Agent | undefined) => void;
  /** If the app should use view transitions */
  viewTransitionsDisabled: boolean;
  setViewTransitionsDisabled: (b: boolean) => void;
  sidebarKeyboardDndEnabled: boolean;
  setSidebarKeyboardDndEnabled: (b: boolean) => void;
  hideTemplates: boolean;
  setHideTemplates: (b: boolean) => void;
  /** The URL of the currently active server / peer used for resolution. */
  baseURL: string;
  /** Sets the active server / peer. */
  setBaseURL: (s: string) => void;
  /** Robustly sets the server and adds it to the known list. */
  setServer: (s: string) => void;
  /** Whether the navbar should be at the top or bottom */
  navbarTop: boolean;
  setNavbarTop: (b: boolean) => void;
}

const initialState: AppSettings = {
  darkMode: false,
  darkModeSetting: DarkModeOption.auto,
  setDarkMode: () => undefined,
  mainColor: '',
  setMainColor: () => undefined,
  drive: '',
  setDrive: () => undefined,
  sideBarLocked: false,
  setSideBarLocked: () => undefined,
  agent: undefined,
  setAgent: () => undefined,
  viewTransitionsDisabled: true,
  setViewTransitionsDisabled: () => undefined,
  sidebarKeyboardDndEnabled: false,
  setSidebarKeyboardDndEnabled: () => undefined,
  hideTemplates: false,
  setHideTemplates: () => undefined,
  baseURL: '',
  setBaseURL: () => undefined,
  setServer: () => undefined,
  navbarTop: true,
  setNavbarTop: () => undefined,
};

/** Hook for using App Settings, such as theme and darkmode */
export const useSettings = (): AppSettings => {
  return useContext(SettingsContext);
};

/**
 * The context must be provided by wrapping a high level React element in
 * <SettingsContext.Provider value={new AppSettings}>
 */
export const SettingsContext = createContext<AppSettings>(initialState);
