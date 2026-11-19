import { uiTheme } from '../theme.js';
import { styled } from 'styled-components';
import { transition } from '../helpers/transition.js';

export const SkeletonButton = styled.button`
  display: flex;
  justify-content: center;
  align-items: center;
  gap: ${p => uiTheme(p.theme).size(1)};
  color: ${p => uiTheme(p.theme).colors.textLight};
  background: none;
  appearance: none;
  border: 1px dashed ${p => uiTheme(p.theme).colors.bg2};
  border-radius: ${p => uiTheme(p.theme).radius};

  cursor: pointer;
  ${transition('color', 'border')}

  & svg {
    ${transition('transform')}
  }
  &:hover,
  &:focus-visible {
    color: ${p => uiTheme(p.theme).colors.main};
    border: 1px solid ${p => uiTheme(p.theme).colors.main};

    & svg {
      transform: scale(1.3);
    }
  }

  &:active {
    background-color: ${p => uiTheme(p.theme).colors.bg1};
  }
`;
