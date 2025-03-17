import styled from 'styled-components';
import { useEffect, useRef } from 'react';
import { ScrollArea } from '../ScrollArea';
import { Column } from '../Row';

interface ChatMessagesContainerProps {
  enableAutoScroll?: boolean;
}

export const ChatMessagesContainer: React.FC<
  React.PropsWithChildren<ChatMessagesContainerProps>
> = ({ children, enableAutoScroll }) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

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
    <MessagesContainer>
      <Column ref={containerRef}>
        {children}
        <div ref={messagesEndRef} />
      </Column>
    </MessagesContainer>
  );
};

const MessagesContainer = styled(ScrollArea)`
  overflow: auto;
  height: 100%;
  padding: ${p => p.theme.size()};
  background-color: ${p => p.theme.colors.bgBody};
  border-radius: ${p => p.theme.radius};
`;
