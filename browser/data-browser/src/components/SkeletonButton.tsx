import { styled } from 'styled-components';
import { transition } from '../helpers/transition';

export const SkeletonButton = styled.button`
  display: flex;
  justify-content: center;
  color: ${p => p.theme.colors.textLight};
  background: none;
  appearance: none;
  border: 1px dashed ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};

  cursor: pointer;
  ${transition('color', 'border')}

  & svg {
    ${transition('transform')}
  }
  &:hover,
  &:focus-visible {
    color: ${p => p.theme.colors.main};
    border: 1px solid ${p => p.theme.colors.main};

    & svg {
      transform: scale(1.3);
    }
  }

  &:active {
    background-color: ${p => p.theme.colors.bg1};
  }
`;
