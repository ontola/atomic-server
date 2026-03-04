import {
  createContext,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
} from 'react';
import { useStore } from '@tomic/react';
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
  serverUrl: string,
  drive: string,
): Promise<PluginListResult> => {
  const response = await fetch(`${serverUrl}/plugin-list?drive=${drive}`);
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
  const serverUrl = store.getServerUrl();

  const refresh = async () => {
    const [list, newManifests] = await fetchPluginList(serverUrl, drive);
    setCustomViews(list);
    setUIPluginDataMap(newManifests);
  };

  const getPluginForClass = (classSubject: string) => {
    return customViews.get(classSubject);
  };

  const getUIPluginData = (plugin: string) => {
    return uiPluginDataMap.get(plugin)!;
  };

  useEffect(() => {
    fetchPluginList(serverUrl, drive).then(([views, manifests]) => {
      setCustomViews(views);
      setUIPluginDataMap(manifests);
      setLoading(false);
    });
  }, [serverUrl, drive]);

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
