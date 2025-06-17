import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import {
  FaGear,
  FaInfo,
  FaKeyboard,
  FaCirclePlus,
  FaUser,
  FaCode,
} from 'react-icons/fa6';
import { isDev } from '../../config';
import { constructOpenURL } from '../../helpers/navigation';
import { useCurrentSubject } from '../../helpers/useCurrentSubject';
import { SideBarMenuItem } from './SideBarMenuItem';
import { paths } from '../../routes/paths';
import {
  core,
  unknownSubject,
  useCurrentAgent,
  useResource,
} from '@tomic/react';

// Non standard event type so we have to type it ourselfs for now.
type BeforeInstallPromptEvent = {
  preventDefault: () => void;
  prompt: () => Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export interface AppMenuProps {
  onItemClick: () => void;
}

export function AppMenu({ onItemClick }: AppMenuProps): JSX.Element {
  const event = useRef<BeforeInstallPromptEvent | null>(null);
  const [subject] = useCurrentSubject();
  const [showInstallButton, setShowInstallButton] = useState(false);
  const [agent] = useCurrentAgent();
  const agentResource = useResource(agent?.subject ?? unknownSubject);
  const install = useCallback(() => {
    if (!event.current) {
      return;
    }

    event.current.prompt().then(result => {
      if (result.outcome === 'accepted') {
        setShowInstallButton(false);
      }
    });
  }, []);

  useEffect(() => {
    const listener = (e: Event) => {
      e.preventDefault();
      setShowInstallButton(true);
      event.current = e as unknown as BeforeInstallPromptEvent;
    };

    window.addEventListener('beforeinstallprompt', listener);

    return () => window.removeEventListener('beforeinstallprompt', listener);
  }, []);

  return (
    <AppMenuSection aria-label='App menu'>
      <SideBarMenuItem
        icon={<FaUser />}
        label={
          agent
            ? (agentResource.get(core.properties.name) ?? 'User Settings')
            : 'Login / New User'
        }
        helper='See and edit the current Agent / User (u)'
        path={paths.agentSettings}
        onClick={onItemClick}
      />
      <SideBarMenuItem
        icon={<FaGear />}
        label='Settings'
        helper='Change client settings (t)'
        path={paths.appSettings}
        onClick={onItemClick}
      />
      <SideBarMenuItem
        icon={<FaInfo />}
        label='About'
        helper='Welcome page, tells about this app'
        path={paths.about}
        onClick={onItemClick}
      />
      {isDev() && (
        <SideBarMenuItem
          icon={<FaCode />}
          label='Dev Drive'
          helper='Create a fresh agent + drive on localhost:9883'
          path={paths.devDrive}
          onClick={onItemClick}
        />
      )}
      {showInstallButton && (
        <SideBarMenuItem
          icon={<FaCirclePlus />}
          label='Install App'
          helper='Install app to desktop'
          path={constructOpenURL(subject ?? window.location.href)}
          onClick={install}
        />
      )}
    </AppMenuSection>
  );
}

const AppMenuSection = styled.section`
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
`;
