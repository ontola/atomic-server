import { styled } from 'styled-components';
import { SimpleAIChat } from './SimpleAIChat';
import React from 'react';
import { useAISidebar } from './AISidebarContext';

export const AISidebar: React.FC = () => {
  const { isOpen } = useAISidebar();

  return (
    <SidebarContainer data-open={isOpen ? '' : undefined}>
      <SimpleAIChat />
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
