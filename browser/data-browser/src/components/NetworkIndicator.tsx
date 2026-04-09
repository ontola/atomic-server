import { useEffect, useRef, useState } from 'react';
import { styled, keyframes, css } from 'styled-components';
import { MdSignalWifiOff, MdCloudOff } from 'react-icons/md';
import { useOnline } from '../hooks/useOnline';
import { lighten } from 'polished';
import toast from 'react-hot-toast';
import { StoreEvents, useStore } from '@tomic/react';

/** Tracks WebSocket connection state and whether the server was ever reached. */
function useServerConnection() {
  const store = useStore();
  const [connected, setConnected] = useState(store.serverConnected);
  const wasEverConnected = useRef(store.serverConnected);

  useEffect(() => {
    const unsub = store.on(StoreEvents.ConnectionChanged, (isConnected: boolean) => {
      setConnected(isConnected);

      if (isConnected) {
        wasEverConnected.current = true;
      }
    });

    return unsub;
  }, [store]);

  return { connected, wasEverConnected: wasEverConnected.current };
}

export function NetworkIndicator() {
  const isOnline = useOnline();
  const { connected: isWSConnected, wasEverConnected } = useServerConnection();
  const isConnected = isOnline && isWSConnected;

  const label = !isOnline
    ? 'No internet connection'
    : wasEverConnected
      ? 'Server connection lost — reconnecting…'
      : 'Running in offline mode';

  useEffect(() => {
    if (!isOnline) {
      toast.error('You are offline, changes might not be persisted.');
    }
  }, [isOnline]);

  useEffect(() => {
    if (!isWSConnected && wasEverConnected) {
      toast.error('Connection to server lost, reconnecting...');
    }
  }, [isWSConnected, wasEverConnected]);

  const Icon = wasEverConnected ? MdSignalWifiOff : MdCloudOff;

  return (
    <Wrapper shown={!isConnected} $neverConnected={!wasEverConnected} aria-hidden={isConnected} aria-label={label}>
      <Icon aria-hidden />
      <Label>{label}</Label>
    </Wrapper>
  );
}

interface WrapperProps {
  shown: boolean;
}

const pulse = keyframes`
  0% {
    opacity: 1;
    filter: drop-shadow(0 0 5px var(--shadow-color));
  }
  100% {
    opacity: 0.8;
    filter: drop-shadow(0 0 0 var(--shadow-color));
  }
`;

const Label = styled.span`
  font-size: 0.8rem;
  font-weight: 500;
  white-space: nowrap;
  max-width: 0;
  overflow: hidden;
  opacity: 0;
  transition:
    max-width 0.25s ease,
    opacity 0.2s ease,
    margin 0.25s ease;
  margin-left: 0;
`;

interface WrapperAllProps extends WrapperProps {
  $neverConnected?: boolean;
}

const Wrapper = styled.div<WrapperAllProps>`
  --shadow-color: ${p => lighten(0.15, p.$neverConnected ? p.theme.colors.textLight : p.theme.colors.alert)};
  position: fixed;
  bottom: 1.2rem;
  right: 2rem;
  z-index: ${({ theme }) => theme.zIndex.networkIndicator};
  font-size: 1.5rem;
  color: ${p => p.$neverConnected ? p.theme.colors.textLight : p.theme.colors.alert};
  pointer-events: ${p => (p.shown ? 'auto' : 'none')};
  transition:
    opacity 0.1s ease-in-out,
    border-radius 0.25s ease,
    padding 0.25s ease;
  opacity: ${p => (p.shown ? 1 : 0)};

  background-color: ${p => p.theme.colors.bg};
  border: 1px solid ${p => p.$neverConnected ? p.theme.colors.bg2 : p.theme.colors.alert};
  border-radius: 2rem;
  display: flex;
  align-items: center;
  box-shadow: ${p => p.theme.boxShadowSoft};
  padding: 0.5rem;
  cursor: default;

  svg {
    flex-shrink: 0;
    animation: ${p => p.$neverConnected ? 'none' : css`${pulse} 1.5s alternate ease-in-out infinite`};
    animation-play-state: ${p => (p.shown ? 'running' : 'paused')};
  }

  &:hover ${Label}, &:focus-within ${Label} {
    max-width: 16rem;
    opacity: 1;
    margin-left: 0.5rem;
  }
`;
