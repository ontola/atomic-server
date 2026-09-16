import { forwardRef, PropsWithChildren, type JSX } from 'react';
import { styled, css } from 'styled-components';
import { transition } from '../helpers/transition';
import { Spinner } from './Spinner';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Description of the button, required if the button only has an icon */
  name?: string;
  /** Renders the button less clicky */
  subtle?: boolean;
  alert?: boolean;
  /** If it's just an icon */
  icon?: boolean;
  /** Minimal styling */
  clean?: boolean;
  /** Ghost pill: transparent until hover, icon+label secondary action (e.g. "Add cover", "Edit"). */
  ghost?: boolean;
  /** Shows loading text + a spinner */
  loading?: string;
  /** Add a bottom margin */
  gutter?: boolean;
  onClick?: (e: React.MouseEvent) => unknown;
  className?: string;
  as?: keyof HTMLElementTagNameMap;
}

interface ButtonPropsStyled {
  $gutter?: boolean;
}

const getButtonComp = ({ clean, icon, subtle, alert, ghost }: ButtonProps) => {
  let Comp = ButtonDefault;

  if (subtle) {
    Comp = ButtonSubtle;
  }

  if (alert) {
    Comp = ButtonAlert;
  }

  if (icon) {
    Comp = ButtonIcon;
  }

  if (ghost) {
    Comp = ButtonGhost;
  }

  if (clean) {
    Comp = ButtonClean;
  }

  return Comp;
};

export const Button = forwardRef<
  HTMLButtonElement,
  PropsWithChildren<ButtonProps>
>(({ children, loading, ...props }, ref): JSX.Element => {
  // Styling-only flags: consumed here to pick a variant / the $gutter
  // transient prop, then dropped so they never reach the DOM button element.
  const {
    icon: _icon,
    subtle: _subtle,
    alert: _alert,
    clean: _clean,
    ghost: _ghost,
    gutter,
    ...buttonProps
  } = props;

  const Comp = getButtonComp(props);

  return (
    <Comp
      type='button'
      {...buttonProps}
      $gutter={gutter}
      aria-busy={loading ? true : undefined}
      ref={ref}
    >
      {loading ? (
        <>
          {/* Sized to the label so the button keeps its height, and coloured
              from the button's own text so it reads on every variant. The
              label stays rendered: it says what is being waited on, and it
              keeps the button's accessible name. */}
          <Spinner size='1em' inheritColor />
          {loading}
        </>
      ) : (
        children
      )}
    </Comp>
  );
});

Button.displayName = 'Button';

/** Extremly minimal set of button properties */
export const ButtonClean = styled.button<ButtonPropsStyled>`
  cursor: pointer;
  border: none;
  font-size: inherit;
  padding: 0;
  color: inherit;
  margin: 0;
  appearance: none;
  background-color: initial;
  -webkit-tap-highlight-color: transparent; /* Remove the tap / click effect on touch devices */
  user-select: none;
`;

/** Base button style. You're likely to want to use ButtonMargin in most places */
export const ButtonBase = styled(ButtonClean)<ButtonPropsStyled>`
  /* A floor, not a fixed height: a label that wraps needs room for the extra
     line. With a fixed height the second line was simply clipped. Variants
     that set their own exact size (ButtonIcon) opt out with min-height: 0. */
  min-height: var(--space-7);
  display: flex;
  align-items: center;
  gap: 1ch;
  justify-content: center;
  background-color: var(--color-accent);
  color: var(--color-bg);
  /* Long labels used to run off the side of narrow (phone) screens rather
     than wrap. The anywhere value covers the unbreakable cases too: a
     recovery code or a URL in a label has no space to break at. */
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: center;
  margin-bottom: ${p => (p.$gutter ? `var(--space-3)` : '')};
  ${transition(
    'background-color',
    'box-shadow',
    'transform',
    'color',
    'border-color',
    'opacity',
  )};

  // Prevent sticky hover buttons on touch devices
  @media (hover: hover) and (pointer: fine) {
    &:hover:not([disabled]),
    &:focus-visible:not([disabled]) {
      border-color: var(--color-accent);
      outline: 0;
    }
  }

  &:active:not([disabled]) {
    transition: all 0s;
    /* background-color: var(--color-accent-text); */
    /* color: var(--color-bg); */
  }

  &:disabled {
    cursor: default;
    display: auto;
    opacity: 0.5;
  }
`;

interface ButtonBarProps {
  leftPadding?: boolean;
  rightPadding?: boolean;
  selected?: boolean;
}

