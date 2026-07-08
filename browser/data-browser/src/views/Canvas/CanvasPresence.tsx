import { useCallback, useEffect, useRef } from 'react';
import { styled } from 'styled-components';
import { useResourcePresence, type PresenceItem } from '@tomic/react';
import { colorForAgent } from '@components/Presence/AgentAvatar';
import { PresenceUserTag } from '@components/Presence/PresenceUserTag';

/** What a canvas session shares about its pointer: world coordinates,
 *  mapped through each receiver's own zoom/pan. */
export interface CanvasPresenceData {
  x: number;
  y: number;
}

/** Trailing throttle for pointer broadcasts. Presence rides the drive's
 *  websocket channel; a pointer sweep should cost a handful of frames per
 *  second, not one per pointermove. */
const POINTER_BROADCAST_MS = 80;

interface CanvasPresence {
  /** Remote sessions with a live pointer on this canvas. */
  cursors: PresenceItem<CanvasPresenceData>[];
  /** Announce our pointer at world (x, y). Throttled. */
  broadcastPointer: (x: number, y: number) => void;
  /** Retract our pointer (left the canvas / unmount). */
  clearPointer: () => void;
}

/**
 * Live pointer presence for one canvas, on the drive presence channel
 * (`PresenceEntry.data`). One hook instance per canvas page; hand
 * `cursors` to {@link RemoteCursors}.
 */
export function useCanvasPresence(subject: string): CanvasPresence {
  const { presence, setData } =
    useResourcePresence<CanvasPresenceData>(subject);

  const lastSentAtRef = useRef(0);
  const trailingRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const broadcastPointer = useCallback(
    (x: number, y: number) => {
      const send = () => {
        lastSentAtRef.current = Date.now();
        setData({ x, y });
      };

      clearTimeout(trailingRef.current);
      const elapsed = Date.now() - lastSentAtRef.current;

      if (elapsed >= POINTER_BROADCAST_MS) {
        send();
      } else {
        // Trailing send so the final resting position always lands.
        trailingRef.current = setTimeout(send, POINTER_BROADCAST_MS - elapsed);
      }
    },
    [setData],
  );

  const clearPointer = useCallback(() => {
    clearTimeout(trailingRef.current);
    setData(undefined);
  }, [setData]);

  // Cancel a pending trailing send on unmount — it would otherwise
  // re-announce a pointer on a canvas we just left.
  useEffect(() => clearPointer, [clearPointer]);

  // A cleared payload travels as `null` (undefined doesn't survive the
  // wire encoding), so validate the shape instead of just presence.
  const cursors = presence.filter(
    item => typeof item.data?.x === 'number' && typeof item.data.y === 'number',
  );

  return { cursors, broadcastPointer, clearPointer };
}

interface RemoteCursorsProps {
  cursors: PresenceItem<CanvasPresenceData>[];
  scale: number;
  offset: { x: number; y: number };
}

/**
 * Other sessions' pointers, drawn over the canvas: a dot + name tag in
 * each agent's presence color. Positioned by mapping their world
 * coordinates through OUR viewport transform, so everyone sees cursors
 * at the true spot on the drawing regardless of individual zoom/pan.
 */
export function RemoteCursors({
  cursors,
  scale,
  offset,
}: RemoteCursorsProps): React.JSX.Element {
  return (
    <>
      {cursors.map(cursor => (
        <RemoteCursor
          key={cursor.sessionId}
          $color={colorForAgent(cursor.agent)}
          style={{
            transform: `translate(${cursor.data!.x * scale + offset.x}px, ${
              cursor.data!.y * scale + offset.y
            }px)`,
          }}
        >
          <PresenceUserTag agentSubject={cursor.agent} />
        </RemoteCursor>
      ))}
    </>
  );
}

const RemoteCursor = styled.div<{ $color: string }>`
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 1;
  /* Smooth out the throttled updates into continuous motion. */
  transition: transform ${POINTER_BROADCAST_MS + 40}ms linear;

  /* The pointer dot; the name tag hangs off its bottom-right. */
  &::before {
    content: '';
    display: block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background-color: ${p => p.$color};
    border: 2px solid ${p => p.theme.colors.bg};
    transform: translate(-50%, -50%);
  }

  & > * {
    position: absolute;
    top: 6px;
    left: 6px;
  }
`;
