import {
  PropsWithChildren,
  useCallback,
  useEffect,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { styled } from 'styled-components';
import { FaCaretRight } from 'react-icons/fa6';
import { Collapse } from './Collapse';
import { IconButton } from './IconButton/IconButton';

export type DetailsPropsBase = {
  open?: boolean;
  initialState?: boolean;
  disabled?: boolean;
  /** Event that fires when a user opens or closes the details */
  onStateToggle?: (state: boolean) => void;
  noIndent?: boolean;
  subtle?: boolean;
};

type DetailsPropsWithTitle = DetailsPropsBase & {
  title: ReactNode;
  titleButton?: never;
};

type DetailsPropsWithTitleButton = DetailsPropsBase & {
  /** Label that toggles open/closed; omit the caret row. */
  titleButton: ReactNode;
  title?: never;
};

type DetailsProps = DetailsPropsWithTitle | DetailsPropsWithTitleButton;

/** A collapsible item with a title. Similar to the <details> HTML element. */
export function Details(props: PropsWithChildren<DetailsProps>): JSX.Element {
  const {
    open = false,
    subtle = false,
    initialState,
    children,
    disabled,
    noIndent,
    onStateToggle,
  } = props;

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

  return (
    <>
      <SummaryWrapper>
        {'titleButton' in props ? (
          <TitleAsButton
            type='button'
            $subtle={subtle}
            onClick={toggleOpen}
            disabled={!!disabled}
            aria-expanded={isOpen}
          >
            {props.titleButton}
          </TitleAsButton>
        ) : (
          <>
            <StyledIconButton
              type='button'
              title={isOpen ? 'collapse' : 'expand'}
              onClick={toggleOpen}
              hide={!!disabled}
              aria-label={isOpen ? 'collapse' : 'expand'}
            >
              <Icon $turn={!!isOpen} subtle={subtle} />
            </StyledIconButton>
            <TitleWrapper>{props.title}</TitleWrapper>
          </>
        )}
      </SummaryWrapper>
      <StyledCollapse open={!!isOpen} noIndent={noIndent}>
        {children}
      </StyledCollapse>
    </>
  );
}

const SummaryWrapper = styled.div`
  max-width: 100%;
  display: flex;
  align-items: center;
  gap: 0.4rem;
`;

const TitleWrapper = styled.div`
  flex: 1;
  width: 1px;
  * {
    user-select: none;
  }
`;

const TitleAsButton = styled.button<{ $subtle: boolean }>`
  flex: 1;
  width: 1px;
  text-align: left;
  border: none;
  background: transparent;
  padding: 0;
  margin: 0;
  font: inherit;
  color: ${({ theme, $subtle }) =>
    $subtle ? theme.colors.textLight : 'inherit'};
  cursor: pointer;
  display: flex;
  align-items: center;
  min-width: 0;

  &:disabled {
    cursor: default;
    opacity: 0.6;
  }

  * {
    user-select: none;
    cursor: inherit;
  }
`;

const Icon = styled(FaCaretRight)<{ $turn: boolean; subtle: boolean }>`
  color: ${({ theme, subtle }) =>
    subtle ? theme.colors.textLight : theme.colors.main};
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
  overflow-x: hidden;
  margin-left: ${p => (p.noIndent ? 0 : p.theme.margin) + 'rem'};
`;
