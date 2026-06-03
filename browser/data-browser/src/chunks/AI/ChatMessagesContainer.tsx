import { styled } from 'styled-components';
import { useEffect, useEffectEvent, useRef } from 'react';
import { ScrollArea } from '@components/ScrollArea';
import { Column } from '@components/Row';

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

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
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
    // Initial scroll to bottom when component mounts
    scrollToBottom();

    if (!containerRef.current) return;

    // Set up MutationObserver to detect when new messages are added
    const observer = new MutationObserver(mutations => {
      if (!enableAutoScroll) return;

      // Check if the mutations include actual content changes that would affect layout
      const hasContentChanges = mutations.some(
        mutation =>
          mutation.type === 'childList' || mutation.type === 'characterData',
      );

      if (hasContentChanges) {
        scrollToBottom();
      }
    });

    // Observe all changes to the container's children
    observer.observe(containerRef.current, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });

    return () => {
      observer.disconnect();
    };
  }, [enableAutoScroll]);

  return (
    <MessagesContainer $fullView={fullView}>
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
