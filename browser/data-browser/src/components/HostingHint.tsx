import { useEffect, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { getCloudServerPrice } from '../helpers/managed/accountProviders';
import { hasManagedApi } from '../helpers/managed/api';
import {
  driveHasCloudEnrollment,
  getAccountServiceUrl,
} from '../helpers/managed/cloudSync';
import { cloudServerSalesUrl } from '../helpers/driveBillingUrl';
import { openExternal } from '../helpers/openExternal';

export type HostingHintReason =
  | 'no-always-on-device'
  | 'peer-limit'
  | 'own-server'
  | 'new-device';

/**
 * The one place the app mentions hosting by the account service: a muted line
 * and a plain link. Nothing without a service or for a hosted drive. The price
 * is the service's, and only asked for once the hint is on screen.
 */
export function HostingHint({
  reason,
  drive,
}: {
  reason: HostingHintReason;
  drive?: string;
}): JSX.Element | null {
  const service = getAccountServiceUrl();
  const [price, setPrice] = useState<string>();
  const [hosted, setHosted] = useState(false);

  useEffect(() => {
    if (!service) return;

    let live = true;
    void getCloudServerPrice(service).then(p => live && setPrice(p));

    if (drive && hasManagedApi()) {
      driveHasCloudEnrollment(drive)
        .then(has => live && setHosted(has))
        .catch(() => undefined);
    }

    return () => {
      live = false;
    };
  }, [service, drive]);

  if (!service || hosted) return null;

  const copy: Record<HostingHintReason, [text: string, link: string]> = {
    'no-always-on-device': [
      'Nothing keeps this drive online while your devices are off.',
      'Get an always-on server',
    ],
    'peer-limit': [
      'Browser sync has reached its limit of peer connections.',
      'Keep everyone in sync with a Cloud Server',
    ],
    'own-server': ['Want a server of your own?', 'Get one hosted'],
    'new-device': [
      'Free browser sync is meant for small groups of up to 4 people.',
      'For more people, use a Cloud Server',
    ],
  };
  const [text, link] = copy[reason];
  const url = cloudServerSalesUrl(service, drive);

  return (
    <Hint role='note' data-testid={`hosting-hint-${reason}`}>
      {text}{' '}
      <a
        href={url}
        target='_blank'
        rel='noreferrer'
        onClick={e => {
          e.preventDefault();
          void openExternal(url);
        }}
      >
        {link}
      </a>
      {price && <> from {price}</>}.
    </Hint>
  );
}

const Hint = styled.small`
  display: block;
  color: ${p => p.theme.colors.textLight};
  text-wrap: pretty;

  a {
    color: ${p => p.theme.colors.main};
    text-decoration: underline;
  }
`;
