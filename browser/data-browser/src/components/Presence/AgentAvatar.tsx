import { styled } from 'styled-components';
import {
  useResource,
  useString,
  useSubject,
  useTitle,
  useFileObjectUrl,
  dataBrowser,
  server,
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
  /** Show a green "online" dot (agent has a live presence entry). */
  online?: boolean;
}

/**
 * Round avatar for an agent: their profile picture if they set one, otherwise
 * their initial on a per-agent deterministic color. Pass `online` to overlay a
 * green presence dot.
 *
 * The picture is the `icon` File — the same property the profile editor writes
 * and every other surface reads through `ResourceGlyph`, so one upload shows up
 * everywhere. `image`/`imageUrl` are the older properties, still honoured for
 * agents that carry them.
 */
export function AgentAvatar({
  agentSubject,
  size = '1.6rem',
  online = false,
}: AgentAvatarProps): React.JSX.Element {
  const agentResource = useResource(agentSubject);
  const [name] = useTitle(agentResource);
  const [iconFile] = useSubject(agentResource, dataBrowser.properties.icon);
  const [imageFile] = useString(agentResource, dataBrowser.properties.image);
  const [imageUrl] = useString(agentResource, dataBrowser.properties.imageUrl);

  // The icon File resolves to a local blob when the bytes are already here
  // (fresh upload, offline) and to the server download URL otherwise.
  const iconResource = useResource(iconFile);
  const [iconDownloadUrl] = useString(
    iconResource,
    server.properties.downloadUrl,
  );
  const localIconUrl = useFileObjectUrl(iconResource);
  const iconSrc = iconFile ? (localIconUrl ?? iconDownloadUrl) : undefined;

  let circle: React.JSX.Element;

  if (iconSrc) {
    circle = (
      <ImageCircle $size={size} title={name}>
        <img src={iconSrc} alt={name} />
      </ImageCircle>
    );
  } else if (imageFile) {
    circle = (
      <ImageCircle $size={size} title={name}>
        <Image subject={imageFile} alt={name} sizeIndication='2rem' />
      </ImageCircle>
    );
  } else if (imageUrl) {
    circle = (
      <ImageCircle $size={size} title={name}>
        <img src={imageUrl} alt={name} />
      </ImageCircle>
    );
  } else {
    circle = (
      <InitialCircle
        $size={size}
        $color={colorForAgent(agentSubject)}
        title={name}
      >
        {name.charAt(0).toUpperCase()}
      </InitialCircle>
    );
  }

  if (!online) {
    return circle;
  }

  return (
    <AvatarWithStatus>
      {circle}
      <OnlineDot $size={size} title={`${name} is online`} />
    </AvatarWithStatus>
  );
}

const AvatarWithStatus = styled.span`
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
`;

const OnlineDot = styled.span<{ $size: string }>`
  position: absolute;
  right: 0;
  bottom: 0;
  width: calc(${p => p.$size} / 3);
  height: calc(${p => p.$size} / 3);
  min-width: 0.5rem;
  min-height: 0.5rem;
  border-radius: 50%;
  background: #34c759;
  border: 2px solid ${p => p.theme.colors.bg};
  box-sizing: border-box;
`;

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
