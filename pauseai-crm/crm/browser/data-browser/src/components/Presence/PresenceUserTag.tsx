import { styled } from 'styled-components';
import { useResource, useTitle } from '@tomic/react';
import { colorForAgent } from './AgentAvatar';

interface PresenceUserTagProps {
  agentSubject: string;
  className?: string;
}

/**
 * Small name pill in the agent's deterministic presence color. Shared by
 * the view-specific presence indicators (canvas pointer cursors, table
 * cell selections) so a user is labelled identically everywhere.
 */
export function PresenceUserTag({
  agentSubject,
  className,
}: PresenceUserTagProps): React.JSX.Element {
  const agentResource = useResource(agentSubject);
  const [name] = useTitle(agentResource);

  return (
    <Tag className={className} $color={colorForAgent(agentSubject)}>
      {name}
    </Tag>
  );
}

const Tag = styled.span<{ $color: string }>`
  display: inline-block;
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background-color: ${p => p.$color};
  /* Presence palette colors are all light — dark text works in both themes. */
  color: #333;
  font-size: 0.7rem;
  font-weight: 600;
  line-height: 1;
  padding: 0.15rem 0.35rem;
  border-radius: 0.5rem;
  user-select: none;
  pointer-events: none;
`;
