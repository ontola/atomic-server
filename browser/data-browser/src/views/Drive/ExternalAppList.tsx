import type React from 'react';
import { FaArrowUpRightFromSquare } from 'react-icons/fa6';
import { styled } from 'styled-components';
import ResourceRow from '../ResourceRow';
import { SettingsSection } from '@components/Settings';
import { useExternalApps } from '@hooks/useExternalApps';

/**
 * The apps registered in a drive (`ExternalApp`), such as native apps that
 * write their own classes into it. The whole section is hidden when there
 * are none.
 */
export const ExternalAppList: React.FC<{ drive: string }> = ({ drive }) => {
  const apps = useExternalApps(drive);

  if (apps.length === 0) {
    return null;
  }

  return (
    <SettingsSection label='Apps in this drive' initialState>
      <List>
        {apps.map(app => (
          <div key={app.subject}>
            <ResourceRow
              subject={app.subject}
              trailing={
                app.homepage && isHttp(app.homepage) ? (
                  <a
                    href={app.homepage}
                    target='_blank'
                    rel='noopener noreferrer'
                    aria-label={`Open the ${app.name} homepage`}
                  >
                    <FaArrowUpRightFromSquare />
                  </a>
                ) : undefined
              }
            />
          </div>
        ))}
      </List>
    </SettingsSection>
  );
};

function isHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size(2)};
`;
