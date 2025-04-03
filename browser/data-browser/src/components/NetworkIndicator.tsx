import { useEffect, useState } from 'react';
import { styled, keyframes } from 'styled-components';
import { MdSignalWifiOff } from 'react-icons/md';
import { useOnline } from '../hooks/useOnline';
import { lighten } from 'polished';
import toast from 'react-hot-toast';
import { useStore } from '@tomic/react';

/** Returns false when the WebSocket has definitively closed (server unreachable). */
function useWebSocketConnected(): boolean {
  const store = useStore();
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      const ws = store.getDefaultWebSocket();
      // CLOSED means the connection failed or dropped — CONNECTING means still trying
      setConnected(ws?.readyState !== WebSocket.CLOSED);
    }, 1000);

    return () => clearInterval(interval);
  }, [store]);

  return connected;
}

export function NetworkIndicator() {
  const isOnline = useOnline();
  const isWSConnected = useWebSocketConnected();
  const isConnected = isOnline && isWSConnected;

  const label = !isOnline
    ? 'No internet connection'
    : 'Server connection lost — reconnecting…';

  useEffect(() => {
    if (!isOnline) {
      toast.error('You are offline, changes might not be persisted.');
    }
  }, [isOnline]);

  useEffect(() => {
    if (!isWSConnected) {
      toast.error('Connection to server lost, reconnecting...');
    }
  }, [isWSConnected]);

  return (
    <Wrapper shown={!isConnected} aria-hidden={isConnected} aria-label={label}>
      <MdSignalWifiOff aria-hidden />
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

const Wrapper = styled.div<WrapperProps>`
  --shadow-color: ${p => lighten(0.15, p.theme.colors.alert)};
  position: fixed;
  bottom: 1.2rem;
  right: 2rem;
  z-index: ${({ theme }) => theme.zIndex.networkIndicator};
  font-size: 1.5rem;
  color: ${p => p.theme.colors.alert};
  pointer-events: ${p => (p.shown ? 'auto' : 'none')};
  transition: opacity 0.1s ease-in-out, border-radius 0.25s ease, padding 0.25s ease;
  opacity: ${p => (p.shown ? 1 : 0)};

  background-color: ${p => p.theme.colors.bg};
  border: 1px solid ${p => p.theme.colors.alert};
  border-radius: 2rem;
  display: flex;
  align-items: center;
  box-shadow: ${p => p.theme.boxShadowSoft};
  padding: 0.5rem;
  cursor: default;

  svg {
    flex-shrink: 0;
    animation: ${pulse} 1.5s alternate ease-in-out infinite;
    animation-play-state: ${p => (p.shown ? 'running' : 'paused')};
  }

  &:hover ${Label}, &:focus-within ${Label} {
    max-width: 16rem;
    opacity: 1;
    margin-left: 0.5rem;
  }
`;
