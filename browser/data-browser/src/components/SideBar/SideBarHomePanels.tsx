import { core, urls } from '@tomic/react';
import type { JSX } from 'react';
import { useSettings } from '../../helpers/AppSettings';
import { usePersonalDriveList } from '../../hooks/usePersonalDriveList';
import { SideBarPanel } from './SideBarPanel';
import { SharedWithMeLink } from './SharedWithMeLink';

interface SideBarHomePanelsProps {
  onItemClick: () => void;
}

/**
 * The per-user "home index" panels — Favorites and Shared-with-me — read from
 * the user's PRIVATE DRIVE (see {@link usePersonalDriveList}). Rendered in the
 * sidebar's bottom-pinned area (above App settings) rather than scrolling with
 * the active drive's tree, since they are cross-drive and not part of the
 * current drive's contents.
 */
export function SideBarHomePanels({
  onItemClick,
}: SideBarHomePanelsProps): JSX.Element | null {
  const { agent } = useSettings();
  const [favorites] = usePersonalDriveList(urls.properties.favorites);
  const [sharedWithMe] = usePersonalDriveList(core.properties.sharedWithMe);

  if (!agent) {
    return null;
  }

  return (
    <>
      {favorites.length > 0 && (
        <SideBarPanel title='Favorites' data-testid='favorites'>
          {favorites.map((subject: string) => (
            <SharedWithMeLink
              key={subject}
              subject={subject}
              onClick={onItemClick}
              data-testid='favorite-item'
            />
          ))}
        </SideBarPanel>
      )}
      {sharedWithMe.length > 0 && (
        <SideBarPanel title='Shared with me' data-testid='shared-with-me'>
          {sharedWithMe.map((subject: string) => (
            <SharedWithMeLink
              key={subject}
              subject={subject}
              onClick={onItemClick}
              data-testid='shared-with-me-item'
            />
          ))}
        </SideBarPanel>
      )}
    </>
  );
}
