import { resourceTheme } from '@tomic/resource-ui/theme';
import { styled } from 'styled-components';

export const FormGroupHeading = styled.h2`
  font-size: 1.1rem;
  margin-bottom: 0.2rem;
  font-family: ${p => resourceTheme(p.theme).fontFamilyHeader};
  font-weight: bold;
`;
