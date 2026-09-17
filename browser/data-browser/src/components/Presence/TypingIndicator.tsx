import { styled, keyframes } from 'styled-components';
import { useResource, useTitle, type PresenceItem } from '@tomic/react';
import { AgentAvatar } from './AgentAvatar';

interface TypingIndicatorProps {
  /** Other sessions typing in this thread — from {@link useTypingPresence}. */
  typers: PresenceItem[];
}

/**
 * "X is typing…" row for a chat/comment composer. Renders a small facepile of
 * whoever is currently typing in the same thread plus a live-updating label and
 * animated dots. Renders nothing when nobody is typing, so it can sit
 * unconditionally above a composer and simply appear/disappear.
 */
export function TypingIndicator({
  typers,
}: TypingIndicatorProps): React.JSX.Element | null {
  if (typers.length === 0) {
    return null;
  }

  return (
    <Wrapper aria-live='polite'>
      <Facepile>
        {typers.slice(0, 3).map(t => (
          <AgentAvatar key={t.sessionId} agentSubject={t.agent} size='1.4rem' />
        ))}
      </Facepile>
      <Label>
        <TypingText typers={typers} />
        <Dots aria-hidden>
          <i />
          <i />
          <i />
        </Dots>
      </Label>
    </Wrapper>
  );
}

/** The sentence, resolving up to two names and collapsing the rest. */
function TypingText({ typers }: TypingIndicatorProps): React.JSX.Element {
  if (typers.length === 1) {
    return (
      <>
        <Name subject={typers[0].agent} /> is typing
      </>
    );
  }

  if (typers.length === 2) {
    return (
      <>
        <Name subject={typers[0].agent} /> and{' '}
        <Name subject={typers[1].agent} /> are typing
      </>
    );
  }

  return (
    <>
      <Name subject={typers[0].agent} /> and {typers.length - 1} others are
      typing
    </>
  );
}

function Name({ subject }: { subject: string }): React.JSX.Element {
  const resource = useResource(subject);
  const [title] = useTitle(resource);

  return <strong>{title}</strong>;
}

const Wrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.15rem ${p => p.theme.size(2)};
  min-height: 1.4rem;
  color: ${p => p.theme.colors.textLight};
  font-size: 0.8rem;
`;

const Facepile = styled.span`
  display: inline-flex;
  align-items: center;

  & > *:not(:first-child) {
    margin-left: -0.5rem;
  }
`;

const Label = styled.span`
  display: inline-flex;
  align-items: baseline;
  gap: 0.15rem;

  strong {
    font-weight: 600;
    color: ${p => p.theme.colors.text};
  }
`;

const blink = keyframes`
  0%, 80%, 100% { opacity: 0.2; }
  40% { opacity: 1; }
`;

const Dots = styled.span`
  display: inline-flex;
  gap: 0.1rem;
  align-self: center;

  & > i {
    width: 0.2rem;
    height: 0.2rem;
    border-radius: 50%;
    background: currentColor;
    animation: ${blink} 1.4s ease-in-out infinite both;
  }

  & > i:nth-child(2) {
    animation-delay: 0.2s;
  }

  & > i:nth-child(3) {
    animation-delay: 0.4s;
  }

  @media (prefers-reduced-motion: reduce) {
    & > i {
      animation: none;
      opacity: 0.6;
    }
  }
`;
