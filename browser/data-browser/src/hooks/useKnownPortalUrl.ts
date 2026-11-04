// @wc-ignore-file
import { useEffect, useState } from 'react';
import { useSettings } from '../helpers/AppSettings';
import { safePortalUrl } from '../helpers/managed/api';
import { getManagedPortalUrl } from '../helpers/managed/cloudSync';
import { getRememberedProvider } from '../helpers/managed/deviceLink';
import { fetchManagedInfo } from '../helpers/managedServer';

/**
 * The account portal this build or device knows of, or null on a self-hosted
 * install. Resolved like the Get started flow does: a build-time override or a
 * remembered provider first, then whatever the connected node reports.
 */
export function useKnownPortalUrl(): string | null {
  const { baseURL } = useSettings();
  const [url, setUrl] = useState<string | null>(
    () =>
      safePortalUrl(getManagedPortalUrl() ?? getRememberedProvider()) ?? null,
  );

  useEffect(() => {
    let cancelled = false;
    void fetchManagedInfo(baseURL).then(info => {
      if (cancelled) return;

      setUrl(
        safePortalUrl(getManagedPortalUrl(info) ?? getRememberedProvider()) ??
          null,
      );
    });

    return () => {
      cancelled = true;
    };
  }, [baseURL]);

  return url;
}
