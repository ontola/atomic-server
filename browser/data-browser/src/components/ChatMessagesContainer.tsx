import { styled } from 'styled-components';
import { useEffect, useEffectEvent, useRef } from 'react';
import { ScrollArea, ScrollViewPort } from '@components/ScrollArea';
import { Column } from '@components/Row';

/** How close to the bottom (px) still counts as "stuck to the bottom". */
const BOTTOM_THRESHOLD_PX = 48;

interface ChatMessagesContainerProps {
  enableAutoScroll?: boolean;
  /** When this value changes, scroll the compact separator (or bottom) into view. */
  scrollToCompactTrigger?: number;
  /** When this value changes, force-scroll to the bottom and re-attach, e.g. after the user sends a message. */
  scrollToBottomTrigger?: number;
  fullView?: boolean;
}

export const ChatMessagesContainer: React.FC<
  React.PropsWithChildren<ChatMessagesContainerProps>
> = ({
  children,
  enableAutoScroll,
  scrollToCompactTrigger,
  scrollToBottomTrigger,
  fullView,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the view is "stuck" to the bottom. The user detaches by scrolling
  // up while a message streams in, and re-attaches by scrolling back down.
  const stuckToBottomRef = useRef(true);
  // Read inside the (mount-only) observer without re-subscribing each render.
  const enableAutoScrollRef = useRef(enableAutoScroll);
  enableAutoScrollRef.current = enableAutoScroll;
  // Last observed scrollHeight: an upward move while the content shrank is
  // the browser clamping, not the reader.
  const lastScrollHeightRef = useRef(0);
  const lastClientHeightRef = useRef(0);
  // Last observed scrollTop, used to detect scroll direction.
  const lastScrollTopRef = useRef(0);

  const scrollToBottom = () => {
    const scroller = scrollRef.current;

    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  };

  // New messages glide the list down instead of jumping, unless the reader
  // asked for less motion.
  const glideToBottom = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const reduced = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: reduced ? 'auto' : 'smooth',
    });
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
    if (scrollToBottomTrigger === undefined || scrollToBottomTrigger === 0) {
      return;
    }

    stuckToBottomRef.current = true;
    scrollToBottom();
  }, [scrollToBottomTrigger]);

  useEffect(() => {
    // Initial scroll to bottom when component mounts.
    scrollToBottom();

    const scroller = scrollRef.current;

    // Start from the real sizes. From zero, the first scroll looked like the
    // viewport had grown, so a reader's first scroll up never detached.
    if (scroller) {
      lastScrollHeightRef.current = scroller.scrollHeight;
      lastClientHeightRef.current = scroller.clientHeight;
      lastScrollTopRef.current = scroller.scrollTop;
    }

    // Any upward scroll detaches immediately (so a slow trackpad scroll works
    // even while tokens keep streaming in); reaching the bottom re-attaches.
    const handleScroll = () => {
      const el = scrollRef.current;

      if (!el) return;

      const top = el.scrollTop;
      const height = el.scrollHeight;
      const viewport = el.clientHeight;
      // The browser also lowers scrollTop by itself when the content gets
      // shorter, or the viewport taller: the "Mara is typing…" line under
      // the list comes and goes with every message. That is not the reader
      // scrolling up, and treating it as one detached the chat for good: it
      // stopped following new messages although nobody had touched it.
      const clamped =
        height < lastScrollHeightRef.current ||
        viewport > lastClientHeightRef.current;

      if (top < lastScrollTopRef.current - 1 && !clamped) {
        stuckToBottomRef.current = false;
      } else if (isNearBottom()) {
        stuckToBottomRef.current = true;
      }

      lastScrollTopRef.current = top;
      lastScrollHeightRef.current = height;
      lastClientHeightRef.current = viewport;
    };

    scroller?.addEventListener('scroll', handleScroll, { passive: true });

    // Opening the keyboard shrinks the message viewport without adding any
    // messages. Keep the last line visible when already following the bottom;
    // leave the reading position alone when the user has scrolled up.
    // The content growing without a DOM change in this list (a message whose
    // preview or image finishes loading) is observed here too.
    const resizeObserver = new ResizeObserver(() => {
      if (stuckToBottomRef.current) scrollToBottom();
      const el = scrollRef.current;

      // A shrinking viewport fires no scroll event, so note it here; the
      // scroll event of a later growth then compares against this size.
      if (el && el.clientHeight < lastClientHeightRef.current) {
        lastClientHeightRef.current = el.clientHeight;
      }
    });
    if (scroller) resizeObserver.observe(scroller);
    if (containerRef.current) resizeObserver.observe(containerRef.current);

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
          glideToBottom();
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
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <MessagesContainer ref={scrollRef} $fullView={fullView}>
      <Column ref={containerRef}>{children}</Column>
    </MessagesContainer>
  );
};

/**
 * Transparent: the backdrop color comes from the surrounding surface (the
 * right panel or the full-page chat window), so chats look the same
 * everywhere instead of rendering as an inset box.
 */
const MessagesContainer = styled(ScrollArea)<{ $fullView?: boolean }>`
  overflow: auto;
  min-height: 0;
  height: 100%;
  padding: ${p => (p.$fullView ? '0.25rem 0' : p.theme.size())};

  @media (max-width: 600px) {
    padding: 0.25rem 0;
  }

  /* The viewport is what scrolls and therefore what clips, so the room for an
   * avatar's keyboard focus ring (2px + 2px offset) has to live here —
   * padding on the ScrollArea root sits outside the clip and does nothing.
   * Start only: message chips still bleed into the panel's right padding. */
  ${ScrollViewPort} {
    padding-inline-start: 4px;
  }
`;
