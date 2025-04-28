import {
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react';
import { styled } from 'styled-components';
import { transparentize } from 'polished';
import { fadeIn } from '@helpers/commonAnimations';
import { useControlLock } from '@hooks/useControlLock';
import { useDialogTreeInfo } from './Dialog/dialogContext';
import { useControllable } from '@hooks/useControlable';

export interface TriggerProps {
  onClick: () => void;
  'data-popover-target': string;
}

export interface PopoverProps {
  Trigger: (props: TriggerProps) => ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
  noArrow?: boolean;
  noLock?: boolean;
  modal?: boolean;
  side?: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * Popover component, consists of an outer dialog element and an inner content div.
 * To style the content div use `${CustomPopover.Content}: { ... }`
 */
export function CustomPopover({
  Trigger,
  open: parentOpen,
  defaultOpen,
  onOpenChange,
  className,
  noLock,
  side = 'top',
  modal,
  children,
}: React.PropsWithChildren<PopoverProps>) {
  const popoverRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const setElementState = (state: boolean) => {
    if (state && !popoverRef.current?.hasAttribute('open')) {
      if (modal) {
        popoverRef.current?.showModal();
      } else {
        popoverRef.current?.show();
      }
    } else if (!state && popoverRef.current?.hasAttribute('open')) {
      popoverRef.current?.close();
    }
  };

  const onStateChange = (state: boolean) => {
    setElementState(state);
    setHasOpenInnerPopup(state);

    onOpenChange?.(state);
  };

  const [open, setOpen] = useControllable({
    controlledValue: parentOpen,
    defaultValue: defaultOpen,
    onChange: onStateChange,
  });

  const { setHasOpenInnerPopup } = useDialogTreeInfo();

  const handleOutsideClick = (
    e: React.MouseEvent<HTMLDialogElement, MouseEvent>,
  ) => {
    if (
      !contentRef.current?.contains(e.target as HTMLElement) &&
      contentRef.current !== e.target
    ) {
      setOpen(false);
    }
  };

  const setElementStateEffect = useEffectEvent((state: boolean) => {
    setElementState(state);
  });

  useLayoutEffect(() => {
    setElementStateEffect(!!open);
  }, [open]);

  useControlLock(!noLock && !!open);

  return (
    <Wrapper anchorName={id}>
      <Trigger
        onClick={() => setOpen(prev => !prev)}
        data-popover-target={id}
      />
      <Popover
        anchorName={id}
        popover='auto'
        ref={popoverRef}
        id={id}
        side={side}
        onMouseDown={e => handleOutsideClick(e)}
        className={className}
      >
        <PopoverContent ref={contentRef}>{open && children}</PopoverContent>
      </Popover>
    </Wrapper>
  );
}

const PopoverContent = styled.div``;

CustomPopover.Content = PopoverContent;

const Wrapper = styled.div<{ anchorName: string }>`
  display: contents;

  & button[data-popover-target='${p => p.anchorName}'] {
    anchor-name: --${p => p.anchorName};
  }
`;

const Popover = styled.dialog<{ anchorName: string; side: string }>`
  border: none;
  background-color: ${p => transparentize(0.2, p.theme.colors.bgBody)};
  backdrop-filter: blur(10px);
  box-shadow: ${p => p.theme.boxShadowSoft};
  border-radius: ${p => p.theme.radius};
  animation: ${fadeIn} 0.1s ease-in-out;
  margin: 0;
  padding: 0;
  inset: auto;
  position-anchor: --${p => p.anchorName};
  position-area: ${p => p.side};
  position-try-fallbacks: flip-block;
  max-height: unset;
  &::backdrop {
    background-color: transparent;
  }
`;
