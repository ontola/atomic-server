import { styled } from 'styled-components';
import { useEffect, useEffectEvent, useRef } from 'react';
import { ScrollArea } from '@components/ScrollArea';
import { Column } from '@components/Row';

/** How close to the bottom (px) still counts as "stuck to the bottom". */
const BOTTOM_THRESHOLD_PX = 48;

interface ChatMessagesContainerProps {
  enableAutoScroll?: boolean;
  /** When this value changes, scroll the compact separator (or bottom) into view. */
  scrollToCompactTrigger?: number;
  fullView?: boolean;
}

export const ChatMessagesContainer: React.FC<
  React.PropsWithChildren<ChatMessagesContainerProps>
> = ({ children, enableAutoScroll, scrollToCompactTrigger, fullView }) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the view is "stuck" to the bottom. The user detaches by scrolling
  // up while a message streams in, and re-attaches by scrolling back down.
  const stuckToBottomRef = useRef(true);
  // Read inside the (mount-only) observer without re-subscribing each render.
  const enableAutoScrollRef = useRef(enableAutoScroll);
  enableAutoScrollRef.current = enableAutoScroll;
  // Last observed scrollTop, used to detect scroll direction.
  const lastScrollTopRef = useRef(0);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
  };

  const isNearBottom = () => {
    const el = scrollRef.current;

    if (!el) return true;

    return (
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX
    );
  };

  const scrollToCompactSeparator = useEffectEvent(() => {
    const separators = containerRef.current?.querySelectorAll(
      '[data-compact-separator]',
    );
    const separator =
      separators && separators.length > 0
        ? separators[separators.length - 1]
        : null;

    if (separator) {
      separator.scrollIntoView({ behavior: 'instant', block: 'center' });

      return;
    }

    scrollToBottom();
  });

  useEffect(() => {
    if (scrollToCompactTrigger === undefined || scrollToCompactTrigger === 0) {
      return;
    }

    scrollToCompactSeparator();
  }, [scrollToCompactTrigger]);

  useEffect(() => {
    // Initial scroll to bottom when component mounts.
    scrollToBottom();

    const scroller = scrollRef.current;

    // Any upward scroll detaches immediately (so a slow trackpad scroll works
    // even while tokens keep streaming in); reaching the bottom re-attaches.
    const handleScroll = () => {
      const el = scrollRef.current;

      if (!el) return;

      const top = el.scrollTop;

      if (top < lastScrollTopRef.current - 1) {
        stuckToBottomRef.current = false;
      } else if (isNearBottom()) {
        stuckToBottomRef.current = true;
      }

      lastScrollTopRef.current = top;
    };

    scroller?.addEventListener('scroll', handleScroll, { passive: true });

    let observer: MutationObserver | undefined;

    if (containerRef.current) {
      // Detect when new messages (or streamed tokens) are added.
      observer = new MutationObserver(mutations => {
        if (!enableAutoScrollRef.current) return;
        // Don't yank the user back down if they scrolled up to read.
        if (!stuckToBottomRef.current) return;

        const hasContentChanges = mutations.some(
          mutation =>
            mutation.type === 'childList' || mutation.type === 'characterData',
        );

        if (hasContentChanges) {
          scrollToBottom();
        }
      });

      observer.observe(containerRef.current, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['style', 'class'],
      });
    }

    return () => {
      scroller?.removeEventListener('scroll', handleScroll);
      observer?.disconnect();
    };
  }, []);

  return (
    <MessagesContainer ref={scrollRef} $fullView={fullView}>
      <Column ref={containerRef}>
        {children}
        <div ref={messagesEndRef} />
      </Column>
    </MessagesContainer>
  );
};

const MessagesContainer = styled(ScrollArea)<{ $fullView?: boolean }>`
  overflow: auto;
  height: 100%;
  background-color: ${p => p.theme.colors.bgBody};
  border-radius: ${p => p.theme.radius};
  padding: ${p => (p.$fullView ? '0' : p.theme.size())};
`;
