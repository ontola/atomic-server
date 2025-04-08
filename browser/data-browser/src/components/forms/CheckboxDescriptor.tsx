import { useId } from 'react';
import { CheckboxLabel } from './Checkbox';
import { styled } from 'styled-components';

interface CheckboxDescriptorProps {
  label: string;
  description: string;
  children: (id: string) => React.ReactNode;
}

export const CheckboxDescriptor = ({
  label,
  description,
  children,
}: CheckboxDescriptorProps) => {
  const id = useId();

  return (
    <Grid>
      {children(id)}
      <CheckboxLabel htmlFor={id}>{label}</CheckboxLabel>
      <Subtle>{description}</Subtle>
    </Grid>
  );
};

const Subtle = styled.p`
  grid-column: 2;
  font-size: 0.8rem;
  margin: 0;
  color: ${p => p.theme.colors.textLight};
`;

const Grid = styled.div`
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 1ch;
  align-items: center;
`;
