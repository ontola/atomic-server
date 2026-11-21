import type { ResourcePageProps } from '../ResourcePage';
import { useStore } from '@tomic/react';
import { useSettings } from '@helpers/AppSettings';
import { usePluginRPC } from '@views/PluginView/pluginRPC';
import styled from 'styled-components';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

import resetCss from '../../reset.css?raw';
import { useCreateThemeVars } from './useCreateThemeVars';
import { useCustomViews } from '@components/CustomViewProvider';
import { ErrorBlock } from '@components/ErrorLook';
import { pluginRequest } from './pluginRequest';

export enum ViewType {
  Page = 'page',
  Card = 'card',
  Inline = 'inline',
}

export interface PluginViewProps extends ResourcePageProps {
  plugin: string;
}

/**
 * Renders a ResourcePage view provided by the plugin.
 * The view is rendered in a null-origin iframe to prevent the plugin from accessing the parent page.
 */
export const PluginView: React.FC<PluginViewProps> = ({ plugin }) => {
  const { drive } = useSettings();
  const store = useStore();
  const { getUIPluginData } = useCustomViews();
  const pluginData = getUIPluginData(plugin);
  const [frameRef, resourcePickerDialog] = usePluginRPC(pluginData);
  const stylesheet = useCreateThemeVars();
  const params = new URLSearchParams({ drive, plugin });
  const pluginUrl = `${store.getServerUrl()}/plugin-ui?${params}`;
  const hasCss = pluginData.uiManifest.css;
  const [error, setError] = useState<Error>();
  const applyTheme = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: '__atomic_style', reset: resetCss, css: stylesheet },
      '*',
    );
  }, [frameRef, stylesheet]);

  useEffect(applyTheme, [applyTheme]);

  useLayoutEffect(() => {
    const controller = new AbortController();

    const fetchAsset = async (format: string) => {
      const response = await pluginRequest(
        store,
        `${pluginUrl}&format=${format}`,
        controller.signal,
      );

      return response.text();
    };

    const onReady = (event: MessageEvent) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        event.origin !== 'null' ||
        event.data?.type !== '__atomic_plugin_ready' ||
        event.ports.length !== 1
      )
        return;

      // This port belongs to the requesting document, even if the iframe
      // navigates elsewhere while its assets are being fetched.
      const port = event.ports[0];

      void Promise.all([
        fetchAsset('js'),
        hasCss ? fetchAsset('css') : Promise.resolve(''),
      ])
        .then(([js, css]) => {
          if (controller.signal.aborted) return;
          setError(undefined);
          port.postMessage({ js, css });
        })
        .catch(cause => {
          if (!controller.signal.aborted) {
            setError(cause instanceof Error ? cause : new Error(String(cause)));
          }
        })
        .finally(() => port.close());
    };

    window.addEventListener('message', onReady);

    return () => {
      controller.abort();
      window.removeEventListener('message', onReady);
    };
  }, [frameRef, hasCss, pluginUrl, store]);

  return (
    <>
      {error && <ErrorBlock error={error} />}
      <StyledIframe
        title='plugin-view'
        id='custom-view'
        referrerPolicy='no-referrer'
        ref={frameRef}
        src={`${pluginUrl}&format=html`}
        onLoad={applyTheme}
        sandbox='allow-scripts allow-downloads allow-pointer-lock allow-presentation'
      />
      {resourcePickerDialog}
    </>
  );
};

const StyledIframe = styled.iframe`
  width: 100%;
  height: 100%;
  border: none;
`;
