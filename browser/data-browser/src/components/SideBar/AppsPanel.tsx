import type { JSX } from 'react';
import { FaPlus } from 'react-icons/fa6';
import { appPanelSubjects, useDriveApps } from '@chunks/AppPage/useDriveApps';
import { useInstallations } from '../../views/Drive/PluginList';
import { useSettings } from '../../helpers/AppSettings';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { paths } from '../../routes/paths';
import { SharedWithMeLink } from './SharedWithMeLink';
import {
  SideBarMenuRow,
  SideBarMenuRowIcon,
  SideBarMenuRowLabel,
} from './SideBarMenuItem';
import { SideBarPanel } from './SideBarPanel';
import { Panel, panelTitle } from './usePanelList';

/** The drive's apps and installed apps, with a way to find more. */
export function AppsPanel({
  onItemClick,
}: {
  onItemClick: () => void;
}): JSX.Element {
  const { drive } = useSettings();
  const { apps } = useDriveApps(drive);
  const installations = useInstallations(drive ?? '');
  const navigate = useNavigateWithTransition();
  const subjects = appPanelSubjects(
    apps.map(app => app.subject),
    installations,
  );

  return (
    <SideBarPanel
      title={panelTitle(Panel.Apps)}
      panel={Panel.Apps}
      heightStorageKey='appsPanelHeight'
      initialHeight={160}
      data-testid='apps-panel'
    >
      {subjects.map(subject => (
        <SharedWithMeLink
          key={subject}
          subject={subject}
          onClick={onItemClick}
          data-testid='apps-panel-item'
        />
      ))}
      <SideBarMenuRow
        onClick={() => {
          navigate(paths.apps);
          onItemClick();
        }}
      >
        <SideBarMenuRowIcon>
          <FaPlus />
        </SideBarMenuRowIcon>
        <SideBarMenuRowLabel>Discover apps</SideBarMenuRowLabel>
      </SideBarMenuRow>
    </SideBarPanel>
  );
}
