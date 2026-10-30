import { lazy, Suspense, useEffect, useState } from 'react';
import { useStore } from '@tomic/react';
import { styled } from 'styled-components';
import { adoptDriveOf } from './embedStore';
import { leaveCall } from './hostActions';

const ConferenceRoom = lazy(
  () => import('../chunks/Conference/ConferenceRoom'),
);

/**
 * The call page (`embed.html?call=<meeting>`): only the meeting's audio/video
 * call, kept by the app in its own web view so it survives the app moving
 * the resource page around. Same `ConferenceRoom` as the web, so the peers
 * and signaling are one implementation; Leave tells the app to end the call.
 */
export function CallPage({ meeting }: { meeting: string }): React.JSX.Element {
  const store = useStore();
  // The drive first, like a resource page: avatars and names of the peers
  // are read from it.
  const [ready, setReady] = useState(false);
  const compact = useCompact();

  useEffect(() => {
    let live = true;

    void adoptDriveOf(store, meeting).then(() => {
      if (live) setReady(true);
    });

    return () => {
      live = false;
    };
  }, [store, meeting]);

  return (
    <Page data-testid='call-page'>
      {ready && (
        <Suspense fallback={null}>
          <ConferenceRoom
            subject={meeting}
            onLeave={leaveCall}
            compact={compact}
          />
        </Suspense>
      )}
    </Page>
  );
}

/** The app shows the call in a small floating tile (about 110 px wide) or
 *  expanded; the page follows its width. */
const COMPACT_MAX_WIDTH = 240;

function useCompact(): boolean {
  const [compact, setCompact] = useState(
    () => window.innerWidth <= COMPACT_MAX_WIDTH,
  );

  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth <= COMPACT_MAX_WIDTH);

    window.addEventListener('resize', onResize);

    return () => window.removeEventListener('resize', onResize);
  }, []);

  return compact;
}

const Page = styled.div`
  box-sizing: border-box;
  min-height: 100dvh;
  padding: ${p => p.theme.size(2)};
  background: ${p => p.theme.colors.bgBody};

  /* The room fills the app's tile instead of the panel it was made for. */
  & > div {
    margin: 0;
    border: none;
  }
`;
