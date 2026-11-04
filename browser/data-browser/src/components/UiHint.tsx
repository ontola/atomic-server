import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type PropsWithChildren,
  type RefObject,
} from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { styled, useTheme } from 'styled-components';
import { transparentize } from 'polished';
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
  const theme = useTheme();
  const { text, preview } = useUiHint(target, scope);
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

  useEffect(() => {
    const el = wrapper.current?.firstElementChild as HTMLElement | null;

    if (!el || !preview || disabled) return;

    return ringOn(el, transparentize(0.5, theme.colors.main));
  }, [preview, disabled, theme.colors.main]);

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
      <HintBody>
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
    </HintPopover>
  );
}

const HintPopover = styled(Popover)`
  max-width: min(16rem, calc(100vw - 2rem));
  padding: ${p => p.theme.size(2)};
  font-size: 0.85rem;
  color: ${p => p.theme.colors.text};

  & > svg {
    fill: ${p => p.theme.colors.bgBody};
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

/** A soft outline on the element; returns the function that takes it off. */
function ringOn(el: HTMLElement, color: string): () => void {
  const before = [el.style.outline, el.style.outlineOffset];

  el.style.outline = `2px solid ${color}`;
  el.style.outlineOffset = '2px';

  return () => {
    [el.style.outline, el.style.outlineOffset] = before;
  };
}
