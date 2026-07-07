import { styled } from 'styled-components';
import {
  useResource,
  useString,
  useTitle,
  dataBrowser,
  Image,
} from '@tomic/react';
/** Same palette as the collaborative editor's cursors, but picked
 *  deterministically per agent so a user keeps their color across
 *  sessions and surfaces. */
const AVATAR_COLORS = ['#70d6ff', '#ff70a6', '#ff9770', '#ffd670', '#e9ff70'];

export function colorForAgent(agentSubject: string): string {
  let hash = 0;

  for (let i = 0; i < agentSubject.length; i++) {
    hash = (hash * 31 + agentSubject.charCodeAt(i)) | 0;
  }

  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

interface AgentAvatarProps {
  agentSubject: string;
  /** Diameter, any CSS size. Defaults to 1.6rem (navbar facepile). */
  size?: string;
}

/**
 * Round avatar for an agent: their profile image if they set one (the
 * `image` File property, or an external `imageUrl`), otherwise their
 * initial on a per-agent deterministic color.
 */
export function AgentAvatar({
  agentSubject,
  size = '1.6rem',
}: AgentAvatarProps): React.JSX.Element {
  const agentResource = useResource(agentSubject);
  const [name] = useTitle(agentResource);
  const [imageFile] = useString(
    agentResource,
    dataBrowser.properties.image,
  );
  const [imageUrl] = useString(
    agentResource,
    dataBrowser.properties.imageUrl,
  );

  if (imageFile) {
    return (
      <ImageCircle $size={size} title={name}>
        <Image subject={imageFile} alt={name} sizeIndication='2rem' />
      </ImageCircle>
    );
  }

  if (imageUrl) {
    return (
      <ImageCircle $size={size} title={name}>
        <img src={imageUrl} alt={name} />
      </ImageCircle>
    );
  }

  return (
    <InitialCircle $size={size} $color={colorForAgent(agentSubject)} title={name}>
      {name.charAt(0).toUpperCase()}
    </InitialCircle>
  );
}

const CircleBase = styled.div<{ $size: string }>`
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: ${p => p.$size};
  height: ${p => p.$size};
  border-radius: 50%;
  border: 2px solid ${p => p.theme.colors.bg};
  overflow: hidden;
  user-select: none;
`;

const ImageCircle = styled(CircleBase)`
  background-color: ${p => p.theme.colors.bg2};

  & img,
  & picture {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
`;

const InitialCircle = styled(CircleBase)<{ $color: string }>`
  background-color: ${p => p.$color};
  color: #333;
  /* Scale the initial with the circle */
  font-size: calc(${p => p.$size} / 2);
  font-weight: bold;
`;