/** Button inside the navigation bar */
export const ButtonBar = styled(ButtonClean)<ButtonBarProps>`
  padding-right: var(--space-2);
  padding-left: var(--space-2);
  color: var(--color-accent-text);
  background-color: ${p =>
    p.selected ? 'var(--color-border)' : 'var(--color-bg)'};
  height: 100%;
  display: flex;
  align-items: center;

  &:hover:not([disabled]),
  /* &:active:not([disabled]), */
  &:focus-visible:not([disabled]) {
    background-color: var(--color-bg-subtle);
  }

  &:active:not([disabled]) {
    background-color: var(--color-border);
  }

  padding-left: ${p => (p.leftPadding ? 'var(--space-4)' : '')};
  padding-right: ${p => (p.rightPadding ? 'var(--space-3)' : '')};
`;

/** Button with some optional margins around it */
export const ButtonDefault = styled(ButtonBase)<ButtonPropsStyled>`
  --button-bg-color: var(--color-accent);
  --button-bg-color-hover: var(--color-accent-hover);
  --button-border-color: var(--color-accent);
  --button-border-color-hover: var(--color-accent-hover);
  /* The label of a filled accent surface, not the page background. Those used
     to be the same value, which is how seven of the eight main-colour presets
     shipped a primary button below 4.5:1 -- see styles/accentRamp.ts. */
  --button-text-color: var(--color-on-accent);
  --button-text-color-hover: var(--color-on-accent);

  border-radius: var(--radius-md);
  /* Was 0.4rem, which is not on any scale. The nearest step is roomier, and
     with the 2rem floor it lands on a 2.5rem control -- a real touch target. */
  padding-block: var(--space-2);
  padding-inline: var(--space-3);
  display: inline-flex;
  background-color: var(--button-bg-color);
  color: var(--button-text-color);
  border: solid 1px var(--button-border-color);

  &:focus-visible:not([disabled]),
  &:hover:not([disabled]) {
    box-shadow: var(--elevation-2);
    background-color: var(--button-bg-color-hover);
    color: var(--button-text-color-hover);
    border-color: var(--button-border-color-hover);
  }

  &:active:not([disabled]) {
    box-shadow: inset var(--elevation-3);
  }
`;

export const ButtonSubtle = styled(ButtonDefault)`
  --button-bg-color: var(--color-bg);
  --button-bg-color-hover: var(--color-bg);
  --button-border-color: var(--color-border);
  --button-border-color-hover: var(--color-accent);
  --button-text-color: var(--color-text-subtle);
  --button-text-color-hover: var(--color-accent);
`;

export const ButtonAlert = styled(ButtonDefault)`
  --button-bg-color: var(--color-alert);
  --button-bg-color-hover: var(--color-alert-subtle);
  --button-border-color: var(--color-alert);
  --button-border-color-hover: var(--color-alert-subtle);
`;

/**
 * Ghost pill: transparent until hover, then a soft background — for
 * secondary icon+label actions (e.g. "Add cover", "Edit") that shouldn't
 * compete visually with primary buttons. Exported as a standalone css block
 * (not just the styled component below) so call sites that can't literally
 * render `<Button>` — e.g. a Radix `Popover.Trigger`, which must stay a
 * real Radix component — can still apply the identical style.
 */
export const ghostButtonStyles = css`
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  border: none;
  background-color: transparent;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-md);
  color: var(--color-text-subtle);
  font-size: var(--font-size-sm);
  cursor: pointer;
  ${transition('background-color', 'color')};

  &:hover:not([disabled]),
  &:focus-visible:not([disabled]) {
    background-color: var(--color-bg-subtle);
    color: var(--color-text);
  }

  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
`;

export const ButtonGhost = styled(ButtonClean)<ButtonPropsStyled>`
  ${ghostButtonStyles}
`;

/** Button that only shows an icon */
export const ButtonIcon = styled(ButtonDefault)`
  box-shadow: none;
  border-color: transparent;
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  width: 1.3rem;
  height: 1.3rem;
  /* This variant is exactly sized and holds no text, so the base's wrapping
     floor would only inflate it. */
  min-height: 0;
  display: inline-flex;
  margin: 0;
  padding: 0;

  &:active:not([disabled]) {
    box-shadow: var(--elevation-3);
  }

  &:active:not([disabled]) {
    box-shadow: inset var(--elevation-3);
  }
`;

/** A button inside an input field */
export const ButtonInput = styled(ButtonBase)`
  padding: 0 0.5rem;
  background-color: var(--color-bg);
  color: var(--color-text-subtle);
  flex: 0;
  height: auto;
  /* Sized by the field it sits in, which can be shorter than the base floor. */
  min-height: 0;
  border-left: solid 1px var(--color-border);
  border-radius: 0;

  /** Prevent sticky hover buttons on touch devices */
  @media (hover: hover) and (pointer: fine) {
    &:hover:not([disabled]),
    &:active:not([disabled]),
    &:focus-visible:not([disabled]) {
      color: var(--color-accent);
      background-color: var(--color-bg-subtle);
    }
  }

  &:last-child {
    border-radius: var(--radius-md);
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }
`;
