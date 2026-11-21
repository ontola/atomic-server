import { resourceTheme } from '@tomic/resource-ui/theme';
import { styled } from 'styled-components';
import { CustomPopover } from '@tomic/ui/components/CustomPopover';

export const AbsoluteCell = styled.div`
  position: absolute;
  display: flex;
  align-items: center;
  z-index: 10;
  left: 0;
  top: 0;
  background-color: ${p => resourceTheme(p.theme).colors.bg};
  box-shadow: ${p => resourceTheme(p.theme).boxShadowSoft};
  border: 2px solid ${p => resourceTheme(p.theme).colors.main};
  height: fit-content;
  width: 100%;
  padding-inline: var(--table-inner-padding);
  padding-block: 3px;
  min-height: 40px;
  overflow: hidden;
`;

export const SearchPopover = styled(CustomPopover)`
  border: 1px solid ${p => resourceTheme(p.theme).colors.bg2};
  ${CustomPopover.Content} {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
`;

export const SearchResultWrapper = styled.div`
  height: min(90vh, 20rem);
  width: min(90vw, 35rem);
  overflow-x: hidden;
  overflow-y: auto;

  ol {
    padding: 0 !important;
    margin: 0;
  }

  li {
    list-style: none;
    &[data-selected='true'] button {
      background: ${p => resourceTheme(p.theme).colors.mainSelectedBg};
      color: ${p => resourceTheme(p.theme).colors.mainSelectedFg};
      box-shadow: 0 0 0 1px inset
        ${p => resourceTheme(p.theme).colors.mainSelectedFg};
      svg {
        color: ${p => resourceTheme(p.theme).colors.mainSelectedFg};
      }
    }
  }
`;

export const PopoverTrigger = styled.button`
  border: none;
  background: none;
  color: ${p => resourceTheme(p.theme).colors.main};
  display: inline-flex;
  gap: 1ch;
  align-items: center;
  user-select: none;
  cursor: pointer;
`;
