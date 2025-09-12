import styled from 'styled-components';
import { useSettings } from '../../helpers/AppSettings';
import { paths } from '../../routes/paths';
import { AtomicLink } from '@components/AtomicLink';
import { Column } from '@components/Row';
import { FaGear } from 'react-icons/fa6';

export const NoKeyOverlay: React.FC = () => {
  const { openRouterApiKey, ollamaUrl } = useSettings();

  if (openRouterApiKey || ollamaUrl) {
    return null;
  }

  return (
    <Overlay>
      <Column gap='0.5rem' center>
        <p>No AI provider configured.</p>
        <ButtonLink clean path={paths.appSettings}>
          <FaGear /> Settings
        </ButtonLink>
      </Column>
    </Overlay>
  );
};

const Overlay = styled.div`
  position: absolute;
  inset: 0;
  backdrop-filter: blur(4px);
  background-color: ${p =>
    p.theme.darkMode ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.8)'};
  border-radius: ${p => p.theme.radius};
  z-index: 1000;
  display: grid;
  place-items: center;
`;

const ButtonLink = styled(AtomicLink)`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-radius: ${p => p.theme.radius};
  border: 1px solid ${p => p.theme.colors.bg2};
  padding: 0.3rem 1rem;
  background-color: ${p => p.theme.colors.bg};
  color: ${p => p.theme.colors.textLight};

  &:hover,
  &:focus-visible {
    color: ${p => p.theme.colors.main};
    border-color: ${p => p.theme.colors.main};
    box-shadow: ${p => p.theme.boxShadowSoft};
  }
`;
