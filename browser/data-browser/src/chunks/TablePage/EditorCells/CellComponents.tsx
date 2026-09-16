import { styled } from 'styled-components';
import { CustomPopover } from '@components/CustomPopover';

export const AbsoluteCell = styled.div`
  position: absolute;
  display: flex;
  align-items: center;
  z-index: 10;
  left: 0;
  top: 0;
  background-color: var(--color-bg);
  box-shadow: var(--elevation-2);
  border: 2px solid var(--color-accent);
  height: fit-content;
  width: 100%;
  padding-inline: var(--table-inner-padding);
  padding-block: 3px;
  min-height: 40px;
  overflow: hidden;
`;

export const SearchPopover = styled(CustomPopover)`
  border: 1px solid var(--color-border);
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
      background: var(--color-accent-subtle);
      color: var(--color-accent-text);
      box-shadow: 0 0 0 1px inset var(--color-accent-text);
      svg {
        color: var(--color-accent-text);
      }
    }
  }
`;

export const PopoverTrigger = styled.button`
  border: none;
  background: none;
  color: var(--color-accent);
  display: inline-flex;
  gap: 1ch;
  align-items: center;
  user-select: none;
  cursor: pointer;
`;
