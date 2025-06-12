import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { styled } from 'styled-components';
import { transparentize } from 'polished';
import { fadeIn } from '@helpers/commonAnimations';
import { useControlLock } from '@hooks/useControlLock';
import { useDialogTreeInfo } from './Dialog/dialogContext';
import { useOnValueChange } from '@helpers/useOnValueChange';

export interface TriggerProps {
  onClick: () => void;
  'data-popover-target': string;
}

export interface PopoverPropsFromHook {
  isOpen: boolean;
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  anchorName: string;
}
export interface PopoverProps extends PopoverPropsFromHook {
  Trigger: ReactNode;
  className?: string;
  noLock?: boolean;
}

export interface UsePopoverProps {
  defaultOpen?: boolean;
  autoFocusElement?: RefObject<HTMLElement | null>;
}

export interface UsePopoverReturn {
  triggerProps: {
    onClick: () => void;
    'data-popover-target': string;
  };
  popoverProps: PopoverPropsFromHook;
  openPopover: () => void;
  closePopover: () => void;
  isOpen: boolean;
}

export const usePopover = ({
  defaultOpen = false,
  autoFocusElement,
}: UsePopoverProps): UsePopoverReturn => {
  const id = useId();
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const { setHasOpenInnerPopup } = useDialogTreeInfo();

  const openPopover = () => {
    setIsOpen(true);
  };

  const closePopover = () => {
    setIsOpen(false);
  };

  const triggerProps = {
    onClick: () => setIsOpen(prev => !prev),
    'data-popover-target': id,
  };

  const popoverProps = {
    anchorName: id,
    isOpen,
    setIsOpen,
  };

  const hasFocusedRef = useRef(false);

  useOnValueChange(() => {
    setHasOpenInnerPopup(isOpen);

    if (!isOpen) {
      hasFocusedRef.current = false;
    }
  }, [isOpen]);

  useEffect(() => {
    if (
      isOpen &&
      autoFocusElement &&
      autoFocusElement.current &&
      !hasFocusedRef.current
    ) {
      autoFocusElement.current.focus();
      hasFocusedRef.current = true;
    }
  }, [isOpen, autoFocusElement]);

  return { triggerProps, popoverProps, openPopover, closePopover, isOpen };
};

/**
 * Popover component, consists of an outer dialog element and an inner content div.
 * To style the content div use `${CustomPopover.Content}: { ... }`
 */
export function CustomPopover({
  Trigger,
  anchorName,
  isOpen,
  setIsOpen,
  className,
  noLock,
  children,
}: React.PropsWithChildren<PopoverProps>) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && !popoverRef.current?.matches(':popover-open')) {
      popoverRef.current?.showPopover();
    } else if (!isOpen && popoverRef.current?.matches(':popover-open')) {
      popoverRef.current?.hidePopover();
    }
  }, [isOpen]);

  useEffect(() => {
    const handleToggle = (e: ToggleEvent) => {
      if (e.newState === 'closed') {
        setIsOpen(false);
      }
    };

    if (!popoverRef.current) return;

    const popover = popoverRef.current;
    popover.addEventListener('toggle', handleToggle);

    return () => {
      popover.removeEventListener('toggle', handleToggle);
    };
  }, [setIsOpen]);

  useControlLock(!noLock && !!isOpen);

  return (
    <Wrapper anchorName={anchorName}>
      {Trigger}
      <Popover
        anchorName={anchorName}
        popover='auto'
        ref={popoverRef}
        id={anchorName}
        className={className}
      >
        <PopoverContent ref={contentRef}>{isOpen && children}</PopoverContent>
      </Popover>
    </Wrapper>
  );
}

const PopoverContent = styled.div``;

CustomPopover.Content = PopoverContent;

const Wrapper = styled.div<{ anchorName: string }>`
  display: contents;

  & *[data-popover-target='${p => p.anchorName}'] {
    anchor-name: --${p => p.anchorName};
  }
`;

const Popover = styled.div<{ anchorName: string }>`
  @position-try --top-right {
    position-area: top span-right;
  }
  @position-try --top-left {
    position-area: top span-left;
  }
  @position-try --bottom-right {
    position-area: bottom span-right;
  }
  @position-try --bottom-left {
    position-area: bottom span-left;
  }

  border: none;
  background-color: ${p => transparentize(0.2, p.theme.colors.bgBody)};
  backdrop-filter: blur(10px);
  box-shadow: ${p => p.theme.boxShadowSoft};
  border-radius: ${p => p.theme.radius};
  animation: ${fadeIn} 0.1s ease-in-out;
  margin: 0;
  padding: 0;
  inset: auto;
  position: fixed;
  position-anchor: --${p => p.anchorName};
  position-area: top center;
  position-try: --top-right, --top-left, --bottom-right, --bottom-left;
  max-height: unset;
  min-width: max-content;
`;
