import type { ResourcePageProps } from '../ResourcePage';
import { useStore } from '@tomic/react';
import { useSettings } from '@helpers/AppSettings';
import { usePluginRPC } from '@views/PluginView/pluginRPC';
import styled from 'styled-components';
import { useMemo } from 'react';

import resetCss from '../../reset.css?url';
import { useCreateThemeVars } from './useCreateThemeVars';
import { useCustomViews } from '@components/CustomViewProvider';
import { generateNonce } from '@helpers/randomString';

export enum ViewType {
  Page = 'page',
  Card = 'card',
  Inline = 'inline',
}

export interface PluginViewProps extends ResourcePageProps {
  plugin: string;
}

type HTMLProps = {
  scriptSrc: string;
  cssSrc?: string;
  stylesheet: string;
  nonce: string;
};
const html = ({ scriptSrc, cssSrc, stylesheet, nonce }: HTMLProps) => `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src * data:; connect-src *; font-src *; base-uri 'none'; object-src 'none';">
    <title>Document</title>
    <link rel="stylesheet" href="${resetCss}" nonce="${nonce}" />
    ${cssSrc ? `<link rel="stylesheet" href="${cssSrc}" nonce="${nonce}" />` : ''}
    <style nonce="${nonce}">${stylesheet}</style>
    <script type="module" src="${scriptSrc}" nonce="${nonce}"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
  </html>
`;

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
  const pluginUrl = `${store.getServerUrl()}/plugin-ui?drive=${encodeURIComponent(drive)}&plugin=${encodeURIComponent(plugin)}`;
  const scriptSrc = `${pluginUrl}&format=js`;
  const cssSrc = pluginData.uiManifest.css
    ? `${pluginUrl}&format=css`
    : undefined;

  const nonce = useMemo(() => generateNonce(), []);

  return (
    <>
      <StyledIframe
        title='plugin-view'
        id='custom-view'
        referrerPolicy='no-referrer'
        ref={frameRef}
        srcDoc={html({ scriptSrc, cssSrc, stylesheet, nonce })}
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
