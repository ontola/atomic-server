import { Row } from '@components/Row';
import { styled } from 'styled-components';

interface ModelInfoLayoutProps {
  Pricing?: React.ReactNode;
  About?: React.ReactNode;
}

export const ModelInfoLayout = ({ Pricing, About }: ModelInfoLayoutProps) => {
  return (
    <>
      {Pricing && <Row wrapItems>{Pricing}</Row>}

      {About && <AboutWrapper>{About}</AboutWrapper>}
    </>
  );
};

ModelInfoLayout.Empty = styled.div`
  background-color: ${p => p.theme.colors.bg1};
  display: grid;
  place-items: center;
  color: ${p => p.theme.colors.textLight};
  padding: ${p => p.theme.size()};
  border-radius: ${p => p.theme.radius};
`;

const AboutWrapper = styled.div`
  background-color: ${p => p.theme.colors.bg1};
  padding: ${p => p.theme.size()};
  border-radius: ${p => p.theme.radius};
`;
