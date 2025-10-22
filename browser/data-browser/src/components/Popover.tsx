import {
  createContext,
  createRef,
  FC,
  PropsWithChildren,
  ReactNode,
  RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type JSX,
} from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { styled, keyframes } from 'styled-components';
import { transparentize } from 'polished';
import { useDialogTreeInfo } from './Dialog/dialogContext';
import { useControlLock } from '../hooks/useControlLock';
import { EventManager } from '@helpers/EventManager';

type PopoverEvents = {
  interactionOutside: () => void;
};

export interface PopoverProps {
  Trigger: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
  noArrow?: boolean;
  noLock?: boolean;
  modal?: boolean;
  side?: 'top' | 'bottom' | 'left' | 'right';
}

export function Popover({
  children,
  className,
  open,
  defaultOpen,
  noArrow,
  noLock,
  modal,
  onOpenChange,
  Trigger,
  side = 'bottom',
}: PropsWithChildren<PopoverProps>): JSX.Element {
  const eventManagerRef = useRef(
    new EventManager<keyof PopoverEvents, PopoverEvents>(),
  );

  const { setHasOpenInnerPopup } = useDialogTreeInfo();
  const containerRef = useContext(PopoverContainerContext);

  const container = containerRef.current ?? undefined;

  useControlLock(!noLock && !!open);

  const handleOpenChange = useCallback(
    (changedToOpen: boolean) => {
      setHasOpenInnerPopup(changedToOpen);
      onOpenChange(changedToOpen);
    },
    [onOpenChange, setHasOpenInnerPopup],
  );

  useEffect(() => {
    setHasOpenInnerPopup(!!open);
  }, [open, setHasOpenInnerPopup]);

  return (
    <PopoverEventContext value={eventManagerRef.current}>
      <RadixPopover.Root
        modal={modal}
        open={open}
        onOpenChange={handleOpenChange}
        defaultOpen={defaultOpen}
      >
        {Trigger}
        <RadixPopover.Portal container={container}>
          <Content
            collisionPadding={10}
            sticky='always'
            className={className}
            side={side}
            onInteractOutside={() =>
              eventManagerRef.current.emit('interactionOutside')
            }
          >
            {children}
            {!noArrow && <Arrow />}
          </Content>
        </RadixPopover.Portal>
      </RadixPopover.Root>
    </PopoverEventContext>
  );
}

const fadeIn = keyframes`
  from {
    opacity: 0;
    transform: scale(0);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
`;

const Content = styled(RadixPopover.Content)`
  --popover-close-offset: ${p => p.theme.size()};
  --popover-close-size: 25px;
  --popover-close-safe-area: calc(
    var(--popover-close-size) + (var(--popover-close-offset) * 2) -
      ${p => p.theme.size()}
  );
  background-color: ${p => transparentize(0.2, p.theme.colors.bgBody)};
  backdrop-filter: blur(10px);
  box-shadow: ${p => p.theme.boxShadowSoft};
  border-radius: ${p => p.theme.radius};
  z-index: 10000000;
  animation: ${fadeIn} 0.1s ease-in-out;

  &[data-state='closed'] {
    animation: ${fadeIn} 0.1s ease-in-out reverse;
  }
`;

const Arrow = styled(RadixPopover.Arrow)`
  fill: ${p => p.theme.colors.bg2};
`;

const PopoverContainerContext =
  createContext<RefObject<HTMLDivElement | null>>(createRef());

export const usePopoverContainer = () => {
  return useContext(PopoverContainerContext);
};

export const PopoverContainer: FC<PropsWithChildren> = ({ children }) => {
  const popoverContainerRef = useRef<HTMLDivElement>(null);

  return (
    <ContainerDiv ref={popoverContainerRef}>
      <PopoverContainerContext value={popoverContainerRef}>
        {children}
      </PopoverContainerContext>
    </ContainerDiv>
  );
};

const ContainerDiv = styled.div`
  display: contents;
`;

const PopoverEventContext = createContext<
  EventManager<keyof PopoverEvents, PopoverEvents>
>(new EventManager<keyof PopoverEvents, PopoverEvents>());

interface UsePopoverEventsProps {
  onInteractionOutside: () => void;
}

/**
 * This hook allows children of a popover to listen to events emitted by the popover.
 */
export function usePopoverEvents({
  onInteractionOutside,
}: UsePopoverEventsProps) {
  const eventManager = useContext(PopoverEventContext);

  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    if (onInteractionOutside) {
      unsubscribers.push(
        eventManager.register('interactionOutside', onInteractionOutside),
      );
    }

    return () => {
      unsubscribers.forEach(unsubscribe => unsubscribe());
    };
  }, [eventManager, onInteractionOutside]);
}
