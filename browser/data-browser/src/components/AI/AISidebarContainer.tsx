import React, { Suspense } from 'react';
import { styled } from 'styled-components';
import { useAISidebar } from './AISidebarContext';
import { ChatLoadingIndicator } from './ChatLoadingIndicator';

const AISidebar = React.lazy(() => import('@chunks/AI/AISidebar'));

export const AISidebarContainer: React.FC = () => {
  const { isOpen } = useAISidebar();

  return (
    <SidebarContainer data-open={isOpen ? '' : undefined}>
      <Suspense fallback={<ChatLoadingIndicator />}>
        {isOpen && <AISidebar />}
      </Suspense>
    </SidebarContainer>
  );
};

const SidebarContainer = styled.div`
  background-color: ${p => p.theme.colors.bg};
  display: none;
  transform: translateX(30rem);
  width: min(30rem, 100vw);
  overflow: hidden;
  border-left: 1px solid ${p => p.theme.colors.bg2};
  padding: ${p => p.theme.size()};
  padding-top: 2px;
  transition:
    display 100ms allow-discrete,
    transform 100ms ease-in-out;

  &[data-open] {
    transform: translateX(0rem);
    display: block;
  }

  @starting-style {
    transform: translateX(30rem);
    display: none;
  }
`;
