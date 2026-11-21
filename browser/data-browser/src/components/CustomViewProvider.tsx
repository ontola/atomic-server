import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { useCurrentAgent, useStore, type Store } from '@tomic/react';
import { pluginRequest } from '@views/PluginView/pluginRequest';
import { useSettings } from '@helpers/AppSettings';

interface UIPluginManifest {
  css: boolean;
}

interface UIPluginListItem {
  plugin: string;
  classes: string[];
  uiManifest: UIPluginManifest;
  resource: string;
}

export type UIPluginData = Omit<UIPluginListItem, 'classes'>;

interface CustomViewContext {
  getPluginForClass: (classSubject: string) => string | undefined;
  getUIPluginData: (plugin: string) => UIPluginData;
  loading: boolean;
  refresh: () => Promise<void>;
}

const CustomViewContext = createContext<CustomViewContext>({
  getPluginForClass: () => undefined,
  getUIPluginData: () => ({
    plugin: '',
    uiManifest: { css: false },
    resource: '',
  }),
  loading: true,
  refresh: () => Promise.resolve(),
});

type PluginListResult = [
  views: Map<string, string>,
  pluginData: Map<string, UIPluginData>,
];

function parsePluginList(data: UIPluginListItem[]): PluginListResult {
  const viewMap = new Map<string, string>();
  const dataMap = new Map<string, UIPluginData>();

  for (const item of data) {
    for (const classSubject of item.classes) {
      viewMap.set(classSubject, item.plugin);
    }

    dataMap.set(item.plugin, {
      plugin: item.plugin,
      uiManifest: item.uiManifest,
      resource: item.resource,
    });
  }

  return [viewMap, dataMap];
}

const fetchPluginList = async (
  store: Store,
  serverUrl: string,
  drive: string,
  signal: AbortSignal,
): Promise<PluginListResult> => {
  if (!drive) return [new Map(), new Map()];
  const url = `${serverUrl}/plugin-list?drive=${encodeURIComponent(drive)}`;
  const response = await pluginRequest(store, url, signal);
  const data = await response.json();

  return parsePluginList(data);
};

export function CustomViewProvider({ children }: PropsWithChildren) {
  const store = useStore();
  const { drive } = useSettings();
  const [customViews, setCustomViews] = useState<Map<string, string>>(
    new Map(),
  );
  const [uiPluginDataMap, setUIPluginDataMap] = useState<
    Map<string, UIPluginData>
  >(new Map());

  const [loading, setLoading] = useState(true);
  const [agent] = useCurrentAgent();
  const serverUrl = store.getServerUrl();

  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    await fetchPluginList(store, serverUrl, drive, controller.signal)
      .then(([list, manifests]) => {
        if (controller.signal.aborted) return;
        setCustomViews(list);
        setUIPluginDataMap(manifests);
        setLoading(false);
      })
      .catch(error => {
        if (!controller.signal.aborted) {
          setLoading(false);
          throw error;
        }
      });
  }, [store, serverUrl, drive]);

  const getPluginForClass = (classSubject: string) => {
    return customViews.get(classSubject);
  };

  const getUIPluginData = (plugin: string) => {
    return uiPluginDataMap.get(plugin)!;
  };

  useEffect(() => {
    setLoading(true);
    setCustomViews(new Map());
    setUIPluginDataMap(new Map());
    // Automatic discovery is optional. An explicit refresh still reports its error.
    void refresh().catch(() => {});

    return () => request.current?.abort();
  }, [refresh, agent?.subject]);

  return (
    <CustomViewContext
      value={{
        getPluginForClass,
        getUIPluginData,
        loading,
        refresh,
      }}
    >
      {children}
    </CustomViewContext>
  );
}

export function useCustomViews() {
  return useContext(CustomViewContext);
}
