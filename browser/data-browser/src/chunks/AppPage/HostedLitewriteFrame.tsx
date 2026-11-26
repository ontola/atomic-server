import { useEffect, useRef, useState } from 'react';
import { styled } from 'styled-components';
import { useStore } from '@tomic/react';
import { Button } from '@tomic/ui/components/Button';
import { useSettings } from '@helpers/AppSettings';
import { hostedLitewriteStorage } from './hostedLitewriteStorage';

const PROTOCOL = 'pondersource.atomic.documents.v1';

const labels = {
  signIn: 'Sign in to Atomic to open Litewrite.',
  review: 'Litewrite can read and edit its notes in this app’s table.',
  open: 'Open hosted Litewrite',
};

export function HostedLitewriteFrame({
  app,
  drive,
  origin,
}: {
  app: string;
  drive: string;
  origin: string;
}) {
  const store = useStore();
  const agent = useSettings().agent?.subject;
  const [approvedAgent, setApprovedAgent] = useState<string>();
  const frame = useRef<HTMLIFrameElement>(null);
  const closeSession = useRef<(() => void) | undefined>(undefined);
  const src = new URL('/?embed=atomic', origin).href;

  useEffect(() => () => { closeSession.current?.(); }, [store, app, drive, src, agent]);

  function connect() {
    closeSession.current?.();
    const target = frame.current?.contentWindow;
    if (!target || !agent || agent !== approvedAgent || origin === window.location.origin) return;

    const channel = new MessageChannel();
    let live = true;
    let pending = 0;
    let tail = Promise.resolve();
    const isCurrent = () => live && store.getAgent()?.subject === agent &&
      frame.current?.contentWindow === target;
    const storage = hostedLitewriteStorage(store, app, drive, isCurrent);

    closeSession.current = () => {
      live = false;
      channel.port1.close();
    };
    channel.port1.onmessage = ({ data }) => {
      if (!isCurrent() || !data || !Number.isSafeInteger(data.id)) return;
      const { id, op, key, note } = data;
      if (pending >= 64) {
        channel.port1.postMessage({ id, error: 'Too many pending requests' });

        return;
      }
      pending++;
      // One outstanding mutation at a time in this frame, including its lookup.
      tail = tail.then(async () => {
        try {
          const result = await storage({ id, op, key, note });
          if (isCurrent()) channel.port1.postMessage({ id, result });
        } catch {
          if (isCurrent()) channel.port1.postMessage({ id, error: 'Atomic could not finish the note request.' });
        } finally {
          pending--;
        }
      });
    };
    target.postMessage({ type: PROTOCOL }, origin, [channel.port2]);
  }

  if (!agent) return <p>{labels.signIn}</p>;

  if (agent !== approvedAgent) {
    return (
      <div>
        <p>{labels.review}</p>
        <Button onClick={() => setApprovedAgent(agent)}>{labels.open}</Button>
      </div>
    );
  }

  return (
    <Frame
      ref={frame}
      src={src}
      title='Litewrite'
      referrerPolicy='origin'
      sandbox='allow-scripts allow-same-origin allow-modals'
      onLoad={connect}
    />
  );
}

const Frame = styled.iframe`
  border: 0;
  flex: 1;
  width: 100%;
`;
