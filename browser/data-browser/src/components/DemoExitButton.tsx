import { useState } from 'react';
import { styled } from 'styled-components';
import { FaRightFromBracket } from 'react-icons/fa6';
import { useStore } from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../helpers/navigation';
import { fetchPersonalDriveSubject } from '../helpers/personalDrive';
import { paths } from '../routes/paths';
import {
  SideBarMenuRow,
  SideBarMenuRowIcon,
  SideBarMenuRowLabel,
} from './SideBar/SideBarMenuItem';

/**
 * The way out of the demo workspace: a sidebar menu row shown whenever
 * the demo drive is active. Guests go to sign-up; signed-in users go
 * back to their own drive. Stops the scripted scenario either way.
 * Reads the demo manifest straight from localStorage — cheap, and it
 * keeps the heavy demo chunk out of the main bundle (only the click
 * loads it, to stop the director).
 */
export function DemoExitMenuItem({
  onItemClick,
}: {
  onItemClick?: () => void;
}): React.JSX.Element | null {
  const store = useStore();
  const { drive } = useSettings();
  const navigate = useNavigateWithTransition();
  const [leaving, setLeaving] = useState(false);

  const demoDrive = readDemoDrive();

  if (!demoDrive || drive !== demoDrive) {
    return null;
  }

  async function handleExit() {
    if (leaving) return;
    setLeaving(true);
    onItemClick?.();

    try {
      const { stopDemoDirector } = await import('../chunks/Demo/startDemo');
      stopDemoDirector();
    } catch {
      // The demo chunk failing to load must not trap the user here.
    }

    const agent = store.getAgent();
    const home = agent
      ? await fetchPersonalDriveSubject(store, agent).catch(() => undefined)
      : undefined;

    if (home) {
      store.setDrive(home);
      navigate(constructOpenURL(home));
    } else {
      // A demo guest has no personal drive: the way out is sign-up.
      navigate(paths.onboarding);
    }

    setLeaving(false);
  }

  return (
    <ExitRow
      as='button'
      type='button'
      title='Leave the demo workspace'
      onClick={handleExit}
    >
      <SideBarMenuRowIcon>
        <FaRightFromBracket />
      </SideBarMenuRowIcon>
      <SideBarMenuRowLabel>
        {leaving ? 'Leaving…' : 'Exit demo'}
      </SideBarMenuRowLabel>
    </ExitRow>
  );
}

function readDemoDrive(): string | undefined {
  try {
    const raw = localStorage.getItem('atomic.demoWorkspace');

    return raw ? (JSON.parse(raw) as { drive?: string }).drive : undefined;
  } catch {
    return undefined;
  }
}

const ExitRow = styled(SideBarMenuRow)`
  border: none;
  cursor: pointer;
  width: 100%;
  color: white;
  padding-top: 0.5rem;
  padding-bottom: 0.5rem;
  background: ${p => p.theme.colors.main};

  &:hover,
  &:focus-visible {
    background: ${p => p.theme.colors.mainDark ?? p.theme.colors.main};
    color: white;
  }
`;
