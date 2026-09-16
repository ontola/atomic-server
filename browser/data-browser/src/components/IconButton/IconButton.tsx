import {
  ComponentType,
  ButtonHTMLAttributes,
  AnchorHTMLAttributes,
} from 'react';
import { styled, keyframes } from 'styled-components';
import { transition } from '../../helpers/transition';
import { adjustHue } from 'polished';
import { colorTokens, type ColorTokenName } from '../../styles/colorTokens';

export enum IconButtonVariant {
  Simple,
  Outline,
  Fill,
  Colored,
  Square,
  Magic,
}

type ColorProp = ColorTokenName | 'inherit';

type BaseProps = {
  className?: string;
  variant?: IconButtonVariant;
  color?: ColorProp;
  size?: string;
  title: string;
  edgeAlign?: 'start' | 'end';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  as?: string | ComponentType<any>;
};

export type IconButtonProps = BaseProps &
  ButtonHTMLAttributes<HTMLButtonElement> & {
    ref?: React.Ref<HTMLButtonElement | null>;
  };

export const IconButton: React.FC<React.PropsWithChildren<IconButtonProps>> = ({
  variant = IconButtonVariant.Simple,
  color = 'inherit',
  size = '1em',
  children,
  ref,
  ...props
}) => {
  const Comp = ComponentMap.get(variant!) ?? SimpleIconButton;

  return (
    <Comp ref={ref} color={color} size={size} {...props}>
      {children}
    </Comp>
  );
};

export type IconButtonLinkProps = BaseProps &
  AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    ref?: React.Ref<HTMLAnchorElement | null>;
  };

export const IconButtonLink: React.FC<
  React.PropsWithChildren<IconButtonLinkProps>
> = ({
  variant = IconButtonVariant.Simple,
  color = 'inherit',
  size = '1em',
  ref,
  children,
  ...props
}) => {
  const Comp = ComponentMap.get(variant ?? IconButtonVariant.Simple)!;

  return (
    <Comp ref={ref} color={color!} size={size} as='a' {...props}>
      {children}
    </Comp>
  );
};

interface ButtonBaseProps {
  size?: string;
  edgeAlign?: 'start' | 'end';
}

const IconButtonBase = styled.button<ButtonBaseProps>`
  --button-padding: 0.4em;
  cursor: pointer;
  display: inline-grid;
  place-items: center;
  ${transition('background-color', 'color', 'box-shadow', 'filter')};
  color: var(--color-text);
  font-size: ${p => p.size ?? '1em'};
  border: none;
  user-select: none;
  padding: var(--button-padding);
  aspect-ratio: 1/1;
  height: 2em;
  margin-inline-start: ${p =>
    p.edgeAlign === 'start' ? 'calc(var(--button-padding) * -1)' : '0'};

  margin-inline-end: ${p =>
    p.edgeAlign === 'end' ? 'calc(var(--button-padding) * -1)' : '0'};
  &[disabled] {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

interface ButtonStyleProps {
  color: ColorProp;
}

const SimpleIconButton = styled(IconButtonBase)<ButtonStyleProps>`
  color: ${p => (p.color === 'inherit' ? 'inherit' : colorTokens[p.color])};
  background-color: transparent;
  border-radius: var(--radius-md);

  &:not([disabled]) {
    &:hover,
    &:focus-visible {
      background-color: var(--color-bg-subtle);
    }

    &:active {
      background-color: var(--color-border);
    }
  }
`;

const OutlineIconButton = styled(IconButtonBase)<ButtonStyleProps>`
  color: ${p => (p.color === 'inherit' ? 'inherit' : colorTokens[p.color])};
  background-color: var(--color-bg);
  border-radius: 50%;

  &:not([disabled]) {
    &:hover,
    &:focus-visible {
      color: var(--color-accent);
      box-shadow:
        0px 0px 0px 1.5px var(--color-accent),
        var(--elevation-2);
    }
  }

  &&:active {
    background-color: var(--color-accent);
    color: white;
  }
`;

const SquareIconButton = styled(IconButtonBase)<ButtonStyleProps>`
  color: ${p => (p.color === 'inherit' ? 'inherit' : colorTokens[p.color])};
  background-color: var(--color-bg);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);

  &:not([disabled]) {
    &:hover,
    &:focus-visible {
      color: var(--color-accent);
      border-color: var(--color-accent);
      box-shadow: var(--elevation-2);
    }
  }

  &&:active {
    background-color: var(--color-accent);
    color: white;
  }
`;

const FillIconButton = styled(IconButtonBase)<ButtonStyleProps>`
  color: ${p => (p.color === 'inherit' ? 'inherit' : colorTokens[p.color])};
  background-color: unset;
  border-radius: 50%;
  &:hover,
  &:focus-visible {
    color: white;
    background-color: var(--color-accent);
    box-shadow: var(--elevation-2);
  }
`;

const ColoredIconButton = styled(IconButtonBase)<ButtonStyleProps>`
  color: white;
  background-color: ${p =>
    p.color === 'inherit' ? 'inherit' : colorTokens[p.color]};
  border-radius: 50%;
  &:hover,
  &:focus-visible {
    color: white;
    filter: brightness(1.3);
    box-shadow: var(--elevation-2);
  }
`;

const cycle = keyframes`
  from {
    filter: hue-rotate(0deg) brightness(var(--brightness-factor)) saturate(1.5);
  }
  to {
    filter: hue-rotate(360deg) brightness(var(--brightness-factor)) saturate(2);
  }
`;

const MagicIconButton = styled(IconButtonBase)<ButtonStyleProps>`
  --border-width: 2px;
  --brightness-factor: ${p => (p.theme.darkMode ? 1 : 1.5)};
  --bg-opacity: ${p => (p.theme.darkMode ? 0.5 : 0.8)};
  background: transparent;
  position: relative;
  color: inherit;
  aspect-ratio: 1/1;
  ${transition('color', 'background')}

  &::before,
  &::after {
    aspect-ratio: 1/1;
    content: '';
    position: absolute;
    transform: scale(0);
    ${transition('opacity', 'transform')}
  }

  &::before {
    border-radius: var(--radius-md);
    inset: 0;
    opacity: 0;
    z-index: -2;
    will-change: filter;
    background:
      radial-gradient(ellipse at top right, #365ccd, transparent),
      radial-gradient(
        ellipse at bottom left,
        ${adjustHue(-45, '#365ccd')},
        transparent
      ),
      radial-gradient(
        ellipse at bottom right,
        ${adjustHue(180, '#365ccd')},
        transparent
      );
  }
  &::after {
    content: '';
    aspect-ratio: 1/1;
    backdrop-filter: blur(9px);
    position: absolute;
    inset: var(--border-width);
    opacity: var(--bg-opacity);
    will-change: transform;
    border-radius: calc(var(--radius-md) - var(--border-width));
    background: var(--color-bg);
    z-index: -1;
  }

  &:hover,
  &:focus-visible {
    color: var(--color-text);
    &::before,
    &::after {
      transform: scale(1);
    }
    &::before {
      opacity: 1;
      animation: ${cycle} 3s linear infinite;
    }
  }

  &:active {
    filter: brightness(0.8);
  }
`;

const ComponentMap = new Map([
  [IconButtonVariant.Simple, SimpleIconButton],
  [IconButtonVariant.Outline, OutlineIconButton],
  [IconButtonVariant.Fill, FillIconButton],
  [IconButtonVariant.Colored, ColoredIconButton],
  [IconButtonVariant.Square, SquareIconButton],
  [IconButtonVariant.Magic, MagicIconButton],
]);
