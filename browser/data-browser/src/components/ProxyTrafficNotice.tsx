import { styled } from 'styled-components';
import { useIntegrationProxy } from '@helpers/integrationProxy';
import {
  PROXY_SELF_HOSTING_URL,
  proxyTrafficHost,
} from '@helpers/proxyTrafficHost';
import { ExternalLink } from './ExternalLink';

/**
 * Says which integration proxy carries a connection's traffic, with a link to
 * running your own. Shown wherever someone connects an external service, and
 * next to the proxy setting.
 */
export function ProxyTrafficNotice(): React.JSX.Element {
  const host = proxyTrafficHost(useIntegrationProxy());

  return (
    <Notice data-testid='proxy-traffic-notice'>
      This traffic goes through <strong>{host}</strong>. If you want to run your
      own atomic-integration-proxy, follow the instructions here:{' '}
      <ExternalLink to={PROXY_SELF_HOSTING_URL}>
        self-hosting guide
      </ExternalLink>
    </Notice>
  );
}

const Notice = styled.span`
  display: block;
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
  overflow-wrap: anywhere;
`;
