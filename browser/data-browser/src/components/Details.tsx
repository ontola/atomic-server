import {
  PropsWithChildren,
  useCallback,
  useEffect,
  useState,
  type JSX,
} from 'react';
import { styled, css } from 'styled-components';
import { FaCaretRight } from 'react-icons/fa6';
import { Collapse } from './Collapse';
import { IconButton } from './IconButton/IconButton';

export interface DetailsProps {
  open?: boolean;
  initialState?: boolean;
  title: React.ReactElement | string;
  disabled?: boolean;
  /** Event that fires when a user opens or closes the details */
  onStateToggle?: (state: boolean) => void;
  noIndent?: boolean;
  /**
   * When false, no leading caret in the summary (e.g. resource sidebar puts expand
   * affordance in the title row’s icon slot). Default true.
   */
  summaryCaret?: boolean;
}

/** A collapsible item with a title. Similar to the <details> HTML element. */
export function Details({
  open = false,
  initialState,
  children,
  title,
  disabled,
  noIndent,
  onStateToggle,
  summaryCaret = true,
}: PropsWithChildren<DetailsProps>): JSX.Element {
  const [isOpen, setIsOpen] = useState(initialState);

  useEffect(() => {
    setIsOpen(open);
  }, [open]);

  useEffect(() => {
    setIsOpen(initialState);
  }, [initialState]);

  const toggleOpen = useCallback(() => {
    setIsOpen(p => {
      onStateToggle?.(!p);

      return !p;
    });
  }, [onStateToggle]);

  const summaryRowClickToggle =
    summaryCaret && !disabled ? toggleOpen : undefined;
  const summaryClickable = summaryRowClickToggle !== null;

  return (
    <>
      <SummaryWrapper
        onClick={summaryRowClickToggle}
        $clickable={summaryClickable}
      >
        {summaryCaret ? (
          <StyledIconButton
            type='button'
            title={isOpen ? 'collapse' : 'expand'}
            onClick={e => {
              e.stopPropagation();
              toggleOpen();
            }}
            hide={!!disabled}
            aria-label={isOpen ? 'collapse' : 'expand'}
          >
            <Icon $turn={!!isOpen} />
          </StyledIconButton>
        ) : null}
        <TitleWrapper $noLeadingCaret={!summaryCaret}>{title}</TitleWrapper>
      </SummaryWrapper>
      <StyledCollapse open={!!isOpen} noIndent={noIndent}>
        {children}
      </StyledCollapse>
    </>
  );
}

const SummaryWrapper = styled.div<{ $clickable: boolean }>`
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  border-radius: ${p => p.theme.radius};
  user-select: none;
  transition: background-color ${p => p.theme.animation.duration} ease-out;

  cursor: ${p => (p.$clickable ? 'pointer' : 'default')};

  ${p =>
    p.$clickable
      ? css`
          /* Match {@link SideBarItem} padding + hover affordance */
          padding: 0.2rem;

          &:hover,
          &:focus-within {
            background-color: ${p.theme.colors.bg1};
          }

          &:active {
            background-color: ${p.theme.colors.bg2};
          }
        `
      : ''}
`;

const TitleWrapper = styled.div<{ $noLeadingCaret: boolean }>`
  flex: 1;
  min-width: 0;
  max-width: 100%;
  ${p =>
    p.$noLeadingCaret
      ? ''
      : `
    width: 1px;
  `}
  * {
    user-select: none;
  }
`;

const Icon = styled(FaCaretRight)<{ $turn: boolean }>`
  color: ${({ theme }) => theme.colors.main};
  margin-top: auto;
  cursor: pointer;
  * {
    cursor: pointer;
  }
  --speed: ${p => p.theme.animation.duration};
  transition:
    transform var(--speed) ease-in-out,
    background-color var(--speed) ease;
  transform: rotate(${props => (props.$turn ? '90deg' : '0deg')});
  aspect-ratio: 1/1;
  display: flex;
  align-items: center;
`;

const StyledIconButton = styled(IconButton)<{ hide: boolean }>`
  font-size: 1rem;
  margin-right: -0.3rem;
  visibility: ${props => (props.hide ? 'hidden' : 'visible')};
`;

const StyledCollapse = styled(Collapse)<{ noIndent?: boolean }>`
  margin-left: ${p => (p.noIndent ? 0 : p.theme.margin) + 'rem'};
`;
