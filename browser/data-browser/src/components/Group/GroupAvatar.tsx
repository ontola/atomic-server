import { FaUserGroup } from 'react-icons/fa6';
import { styled } from 'styled-components';

/** Round stand-in for an avatar, so a Group lines up with the Agents around it. */
export function GroupAvatar({ size = '2.6rem' }: { size?: string }) {
  return (
    <Circle $size={size} aria-hidden>
      <FaUserGroup />
    </Circle>
  );
}

const Circle = styled.span<{ $size: string }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: ${p => p.$size};
  height: ${p => p.$size};
  border-radius: 50%;
  background: ${p => p.theme.colors.bg1};
  color: ${p => p.theme.colors.main};
  font-size: calc(${p => p.$size} * 0.42);
`;
