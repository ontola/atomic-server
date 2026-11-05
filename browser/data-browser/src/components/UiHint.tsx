import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type PropsWithChildren,
  type RefObject,
} from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { styled } from 'styled-components';
import { LuX } from 'react-icons/lu';
import { Popover } from './Popover';
import { IconButton } from './IconButton/IconButton';
import {
  dismissUiHint,
  registerUiHintTarget,
  useUiHint,
  type UiHintTarget,
} from '../hooks/uiHint';

interface UiHintProps {
  target: UiHintTarget;
  /** Tells apart several elements with the same target, such as two titles. */
  scope?: string;
  disabled?: boolean;
}

/**
 * Wraps one element that a hint can point at (see `showUiHint`). Renders no
 * box of its own. The callout stays until it is closed (X or Escape) or the
 * element itself is used.
 */
export function UiHint({
  target,
  scope,
  disabled,
  children,
}: PropsWithChildren<UiHintProps>): JSX.Element {
  const wrapper = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const { text, nudge } = useUiHint(target, scope);
  const shown = text !== undefined && !disabled;

  // The element is the wrapper's child: the wrapper has no box to anchor on.
  // Read lazily, as a title swaps its element when it turns into an input.
  const [anchor] = useState(() => ({
    get current(): HTMLElement | null {
      return wrapper.current?.firstElementChild as HTMLElement | null;
    },
  }));

  useEffect(() => {
    const el = wrapper.current?.firstElementChild as HTMLElement | null;

    if (!el || disabled) return;

    return registerUiHintTarget(target, el);
  }, [target, disabled]);

  // A short bounce toward the target, to say "this one". The content may
  // still be mounting, so wait out its entrance.
  useEffect(() => {
    if (!shown || !nudge) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const t = setTimeout(() => {
      const content = body.current?.parentElement;

      if (!content) return;

      // Toward the target: up for a callout below it, down when flipped.
      const dir = content.dataset.side === 'top' ? 4 : -4;
      const at = (n: number) => `0 ${n}px`;

      content.animate(
        { translate: ['0 0', at(dir), '0 0', at(dir / 2), '0 0'] },
        { duration: 400, easing: 'ease-in-out' },
      );
    }, 150);

    return () => clearTimeout(t);
  }, [shown, nudge]);

  useEffect(() => {
    if (!shown) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissUiHint();
    };

    document.addEventListener('keydown', onKey);

    return () => document.removeEventListener('keydown', onKey);
  }, [shown]);

  return (
    <HintPopover
      open={shown}
      noLock
      noArrow
      side='bottom'
      // Not the popover's own dismissal: a new page's title takes focus on
      // arrival, which it would count as an outside interaction.
      onOpenChange={() => {}}
      onOpenAutoFocus={e => e.preventDefault()}
      onCloseAutoFocus={e => e.preventDefault()}
      Trigger={
        <>
          <div
            ref={wrapper}
            style={{ display: 'contents' }}
            onPointerDownCapture={shown ? dismissUiHint : undefined}
            onKeyDownCapture={
              shown
                ? e => {
                    if (e.key === 'Enter' || e.key === ' ') dismissUiHint();
                  }
                : undefined
            }
          >
            {children}
          </div>
          <RadixPopover.Anchor virtualRef={anchor as RefObject<HTMLElement>} />
        </>
      }
    >
      <HintBody ref={body}>
        <HintText data-testid={`ui-hint-${target}`}>{text}</HintText>
        <IconButton
          title='Close'
          aria-label='Close'
          data-testid='ui-hint-close'
          size='0.9em'
          onClick={dismissUiHint}
        >
          <LuX />
        </IconButton>
      </HintBody>
      <RadixPopover.Arrow asChild width={14} height={7}>
        <svg viewBox='0 0 30 10' preserveAspectRatio='none'>
          {/* Covers the bubble's border under the arrow's base. */}
          <rect x='2' y='-3' width='26' height='3.5' />
          <path d='M0 0 L15 10 L30 0' vectorEffect='non-scaling-stroke' />
        </svg>
      </RadixPopover.Arrow>
    </HintPopover>
  );
}

const HintPopover = styled(Popover)`
  max-width: min(16rem, calc(100vw - 2rem));
  padding: ${p => p.theme.size(2)};
  font-size: 0.85rem;
  color: ${p => p.theme.colors.text};

  background-color: ${p => p.theme.colors.bgBody};
  border: 1px solid ${p => p.theme.colors.bg2};

  & > span > svg {
    overflow: visible;
    fill: ${p => p.theme.colors.bgBody};
    stroke: none;

    path {
      stroke: ${p => p.theme.colors.bg2};
      stroke-width: 1px;
    }
  }
`;

const HintBody = styled.div`
  display: flex;
  align-items: flex-start;
  gap: ${p => p.theme.size(2)};
`;

const HintText = styled.p`
  margin: 0;
  flex: 1;
  line-height: 1.4;
`;
