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
  background-color: var(--color-bg-subtle);
  display: grid;
  place-items: center;
  color: var(--color-text-subtle);
  padding: var(--space-3);
  border-radius: var(--radius-md);
`;

const AboutWrapper = styled.div`
  background-color: var(--color-bg-subtle);
  padding: var(--space-3);
  border-radius: var(--radius-md);
`;
