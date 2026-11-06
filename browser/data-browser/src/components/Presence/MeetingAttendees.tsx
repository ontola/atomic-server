import { styled } from 'styled-components';
import { PresenceAvatarMenu } from './PresenceAvatarMenu';
import { useMeetingParticipants } from './useMeetingParticipants';

const MAX_SHOWN = 5;

/** Who is in the meeting `subject` right now, as a small facepile. Nothing
 *  while nobody is. */
export function MeetingAttendees({
  subject,
}: {
  subject: string;
}): React.JSX.Element | null {
  const { participants } = useMeetingParticipants(subject);

  if (participants.length === 0) return null;

  return (
    <Facepile title={`${participants.length} here`}>
      {participants.slice(0, MAX_SHOWN).map(agent => (
        <PresenceAvatarMenu key={agent} agentSubject={agent} size='1.5rem' />
      ))}
      {participants.length > MAX_SHOWN && (
        <Overflow>+{participants.length - MAX_SHOWN}</Overflow>
      )}
    </Facepile>
  );
}

const Facepile = styled.span`
  display: inline-flex;
  align-items: center;

  & > *:not(:first-child) {
    margin-left: -0.4rem;
  }
`;

const Overflow = styled.span`
  margin-left: 0.15rem;
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;
